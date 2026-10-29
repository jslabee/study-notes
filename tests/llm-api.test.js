import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFakeOllama } from './helpers/fake-ollama.js';
import { installFakeOpenAI } from './helpers/fake-openai.js';

// Temporary database; Ollama and OpenAI are faked, so no real calls are made
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-notes-llm-api-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.LOCAL_LLM_MODEL = 'gemma3:4b';
process.env.LOCAL_MAX_CHARS = '60000';
process.env.OPENAI_MODELS = '';
delete process.env.DEFAULT_PROVIDER;
const GEMMA = { name: 'gemma3:4b', size: 3300000000, capabilities: ['completion'] };
const BGE = { name: 'bge-m3:latest', size: 1200000000, capabilities: ['embedding'] };
const fakeOllama = installFakeOllama({ dim: 8, models: [GEMMA, BGE], answer: 'Locally [1].' });
const fakeOpenAI = installFakeOpenAI({ answer: 'Remotely [1].' });

const { app } = await import('../server/index.js');
const { getDb, closeDb } = await import('../server/db.js');
const { whenIdle } = await import('../server/jobs.js');
const { clearLocalModelCache } = await import('../server/llm.js');

let server;
let baseUrl;
let materialId;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const courseId = Number(getDb().prepare("INSERT INTO courses (name) VALUES ('Biology')").run().lastInsertRowid);
  const form = new FormData();
  form.append('courseId', courseId);
  form.append('title', 'Cells');
  form.append('text', 'Cells are the smallest units of life. Cells use energy.');
  const res = await fetch(`${baseUrl}/api/materials`, { method: 'POST', body: form });
  materialId = (await res.json()).id;
  await whenIdle();
});

beforeEach(() => {
  fakeOllama.models = [GEMMA, BGE];
  fakeOllama.unreachable = false;
  process.env.ALLOW_EXTERNAL = 'true';
  clearLocalModelCache();
});

after(() => {
  server.close();
  closeDb();
  fakeOpenAI.restore();
  fakeOllama.restore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function post(url, body) {
  return fetch(`${baseUrl}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const notesRow = () =>
  getDb().prepare('SELECT status, model, content, error FROM notes WHERE material_id = ?').get(materialId);

test('GET /api/llm/models returns defaults and models; refresh=1 bypasses the cache', async () => {
  const res = await fetch(`${baseUrl}/api/llm/models`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    default: { provider: 'auto', localModel: 'gemma3:4b', openaiModel: 'test-model' },
    allowExternal: true,
    local: { reachable: true, models: [{ name: 'gemma3:4b', size: 3300000000 }] },
    openai: { configured: true, models: ['test-model'] },
  });

  fakeOllama.unreachable = true;
  const cached = await (await fetch(`${baseUrl}/api/llm/models`)).json();
  assert.equal(cached.local.reachable, true);
  const fresh = await (await fetch(`${baseUrl}/api/llm/models?refresh=1`)).json();
  assert.deepEqual(fresh.local, { reachable: false, models: [] });
});

test('POST /api/ask uses the chosen provider and returns the provider and model used', async () => {
  let body = await (await post('/api/ask', { question: 'What are cells?' })).json();
  assert.equal(body.answer, 'Locally [1].');
  assert.equal(body.provider, 'local');
  assert.equal(body.model, 'gemma3:4b');

  body = await (await post('/api/ask', { question: 'What are cells?', provider: 'openai' })).json();
  assert.equal(body.answer, 'Remotely [1].');
  assert.deepEqual([body.provider, body.model], ['openai', 'test-model']);
});

test('POST /api/ask rejects invalid choices with clear errors', async () => {
  let res = await post('/api/ask', { question: 'x', provider: 'cloud' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'provider must be auto, local or openai.' });

  res = await post('/api/ask', { question: 'x', provider: 'openai', model: 'gpt-4o' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Model "gpt-4o" is not an allowed OpenAI model.' });

  res = await post('/api/ask', { question: 'x', model: 42 });
  assert.equal(res.status, 400);

  process.env.ALLOW_EXTERNAL = 'false';
  res = await post('/api/ask', { question: 'x', provider: 'openai' });
  assert.equal(res.status, 403);

  // Only the embedding model is installed, so local has nothing to chat with
  fakeOllama.models = [BGE];
  res = await post('/api/ask', { question: 'x', provider: 'local' });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /"gemma3:4b" is not installed in Ollama/);
});

test('notes store "<provider>:<model>" for the provider that was used', async () => {
  let res = await post(`/api/materials/${materialId}/notes`, { provider: 'local' });
  assert.equal(res.status, 202);
  await whenIdle();
  assert.deepEqual(notesRow(), { status: 'ready', model: 'local:gemma3:4b', content: 'Locally [1].', error: null });

  res = await post(`/api/materials/${materialId}/notes`, { provider: 'openai', model: 'test-model' });
  assert.equal(res.status, 202);
  await whenIdle();
  assert.equal(notesRow().model, 'openai:test-model');

  // Without a body, auto picks the local model for this short material
  res = await fetch(`${baseUrl}/api/materials/${materialId}/notes`, { method: 'POST' });
  assert.equal(res.status, 202);
  await whenIdle();
  assert.equal(notesRow().model, 'local:gemma3:4b');
});

test('an invalid notes request is rejected and keeps the existing notes', async () => {
  const before = notesRow();
  let res = await post(`/api/materials/${materialId}/notes`, { provider: 'local', model: 'bge-m3' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /"bge-m3" is not an installed local chat model/);

  process.env.ALLOW_EXTERNAL = 'false';
  res = await post(`/api/materials/${materialId}/notes`, { provider: 'openai' });
  assert.equal(res.status, 403);
  assert.deepEqual(notesRow(), before);
});
