// Timeouts, retries (embeddings, rate limits with Retry-After) and context error detection.
// Ollama and OpenAI are faked, so no model is called; retry delays are shortened.
import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { installFakeOllama } from './helpers/fake-ollama.js';
import { installFakeOpenAI } from './helpers/fake-openai.js';

const fake = installFakeOllama({ dim: 8, models: [{ name: 'gemma3:4b', capabilities: ['completion'] }] });
const fakeOpenAI = installFakeOpenAI({ answer: 'OpenAI answer.' });
const llm = await import('../server/llm.js');

const TIMEOUT_VARIABLES = ['EMBED_TIMEOUT_MS', 'OPENAI_TIMEOUT_MS', 'LOCAL_CHAT_TIMEOUT_MS'];

beforeEach(() => {
  llm.setRetryDelays({ baseMs: 1, rateLimitMs: 1 });
  fake.calls.length = 0;
  fake.chatRequests.length = 0;
  fake.unreachableCalls = 0;
  fakeOpenAI.requests.length = 0;
});

afterEach(() => {
  llm.setRetryDelays();
  for (const name of TIMEOUT_VARIABLES) delete process.env[name];
  fake.hang = false;
  fake.unreachable = false;
  fake.embedErrors = [];
  fake.stallAfterFirstChunk = false;
  fake.endWithoutFinish = false;
  delete fake.chatError;
  fakeOpenAI.hang = false;
  fakeOpenAI.errors = [];
});

after(() => {
  fakeOpenAI.restore();
  fake.restore();
});

const embedCalls = () => fake.calls.filter((call) => call.url.endsWith('/api/embed'));
const apiError = (status, message, headers = {}) =>
  OpenAI.APIError.generate(status, { message }, message, new Headers(headers));

async function rejectsWithin(promise, ms, check) {
  const started = Date.now();
  await assert.rejects(promise, check);
  assert.ok(Date.now() - started < ms, `took ${Date.now() - started} ms`);
}

// --- R1: timeouts ---

test('the time limits default to 60 s (embeddings), 300 s (OpenAI) and 900 s (local) and are read from .env', () => {
  const config = llm.llmConfig();
  assert.equal(config.openaiTimeoutMs, 300000);
  assert.equal(config.localChatTimeoutMs, 900000);

  process.env.OPENAI_TIMEOUT_MS = '1234';
  process.env.LOCAL_CHAT_TIMEOUT_MS = '5678';
  assert.equal(llm.llmConfig().openaiTimeoutMs, 1234);
  assert.equal(llm.llmConfig().localChatTimeoutMs, 5678);
  // Invalid values fall back to the defaults
  process.env.OPENAI_TIMEOUT_MS = 'soon';
  process.env.LOCAL_CHAT_TIMEOUT_MS = '-5';
  assert.equal(llm.llmConfig().openaiTimeoutMs, 300000);
  assert.equal(llm.llmConfig().localChatTimeoutMs, 900000);
});

test('an embedding request that gets no answer times out with a readable 504 error and is not retried', async () => {
  process.env.EMBED_TIMEOUT_MS = '50';
  fake.hang = true;
  await rejectsWithin(llm.embed(['x']), 2000, (err) => {
    assert.ok(err instanceof llm.LlmTimeoutError);
    assert.equal(err.status, 504);
    assert.equal(
      err.message,
      'The embedding service (Ollama) did not respond within 0 s. Check that Ollama is running, or increase EMBED_TIMEOUT_MS.'
    );
    return true;
  });
});

test('an OpenAI request that gets no answer times out after OPENAI_TIMEOUT_MS and is not retried', async () => {
  process.env.OPENAI_TIMEOUT_MS = '50';
  fakeOpenAI.hang = true;
  await rejectsWithin(
    llm.chat({ provider: 'openai', model: 'test-model', system: 'S', user: 'U' }),
    2000,
    (err) => {
      assert.ok(err instanceof llm.LlmTimeoutError);
      assert.equal(err.status, 504);
      assert.match(err.message, /^OpenAI did not respond within 0 s\. .*OPENAI_TIMEOUT_MS\.$/);
      return true;
    }
  );
  assert.equal(fakeOpenAI.requests.length, 1);
});

test('a local request that gets no answer times out after LOCAL_CHAT_TIMEOUT_MS, not OPENAI_TIMEOUT_MS', async () => {
  process.env.LOCAL_CHAT_TIMEOUT_MS = '50';
  process.env.OPENAI_TIMEOUT_MS = '60000';
  fake.hang = true;
  await rejectsWithin(
    llm.chat({ provider: 'local', model: 'gemma3:4b', system: 'S', user: 'U' }),
    2000,
    (err) => {
      assert.ok(err instanceof llm.LlmTimeoutError);
      assert.equal(err.status, 504);
      assert.match(err.message, /^The local model did not respond within 0 s\. .*LOCAL_CHAT_TIMEOUT_MS\.$/);
      return true;
    }
  );
});

