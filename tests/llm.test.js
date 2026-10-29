import { test, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeOllama } from './helpers/fake-ollama.js';
import { installFakeOpenAI } from './helpers/fake-openai.js';

// Ollama and OpenAI are faked, so no model is called
const fake = installFakeOllama();
const fakeOpenAI = installFakeOpenAI({ answer: 'OpenAI answer.' });
const llm = await import('../server/llm.js');

const GEMMA = { name: 'gemma3:4b', size: 3300000000, capabilities: ['completion', 'vision'] };
const QWEN = { name: 'qwen3:8b', size: 5200000000, capabilities: ['completion', 'tools'] };
const BGE = { name: 'bge-m3:latest', size: 1200000000, capabilities: ['embedding'] };
const NOMIC = { name: 'nomic-embed-text:latest', size: 270000000, capabilities: ['embedding'] };
// Older Ollama versions do not report capabilities
const OLD = { name: 'llama2:latest', size: 3800000000 };

const SHORT = 500;
const LONG = 5000;

beforeEach(() => {
  fake.models = [GEMMA, QWEN, BGE];
  fake.unreachable = false;
  fake.calls.length = 0;
  process.env.LOCAL_LLM_MODEL = 'gemma3:4b';
  process.env.LOCAL_MAX_CHARS = '1000';
  process.env.OPENAI_MODEL = 'gpt-5-mini';
  process.env.OPENAI_MODELS = 'gpt-5-mini,gpt-5';
  process.env.ALLOW_EXTERNAL = 'true';
  delete process.env.DEFAULT_PROVIDER;
  llm.clearLocalModelCache();
});

after(() => {
  fakeOpenAI.restore();
  fake.restore();
});

async function rejectsWith(promise, status, pattern) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.status, status);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

test('the local list leaves out the embedding model and models without "completion"', async () => {
  fake.models = [GEMMA, BGE, NOMIC, QWEN, OLD];
  const local = await llm.listLocalModels();
  assert.deepEqual(local, {
    reachable: true,
    models: [
      { name: 'gemma3:4b', size: 3300000000 },
      { name: 'qwen3:8b', size: 5200000000 },
      { name: 'llama2:latest', size: 3800000000 },
    ],
  });
});

test('without a capabilities field only EMBED_MODEL is left out', async () => {
  fake.models = [{ name: 'bge-m3:latest' }, { name: 'nomic-embed-text:latest' }, OLD];
  const names = (await llm.listLocalModels()).models.map((m) => m.name);
  assert.deepEqual(names, ['nomic-embed-text:latest', 'llama2:latest']);
});

test('unreachable Ollama gives an empty, unreachable list', async () => {
  fake.unreachable = true;
  assert.deepEqual(await llm.listLocalModels(), { reachable: false, models: [] });
});

test('the local list is cached for 30 seconds and refresh bypasses the cache', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1000000 });
  try {
    const tagCalls = () => fake.calls.filter((c) => c.url.endsWith('/api/tags')).length;
    assert.equal((await llm.listLocalModels()).models.length, 2);

    fake.models = [GEMMA];
    mock.timers.tick(29000);
    assert.equal((await llm.listLocalModels()).models.length, 2);
    assert.equal(tagCalls(), 1);

    assert.equal((await llm.listLocalModels({ refresh: true })).models.length, 1);
    assert.equal(tagCalls(), 2);

    fake.models = [GEMMA, QWEN];
    mock.timers.tick(30001);
    assert.equal((await llm.listLocalModels()).models.length, 2);
    assert.equal(tagCalls(), 3);
  } finally {
    mock.timers.reset();
  }
});

test('auto uses the local model for a short text', async () => {
  assert.deepEqual(await llm.resolveLlm({ provider: 'auto', textLength: SHORT }), {
    provider: 'local',
    model: 'gemma3:4b',
  });
});

test('auto uses OpenAI for a text longer than LOCAL_MAX_CHARS', async () => {
  assert.deepEqual(await llm.resolveLlm({ provider: 'auto', textLength: LONG }), {
    provider: 'openai',
    model: 'gpt-5-mini',
  });
});

test('auto uses OpenAI when Ollama is unreachable', async () => {
  fake.unreachable = true;
  assert.deepEqual(await llm.resolveLlm({ provider: 'auto', textLength: SHORT }), {
    provider: 'openai',
    model: 'gpt-5-mini',
  });
});

