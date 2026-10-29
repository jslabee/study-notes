// The provider and model chosen for notes are stored with them, and a job restored after a restart
// uses exactly that choice, or fails with a clear error; it never falls back to another provider.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFakeOllama } from './helpers/fake-ollama.js';
import { installFakeOpenAI } from './helpers/fake-openai.js';

// Temporary database; Ollama and OpenAI are faked, so no model is called
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-notes-restore-llm-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
const GEMMA = { name: 'gemma3:4b', capabilities: ['completion'] };
const fakeOllama = installFakeOllama({ dim: 8, models: [GEMMA], answer: '## Local notes' });
const fakeOpenAI = installFakeOpenAI({ answer: '## OpenAI notes' });

const { app } = await import('../server/index.js');
const { getDb, closeDb } = await import('../server/db.js');
const { whenIdle, restoreJobs } = await import('../server/jobs.js');
const { clearLocalModelCache } = await import('../server/llm.js');

let server;
let baseUrl;
let materialId;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const db = getDb();
  const courseId = db.prepare("INSERT INTO courses (name) VALUES ('Biology')").run().lastInsertRowid;
  materialId = Number(
    db
      .prepare("INSERT INTO materials (course_id, title, type, content, status) VALUES (?, 'Cells', 'text', 'Cells are small.', 'ready')")
      .run(courseId).lastInsertRowid
  );
});

beforeEach(() => {
  process.env.LOCAL_LLM_MODEL = 'gemma3:4b';
  process.env.OPENAI_MODEL = 'gpt-5-mini';
  process.env.OPENAI_MODELS = 'gpt-5-mini,gpt-5';
  process.env.ALLOW_EXTERNAL = 'true';
  process.env.LOCAL_MAX_CHARS = '60000';
  delete process.env.DEFAULT_PROVIDER;
  fakeOllama.models = [GEMMA];
  fakeOllama.unreachable = false;
  fakeOllama.chatRequests.length = 0;
  fakeOpenAI.requests.length = 0;
  clearLocalModelCache();
});

