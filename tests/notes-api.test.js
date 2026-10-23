import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Temporary database, and no API key so the notes job can never call OpenAI
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-notes-notes-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
delete process.env.OPENAI_API_KEY;
process.env.OPENAI_MODEL = 'test-model';

const { app } = await import('../server/index.js');
const { getDb, closeDb } = await import('../server/db.js');
const { whenIdle, restoreJobs } = await import('../server/jobs.js');

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

after(() => {
  server.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('GET notes returns 404 before notes are generated', async () => {
  const res = await fetch(`${baseUrl}/api/materials/${materialId}/notes`);
  assert.equal(res.status, 404);
  assert.equal(typeof (await res.json()).error, 'string');
});

test('POST notes for an unknown material returns 404', async () => {
  const res = await fetch(`${baseUrl}/api/materials/9999/notes`, { method: 'POST' });
  assert.equal(res.status, 404);
});

test('POST notes starts a job; a failure is saved in the error field', async () => {
  const res = await fetch(`${baseUrl}/api/materials/${materialId}/notes`, { method: 'POST' });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { status: 'processing' });

  await whenIdle();

  const notes = await (await fetch(`${baseUrl}/api/materials/${materialId}/notes`)).json();
  assert.deepEqual(Object.keys(notes).sort(), ['content', 'createdAt', 'error', 'model', 'status']);
  assert.equal(notes.status, 'error');
  assert.equal(notes.error, 'OpenAI API key is missing. Set OPENAI_API_KEY in .env.');
});

test('regenerating replaces saved notes and runs the job again', async () => {
  const db = getDb();
  db.prepare("UPDATE notes SET status = 'ready', content = '## Summary', model = 'm', error = NULL WHERE material_id = ?").run(materialId);

  const res = await fetch(`${baseUrl}/api/materials/${materialId}/notes`, { method: 'POST' });
  assert.equal(res.status, 202);
  await whenIdle();

  // Without an API key the new job fails, and the old notes are not kept
  const row = db.prepare('SELECT status, content, model, error FROM notes WHERE material_id = ?').get(materialId);
  assert.equal(row.status, 'error');
  assert.equal(row.content, null);
  assert.equal(row.model, null);
  assert.match(row.error, /API key is missing/);
});

test('POST notes while notes are processing does not reset them', async () => {
  const db = getDb();
  db.prepare("UPDATE notes SET status = 'processing', content = 'partial', error = NULL WHERE material_id = ?").run(materialId);
  const res = await fetch(`${baseUrl}/api/materials/${materialId}/notes`, { method: 'POST' });
  assert.equal(res.status, 202);
  assert.equal(db.prepare('SELECT content FROM notes WHERE material_id = ?').get(materialId).content, 'partial');
});

test('notes that were processing are queued again on restore', async () => {
  const db = getDb();
  db.prepare("UPDATE notes SET status = 'processing', error = NULL WHERE material_id = ?").run(materialId);
  restoreJobs();
  await whenIdle();
  const row = db.prepare('SELECT status FROM notes WHERE material_id = ?').get(materialId);
  assert.equal(row.status, 'error');
});

test('material list reports hasNotes only for ready notes', async () => {
  const list = async () => (await (await fetch(`${baseUrl}/api/materials`)).json())[0].hasNotes;
  assert.equal(await list(), false);
  getDb().prepare("UPDATE notes SET status = 'ready', content = 'x' WHERE material_id = ?").run(materialId);
  assert.equal(await list(), true);
});