test('auto uses OpenAI when the default local model is not installed', async () => {
  process.env.LOCAL_LLM_MODEL = 'llama3.2:3b';
  assert.deepEqual(await llm.resolveLlm({ provider: 'auto', textLength: SHORT }), {
    provider: 'openai',
    model: 'gpt-5-mini',
  });
});

test('auto with a given local model uses it for a short text', async () => {
  assert.deepEqual(await llm.resolveLlm({ provider: 'auto', model: 'qwen3:8b', textLength: SHORT }), {
    provider: 'local',
    model: 'qwen3:8b',
  });
});

test('without a provider DEFAULT_PROVIDER is used', async () => {
  assert.equal((await llm.resolveLlm({ textLength: SHORT })).provider, 'local');
  process.env.DEFAULT_PROVIDER = 'openai';
  assert.equal((await llm.resolveLlm({ textLength: SHORT })).provider, 'openai');
});

test('local never falls back to OpenAI', async () => {
  assert.deepEqual(await llm.resolveLlm({ provider: 'local', textLength: LONG }), {
    provider: 'local',
    model: 'gemma3:4b',
  });

  fake.unreachable = true;
  llm.clearLocalModelCache();
  await rejectsWith(llm.resolveLlm({ provider: 'local', textLength: SHORT }), 503, /not reachable/);
  fake.unreachable = false;
  llm.clearLocalModelCache();

  process.env.LOCAL_LLM_MODEL = 'llama3.2:3b';
  await rejectsWith(
    llm.resolveLlm({ provider: 'local', textLength: SHORT }),
    503,
    /"llama3\.2:3b" is not installed/
  );
});

test('a local model name without a tag matches the ":latest" model', async () => {
  fake.models = [OLD];
  process.env.LOCAL_LLM_MODEL = 'llama2';
  assert.deepEqual(await llm.resolveLlm({ provider: 'local' }), {
    provider: 'local',
    model: 'llama2:latest',
  });
});

test('with ALLOW_EXTERNAL=false openai is refused and auto uses only the local model', async () => {
  process.env.ALLOW_EXTERNAL = 'false';
  await rejectsWith(llm.resolveLlm({ provider: 'openai' }), 403, /disabled/);
  process.env.DEFAULT_PROVIDER = 'openai';
  await rejectsWith(llm.resolveLlm({}), 403, /disabled/);

  assert.deepEqual(await llm.resolveLlm({ provider: 'auto', textLength: SHORT }), {
    provider: 'local',
    model: 'gemma3:4b',
  });
  await rejectsWith(llm.resolveLlm({ provider: 'auto', textLength: LONG }), 422, /LOCAL_MAX_CHARS/);

  fake.unreachable = true;
  llm.clearLocalModelCache();
  await rejectsWith(llm.resolveLlm({ provider: 'auto', textLength: SHORT }), 503, /not reachable/);
});

test('a model outside the allowed list is rejected with 400', async () => {
  await rejectsWith(llm.resolveLlm({ provider: 'openai', model: 'gpt-4o' }), 400, /"gpt-4o"/);
  await rejectsWith(llm.resolveLlm({ provider: 'local', model: 'llama3.2:3b' }), 400);
  // Embedding models are not chat models
  await rejectsWith(llm.resolveLlm({ provider: 'local', model: 'bge-m3' }), 400);
  await rejectsWith(llm.resolveLlm({ provider: 'auto', model: 'unknown', textLength: LONG }), 400);
  await rejectsWith(llm.resolveLlm({ provider: 'other' }), 400);

  assert.deepEqual(await llm.resolveLlm({ provider: 'openai', model: 'gpt-5' }), {
    provider: 'openai',
    model: 'gpt-5',
  });
});

test('with an empty OPENAI_MODELS only OPENAI_MODEL is offered', () => {
  process.env.OPENAI_MODELS = '';
  assert.deepEqual(llm.openaiModels(), ['gpt-5-mini']);
  process.env.OPENAI_MODELS = ' gpt-5 , gpt-5-nano ';
  assert.deepEqual(llm.openaiModels(), ['gpt-5-mini', 'gpt-5', 'gpt-5-nano']);
});

test('local chat goes to the OpenAI-compatible Ollama endpoint', async () => {
  fake.chatRequests.length = 0;
  const reply = await llm.chat({
    provider: 'local',
    model: 'gemma3:4b',
    system: 'System.',
    user: 'Question?',
    maxOutputTokens: 4000,
  });
  assert.deepEqual(reply, { text: 'Local answer [1].', provider: 'local', model: 'gemma3:4b' });
  // Local calls use LOCAL_MAX_OUTPUT_TOKENS (default 2048), not the caller's limit
  assert.deepEqual(fake.chatRequests, [
    {
      model: 'gemma3:4b',
      messages: [
        { role: 'system', content: 'System.' },
        { role: 'user', content: 'Question?' },
      ],
      max_tokens: 2048,
    },
  ]);
});

