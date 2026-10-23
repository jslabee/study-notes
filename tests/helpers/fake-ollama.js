// Replaces fetch calls to Ollama with deterministic fake embeddings, so tests do not need Ollama
const FAKE_URL = 'http://ollama.test';

export function fakeVector(text, dim) {
  const vector = new Array(dim).fill(0);
  for (let i = 0; i < text.length; i++) vector[i % dim] += (text.charCodeAt(i) % 13) + 1;
  return vector;
}

export function installFakeOllama({ dim = 8 } = {}) {
  process.env.OLLAMA_URL = FAKE_URL;
  process.env.EMBED_MODEL = 'bge-m3';
  process.env.EMBED_DIM = String(dim);

  const realFetch = globalThis.fetch;
  const fake = { calls: [], unreachable: false, returnDim: dim };

  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith(FAKE_URL)) return realFetch(url, options);
    if (fake.unreachable) throw new TypeError('fetch failed');
    const body = JSON.parse(options.body);
    fake.calls.push({ url: String(url), body });
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