test('the time limit is passed with every request, so a slow answer within it succeeds', async () => {
  process.env.OPENAI_TIMEOUT_MS = '2000';
  let release;
  fakeOpenAI.wait = new Promise((resolve) => (release = resolve));
  setTimeout(release, 100);
  try {
    const reply = await llm.chat({ provider: 'openai', model: 'test-model', system: 'S', user: 'U' });
    assert.equal(reply.text, 'OpenAI answer.');
  } finally {
    fakeOpenAI.wait = undefined;
  }
});

// Local replies are streamed, so a reply that takes longer than Node's 300 s wait for response
// headers can still arrive; the time limit covers the whole stream

test('a local reply arrives in chunks and is joined, with the reported token usage', async () => {
  llm.resetTokenRatio();
  fake.answer = 'A streamed local answer.';
  fake.charsPerToken = 2;
  const user = 'U'.repeat(20000);
  try {
    const reply = await llm.chat({ provider: 'local', model: 'gemma3:4b', system: 'S', user });
    assert.equal(reply.text, 'A streamed local answer.');
    assert.equal(fake.chatRequests[0].stream, true);
    // The usage chunk at the end was read: the prompt had about 2 characters per token
    assert.ok(Math.abs(llm.tokenRatio() - 2) < 0.01, String(llm.tokenRatio()));
  } finally {
    fake.answer = 'Local answer [1].';
    delete fake.charsPerToken;
    llm.resetTokenRatio();
  }
});

test('a local reply that stops in the middle times out after LOCAL_CHAT_TIMEOUT_MS and is not retried', async () => {
  process.env.LOCAL_CHAT_TIMEOUT_MS = '100';
  fake.stallAfterFirstChunk = true;
  await rejectsWithin(
    llm.chat({ provider: 'local', model: 'gemma3:4b', system: 'S', user: 'U' }),
    2000,
    (err) => {
      assert.ok(err instanceof llm.LlmTimeoutError);
      assert.match(err.message, /^The local model did not respond within 0 s\./);
      return true;
    }
  );
  assert.equal(fake.chatRequests.length, 1);
});

test('a local reply whose stream ends without a finish reason is retried, then reported', async () => {
  fake.endWithoutFinish = true;
  await assert.rejects(llm.chat({ provider: 'local', model: 'gemma3:4b', system: 'S', user: 'U' }), {
    message: "The local model's reply ended before it was complete.",
  });
  assert.equal(fake.chatRequests.length, 4);
});

// How Node's fetch fails when it has waited 300 s for the response headers
function headersTimeout() {
  const cause = Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' });
  return new TypeError('fetch failed', { cause });
}

test("Node's 300 s wait for response headers is reported as such, not as the configured limit", async () => {
  process.env.LOCAL_CHAT_TIMEOUT_MS = '900000';
  process.env.OPENAI_TIMEOUT_MS = '600000';
  try {
    fake.fetchError = headersTimeout();
    await assert.rejects(llm.chat({ provider: 'local', model: 'gemma3:4b', system: 'S', user: 'U' }), {
      status: 504,
      message:
        'The local model did not start answering within 300 s (the limit of Node.js). Use a smaller model or a smaller LOCAL_PART_CHARS.',
    });
    fakeOpenAI.fetchError = headersTimeout();
    await assert.rejects(llm.chat({ provider: 'openai', model: 'test-model', system: 'S', user: 'U' }), {
      status: 504,
      message: 'OpenAI did not respond within 300 s. Try again later, or increase OPENAI_TIMEOUT_MS.',
    });
  } finally {
    delete fake.fetchError;
    delete fakeOpenAI.fetchError;
  }
});

// --- R2: embedding retries ---

test('embedding batches that fail with a server error are retried', async () => {
  fake.embedErrors = [500, 503];
  const vectors = await llm.embed(['a', 'b']);
  assert.equal(vectors.length, 2);
  assert.equal(embedCalls().length, 3);
});

test('an embedding batch is retried at most three times, then the error is reported', async () => {
  fake.embedErrors = [500, 500, 500, 500, 500];
  await assert.rejects(llm.embed(['a']), { message: 'Embedding request failed: fake error 500.' });
  assert.equal(embedCalls().length, 4);
});

test('only the failed batch is retried; earlier batches are not sent again', async () => {
  const texts = Array.from({ length: 40 }, (_, i) => `text ${i}`);
  // The first batch succeeds, the second fails once
  const realShift = fake.embedErrors.shift.bind(fake.embedErrors);
  let request = 0;
  fake.embedErrors.shift = () => (++request === 2 ? 502 : realShift());
  const vectors = await llm.embed(texts);
  assert.equal(vectors.length, 40);
  assert.deepEqual(embedCalls().map((call) => call.body.input.length), [32, 8, 8]);
});

test('unreachable Ollama is retried, then reported with the exact message', async () => {
  fake.unreachable = true;
  await assert.rejects(llm.embed(['x']), { message: 'Embedding service (Ollama) is not reachable.' });
  assert.equal(fake.unreachableCalls, 4);
});