const LOCAL_CONTEXT = /too large for the local model's context.*LOCAL_CONTEXT_TOKENS and OLLAMA_CONTEXT_LENGTH/;

function withLocalTokens(context, output, fn) {
  return async () => {
    if (context) process.env.LOCAL_CONTEXT_TOKENS = String(context);
    if (output) process.env.LOCAL_MAX_OUTPUT_TOKENS = String(output);
    fake.chatRequests.length = 0;
    try {
      await fn();
    } finally {
      delete process.env.LOCAL_CONTEXT_TOKENS;
      delete process.env.LOCAL_MAX_OUTPUT_TOKENS;
      delete fake.chatError;
      delete fake.finishReason;
    }
  };
}

test('the local context defaults to 16384 tokens with 2048 output tokens', () => {
  const config = llm.llmConfig();
  assert.equal(config.localContextTokens, 16384);
  assert.equal(config.localMaxOutputTokens, 2048);
  assert.equal(llm.estimateTokens('a'.repeat(400)), 100);
  assert.equal(llm.estimateTokens('abcde'), 2);
});

test(
  'a request fits when input + output tokens + 10% fit into LOCAL_CONTEXT_TOKENS',
  withLocalTokens(11000, 1000, () => {
    // (input + 1000) * 1.1 <= 11000 allows about 9000 input tokens (36,000 characters)
    assert.ok(llm.fitsLocalContext('a'.repeat(4000), 'b'.repeat(31800)));
    assert.ok(!llm.fitsLocalContext('a'.repeat(4000), 'b'.repeat(32200)));
  })
);

test(
  'LOCAL_MAX_OUTPUT_TOKENS sets max_tokens for local calls',
  withLocalTokens(65536, 8192, async () => {
    await llm.chat({ provider: 'local', model: 'gemma3:4b', system: 'S', user: 'U', maxOutputTokens: 4000 });
    assert.equal(fake.chatRequests[0].max_tokens, 8192);
  })
);

test(
  'a local request that does not fit the context is not sent',
  withLocalTokens(4096, 1024, async () => {
    await rejectsWith(
      llm.chat({ provider: 'local', model: 'gemma3:4b', system: 'S', user: 'x'.repeat(12000) }),
      422,
      LOCAL_CONTEXT
    );
    assert.equal(fake.chatRequests.length, 0);
  })
);

test(
  'a context error from Ollama gives the local context message and is not retried',
  withLocalTokens(null, null, async () => {
    fake.chatError = { status: 500, message: 'the input length exceeds the context length' };
    await rejectsWith(
      llm.chat({ provider: 'local', model: 'gemma3:4b', system: 'S', user: 'U' }),
      422,
      LOCAL_CONTEXT
    );
    assert.equal(fake.chatRequests.length, 1);
  })
);

test(
  'a reply cut off by the token limit gives the local context message',
  withLocalTokens(null, null, async () => {
    fake.finishReason = 'length';
    await rejectsWith(
      llm.chat({ provider: 'local', model: 'gemma3:4b', system: 'S', user: 'U' }),
      422,
      LOCAL_CONTEXT
    );
  })
);

test('OpenAI chat returns the provider and model used', async () => {
  fakeOpenAI.requests.length = 0;
  const reply = await llm.chat({ provider: 'openai', model: 'gpt-5', system: 'S', user: 'U' });
  assert.deepEqual(reply, { text: 'OpenAI answer.', provider: 'openai', model: 'gpt-5' });
  assert.equal(fakeOpenAI.requests[0].body.model, 'gpt-5');
});

test('getLlmModels reports defaults, availability and models', async () => {
  process.env.ALLOW_EXTERNAL = 'false';
  assert.deepEqual(await llm.getLlmModels(), {
    default: { provider: 'auto', localModel: 'gemma3:4b', openaiModel: 'gpt-5-mini' },
    allowExternal: false,
    local: {
      reachable: true,
      models: [
        { name: 'gemma3:4b', size: 3300000000 },
        { name: 'qwen3:8b', size: 5200000000 },
      ],
    },
    openai: { configured: true, models: ['gpt-5-mini', 'gpt-5'] },
  });
});