after(() => {
  server.close();
  closeDb();
  fakeOpenAI.restore();
  fakeOllama.restore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const notesRow = (style = 'study-notes') =>
  getDb()
    .prepare(
      'SELECT status, content, model, error, requested_provider, requested_model FROM notes WHERE material_id = ? AND style = ?'
    )
    .get(materialId, style);

async function generate(body) {
  const res = await fetch(`${baseUrl}/api/materials/${materialId}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 202);
  await whenIdle();
}

// Marks the notes as still processing, as after a server stop in the middle of the job, then
// restores the jobs like a server start does
async function restart({ provider, model } = {}, style = 'study-notes') {
  const db = getDb();
  db.prepare("UPDATE notes SET status = 'processing', content = NULL, model = NULL, error = NULL WHERE material_id = ? AND style = ?").run(materialId, style);
  if (provider !== undefined) {
    db.prepare('UPDATE notes SET requested_provider = ?, requested_model = ? WHERE material_id = ? AND style = ?').run(
      provider,
      model,
      materialId,
      style
    );
  }
  clearLocalModelCache();
  restoreJobs();
  await whenIdle();
}

test('the resolved provider and model are stored with the notes', async () => {
  // auto with a short text resolves to the local default model; the resolved choice is stored
  await generate({ style: 'study-notes' });
  assert.deepEqual(
    { ...notesRow(), error: undefined },
    {
      status: 'ready',
      content: '## Local notes',
      model: 'local:gemma3:4b',
      error: undefined,
      requested_provider: 'local',
      requested_model: 'gemma3:4b',
    }
  );

  await generate({ style: 'brief', provider: 'openai', model: 'gpt-5' });
  const brief = notesRow('brief');
  assert.equal(brief.model, 'openai:gpt-5');
  assert.deepEqual([brief.requested_provider, brief.requested_model], ['openai', 'gpt-5']);

  // Generating again replaces the stored choice
  await generate({ style: 'brief', provider: 'local' });
  const again = notesRow('brief');
  assert.deepEqual([again.requested_provider, again.requested_model], ['local', 'gemma3:4b']);
});

test('a restored job uses the stored local model, even when the defaults would choose OpenAI', async () => {
  await generate({ style: 'study-notes', provider: 'local' });
  process.env.DEFAULT_PROVIDER = 'openai';
  process.env.LOCAL_MAX_CHARS = '1';
  fakeOllama.chatRequests.length = 0;

  await restart();

  const row = notesRow();
  assert.equal(row.status, 'ready', row.error);
  assert.equal(row.model, 'local:gemma3:4b');
  assert.equal(fakeOllama.chatRequests.length, 1);
  assert.equal(fakeOpenAI.requests.length, 0);
});

test('a restored job uses the stored OpenAI model, not OPENAI_MODEL', async () => {
  await restart({ provider: 'openai', model: 'gpt-5' });
  const row = notesRow();
  assert.equal(row.status, 'ready', row.error);
  assert.equal(row.model, 'openai:gpt-5');
  assert.equal(fakeOpenAI.requests.length, 1);
  assert.equal(fakeOpenAI.requests[0].body.model, 'gpt-5');
});

test('a stored local model that is no longer installed fails the job without falling back to OpenAI', async () => {
  fakeOllama.models = [{ name: 'qwen3:8b', capabilities: ['completion'] }];
  await restart({ provider: 'local', model: 'gemma3:4b' });
  const row = notesRow();
  assert.equal(row.status, 'error');
  assert.equal(
    row.error,
    'The model chosen for these notes (local:gemma3:4b) is no longer available: Model "gemma3:4b" is not an installed local chat model.'
  );
  assert.equal(fakeOpenAI.requests.length, 0);
  assert.equal(fakeOllama.chatRequests.length, 0);
  // The stored choice is kept, so the error names it again after the next restart
  assert.deepEqual([row.requested_provider, row.requested_model], ['local', 'gemma3:4b']);
});

test('a stored local model fails the job when Ollama is not running, without falling back to OpenAI', async () => {
  fakeOllama.unreachable = true;
  try {
    await restart({ provider: 'local', model: 'gemma3:4b' });
  } finally {
    fakeOllama.unreachable = false;
  }
  const row = notesRow();
  assert.equal(row.status, 'error');
  assert.equal(
    row.error,
    'The model chosen for these notes (local:gemma3:4b) is no longer available: The local model service (Ollama) is not reachable.'
  );
  assert.equal(fakeOpenAI.requests.length, 0);
});

test('a stored OpenAI choice fails the job when OpenAI is no longer allowed or the model was removed', async () => {
  process.env.ALLOW_EXTERNAL = 'false';
  await restart({ provider: 'openai', model: 'gpt-5' });
  let row = notesRow();
  assert.equal(row.status, 'error');
  assert.equal(
    row.error,
    'The model chosen for these notes (openai:gpt-5) is no longer available: The external provider (OpenAI) is disabled by ALLOW_EXTERNAL.'
  );

  process.env.ALLOW_EXTERNAL = 'true';
  process.env.OPENAI_MODELS = 'gpt-5-mini';
  await restart({ provider: 'openai', model: 'gpt-5' });
  row = notesRow();
  assert.equal(row.status, 'error');
  assert.equal(
    row.error,
    'The model chosen for these notes (openai:gpt-5) is no longer available: Model "gpt-5" is not an allowed OpenAI model.'
  );
  // Neither the local model nor another OpenAI model was used instead
  assert.equal(fakeOpenAI.requests.length, 0);
  assert.equal(fakeOllama.chatRequests.length, 0);
});

test('restored notes without a stored choice (requested before the update) fail with a clear error', async () => {
  await restart({ provider: null, model: null });
  const row = notesRow();
  assert.equal(row.status, 'error');
  assert.equal(
    row.error,
    'The provider and model chosen for these notes are not known (they were requested before an update). Generate them again.'
  );
  assert.equal(fakeOpenAI.requests.length, 0);
  assert.equal(fakeOllama.chatRequests.length, 0);
});