test('client errors from the embedding service are not retried', async () => {
  fake.embedErrors = [400];
  await assert.rejects(llm.embed(['x']), { message: 'Embedding request failed: fake error 400.' });
  assert.equal(embedCalls().length, 1);
});

// --- R3: rate limits ---

test('Retry-After is read from retry-after-ms, retry-after in seconds or an HTTP date', () => {
  assert.equal(llm.retryAfterMs(new Headers({ 'retry-after-ms': '1500' })), 1500);
  assert.equal(llm.retryAfterMs(new Headers({ 'retry-after': '3' })), 3000);
  assert.equal(llm.retryAfterMs({ 'retry-after': '2' }), 2000);
  const date = new Date(Date.now() + 10000).toUTCString();
  const fromDate = llm.retryAfterMs(new Headers({ 'retry-after': date }));
  assert.ok(fromDate > 8000 && fromDate <= 10000, String(fromDate));
  assert.equal(llm.retryAfterMs(new Headers({ 'retry-after': 'soon' })), null);
  assert.equal(llm.retryAfterMs(new Headers()), null);
  assert.equal(llm.retryAfterMs(undefined), null);
});

test('rate limits wait as Retry-After asks, or back off longer than other errors', () => {
  llm.setRetryDelays();
  const rateLimit = (headers) => apiError(429, 'Rate limit reached', headers);
  const serverError = apiError(500, 'boom');

  // Other errors: 1, 2, 4 s; rate limits without Retry-After: 5, 10, 20 s
  assert.deepEqual([0, 1, 2].map((attempt) => llm.retryDelayMs(serverError, attempt)), [1000, 2000, 4000]);
  assert.deepEqual([0, 1, 2].map((attempt) => llm.retryDelayMs(rateLimit(), attempt)), [5000, 10000, 20000]);
  // Retry-After wins over the backoff, also when it is shorter
  assert.equal(llm.retryDelayMs(rateLimit({ 'retry-after': '2' }), 2), 2000);
  assert.equal(llm.retryDelayMs(rateLimit({ 'retry-after-ms': '30000' }), 0), 30000);
  // A wait of more than a minute is not worth it
  assert.equal(llm.retryDelayMs(rateLimit({ 'retry-after': '3600' }), 0), null);
});

test('a rate-limited OpenAI request is retried after the time Retry-After asks for', async () => {
  fakeOpenAI.errors = [{ status: 429, message: 'Rate limit reached', headers: { 'retry-after-ms': '150' } }];
  const started = Date.now();
  const reply = await llm.chat({ provider: 'openai', model: 'test-model', system: 'S', user: 'U' });
  assert.equal(reply.text, 'OpenAI answer.');
  assert.equal(fakeOpenAI.requests.length, 2);
  // The short test delays do not apply: the response said when to retry
  assert.ok(Date.now() - started >= 140, `retried after ${Date.now() - started} ms`);
});

test('a rate limit that asks for a wait of more than a minute is reported at once', async () => {
  fakeOpenAI.errors = [{ status: 429, message: 'Rate limit reached', headers: { 'retry-after': '3600' } }];
  await assert.rejects(llm.chat({ provider: 'openai', model: 'test-model', system: 'S', user: 'U' }), {
    message: 'OpenAI rate limit reached. Try again later.',
  });
  assert.equal(fakeOpenAI.requests.length, 1);
});

test('an exceeded quota (429 insufficient_quota) is not retried', async () => {
  fakeOpenAI.errors = [{ status: 429, message: 'You exceeded your quota', code: 'insufficient_quota' }];
  await assert.rejects(llm.chat({ provider: 'openai', model: 'test-model', system: 'S', user: 'U' }), {
    message: 'OpenAI quota exceeded. Check billing on the OpenAI account.',
  });
  assert.equal(fakeOpenAI.requests.length, 1);
});

// --- R17: context errors ---

test('only real context-length messages are context errors', () => {
  const context = [
    'the input length exceeds the context length',
    'input exceeds maximum context length',
    'prompt too long; exceeded max context length by 120 tokens',
    "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens.",
    'context_length_exceeded',
    'requested tokens exceed context window of 4096',
    'too many tokens in the prompt',
  ];
  const other = [
    'invalid token',
    'unexpected token < in JSON at position 0',
    'max_tokens must be a positive integer',
    'model "gemma3:4b" not found, try pulling it first',
    'request context canceled',
  ];
  for (const message of context) assert.equal(llm.isContextError(apiError(500, message)), true, message);
  for (const message of other) assert.equal(llm.isContextError(apiError(500, message)), false, message);
  // Only API errors count
  assert.equal(llm.isContextError(new Error('the input length exceeds the context length')), false);
});

test('a local server error that mentions a token is retried and reported as it is', async () => {
  fake.chatError = { status: 500, message: 'unexpected token in model output' };
  await assert.rejects(llm.chat({ provider: 'local', model: 'gemma3:4b', system: 'S', user: 'U' }), {
    message: 'Local model request failed: 500 unexpected token in model output',
  });
  assert.equal(fake.chatRequests.length, 4);
});
