// Replaces fetch calls to Ollama with deterministic fake responses, so tests do not need Ollama:
// embeddings, the installed model list (/api/tags, /api/show) and the OpenAI-compatible chat
const FAKE_URL = 'http://ollama.test';

export function fakeVector(text, dim) {
  const vector = new Array(dim).fill(0);
  for (let i = 0; i < text.length; i++) vector[i % dim] += (text.charCodeAt(i) % 13) + 1;
  return vector;
}

// A request that never gets an answer: it fails like fetch does when its signal aborts
export function hangUntilAborted(signal) {
  return new Promise((_, reject) => {
    const fail = () => reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
    if (signal?.aborted) fail();
    else signal?.addEventListener('abort', fail, { once: true });
  });
}

// A streamed chat reply as Ollama's OpenAI-compatible endpoint sends it (server-sent events): the
// answer in two chunks, a chunk with the finish reason, a usage chunk (with include_usage), then
// [DONE]. fake.stallAfterFirstChunk: the stream stops after the first chunk until the request is
// aborted; fake.endWithoutFinish: the stream ends after the first chunk (a closed connection).
function streamReply(fake, body, usage, signal) {
  const base = { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 0, model: body.model };
  const half = Math.ceil(fake.answer.length / 2);
  const events = [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: fake.answer.slice(0, half) }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: fake.answer.slice(half) }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: fake.finishReason ?? 'stop' }] },
    ...(body.stream_options?.include_usage ? [{ ...base, choices: [], usage }] : []),
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(events[0]));
      if (fake.endWithoutFinish) return controller.close();
      if (fake.stallAfterFirstChunk) {
        const fail = () => controller.error(signal.reason);
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
        return;
      }
      for (const event of events.slice(1)) controller.enqueue(encoder.encode(event));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

// models: [{ name, size, capabilities }]; without capabilities, /api/show has no such field
export function installFakeOllama({ dim = 8, models = [], answer = 'Local answer [1].' } = {}) {
  process.env.OLLAMA_URL = FAKE_URL;
  process.env.EMBED_MODEL = 'bge-m3';
  process.env.EMBED_DIM = String(dim);

  const realFetch = globalThis.fetch;
  // unreachableCalls counts requests made while unreachable; hang: requests never get an answer
  // and fail only when their signal aborts (a timeout); embedErrors: HTTP statuses that the next
  // embedding requests fail with, one per request
  const fake = {
    calls: [],
    chatRequests: [],
    unreachable: false,
    unreachableCalls: 0,
    hang: false,
    embedErrors: [],
    returnDim: dim,
    models,
    answer,
  };

  globalThis.fetch = async (url, options = {}) => {
    if (!String(url).startsWith(FAKE_URL)) return realFetch(url, options);
    if (fake.unreachable) {
      fake.unreachableCalls++;
      throw new TypeError('fetch failed');
    }
    if (fake.hang) return hangUntilAborted(options.signal);
    // fetchError: every request fails with this error, as fetch itself would fail
    if (fake.fetchError) throw fake.fetchError;
    const { pathname } = new URL(String(url));

    if (pathname === '/api/tags') {
      fake.calls.push({ url: String(url) });
      return Response.json({
        models: fake.models.map(({ name, size = 1000 }) => ({ name, model: name, size })),
      });
    }

    const body = JSON.parse(options.body);
    fake.calls.push({ url: String(url), body });

    if (pathname === '/api/show') {
      const model = fake.models.find((m) => m.name === body.model);
      if (!model) return Response.json({ error: 'model not found' }, { status: 404 });
      return Response.json(model.capabilities ? { capabilities: model.capabilities } : {});
    }

    if (pathname === '/v1/chat/completions') {
      fake.chatRequests.push(body);
      // chatError: { status, message } makes the chat fail like Ollama does
      if (fake.chatError) {
        return Response.json(
          { error: { message: fake.chatError.message, type: 'api_error' } },
          { status: fake.chatError.status }
        );
      }
      // Prompt tokens at fake.charsPerToken (default 4); output tokens from fake.outputTokens
      const usage = {
        prompt_tokens: Math.ceil(
          body.messages.reduce((sum, m) => sum + m.content.length, 0) / (fake.charsPerToken ?? 4)
        ),
        completion_tokens: fake.outputTokens ?? 5,
      };
      if (body.stream) return streamReply(fake, body, usage, options.signal);
      return Response.json({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 0,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: fake.answer },
            finish_reason: fake.finishReason ?? 'stop',
          },
        ],
        usage,
      });
    }

    const embedError = fake.embedErrors.shift();
    if (embedError) return Response.json({ error: `fake error ${embedError}` }, { status: embedError });
    return Response.json({
      model: body.model,
      embeddings: body.input.map((text) => fakeVector(text, fake.returnDim)),
    });
  };
  fake.restore = () => {
    globalThis.fetch = realFetch;
  };
  return fake;
}
