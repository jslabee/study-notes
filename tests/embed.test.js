import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeOllama } from './helpers/fake-ollama.js';
import { embed, normalize } from '../server/llm.js';

const fake = installFakeOllama({ dim: 8 });
after(() => fake.restore());

const vectorLength = (v) => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));

test('sends at most 32 texts per call to {OLLAMA_URL}/api/embed', async () => {
  fake.calls.length = 0;
  const texts = Array.from({ length: 70 }, (_, i) => `text ${i}`);
  const vectors = await embed(texts);

  assert.equal(vectors.length, 70);
  assert.deepEqual(fake.calls.map((c) => c.body.input.length), [32, 32, 6]);
  for (const call of fake.calls) {
    assert.equal(call.url, 'http://ollama.test/api/embed');
    assert.equal(call.body.model, 'bge-m3');
  }
  assert.deepEqual(fake.calls.flatMap((c) => c.body.input), texts);
});

test('every vector is normalized to length 1', async () => {
  const vectors = await embed(['alpha', 'a much longer text about photosynthesis']);
  for (const v of vectors) {
    assert.ok(v instanceof Float32Array);
    assert.ok(Math.abs(vectorLength(v) - 1) < 1e-6);
  }
  assert.ok(Math.abs(vectorLength(normalize([3, 4])) - 1) < 1e-6);
  assert.throws(() => normalize([0, 0]));
});

test('vectors with a length other than EMBED_DIM are rejected', async () => {
  fake.returnDim = 5;
  try {
    await assert.rejects(embed(['x']), { message: 'Embedding has 5 values, but EMBED_DIM is 8.' });
  } finally {
    fake.returnDim = 8;
  }
});

test('unreachable Ollama gives the exact error message', async () => {
  fake.unreachable = true;
  try {
    await assert.rejects(embed(['x']), { message: 'Embedding service (Ollama) is not reachable.' });
  } finally {
    fake.unreachable = false;
  }
});

test('Ollama error responses are reported', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: 'model "bge-m3" not found' }, { status: 404 });
  try {
    await assert.rejects(embed(['x']), { message: 'Embedding request failed: model "bge-m3" not found.' });
  } finally {
    globalThis.fetch = realFetch;
  }
});
