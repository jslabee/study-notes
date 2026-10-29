// Replaces fetch calls to Ollama with deterministic fake responses, so tests do not need Ollama:
// embeddings, the installed model list (/api/tags, /api/show) and the OpenAI-compatible chat
const FAKE_URL = 'http://ollama.test';

export function fakeVector(text, dim) {
  const vector = new Array(dim).fill(0);
  for (let i = 0; i < text.length; i++) vector[i % dim] += (text.charCodeAt(i) % 13) + 1;
  return vector;
}

// models: [{ name, size, capabilities }]; without capabilities, /api/show has no such field
export function installFakeOllama({ dim = 8, models = [], answer = 'Local answer [1].' } = {}) {
  process.env.OLLAMA_URL = FAKE_URL;
  process.env.EMBED_MODEL = 'bge-m3';
  process.env.EMBED_DIM = String(dim);

  const realFetch = globalThis.fetch;
  const fake = { calls: [], chatRequests: [], unreachable: false, returnDim: dim, models, answer };

  globalThis.fetch = async (url, options = {}) => {
    if (!String(url).startsWith(FAKE_URL)) return realFetch(url, options);
    if (fake.unreachable) throw new TypeError('fetch failed');
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
      });
    }

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
