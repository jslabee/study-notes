import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFakeOllama } from './helpers/fake-ollama.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-notes-index-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
const fake = installFakeOllama({ dim: 8 });

const { app } = await import('../server/index.js');
const { getDb, closeDb } = await import('../server/db.js');
const { whenIdle } = await import('../server/jobs.js');
const { indexMaterial } = await import('../server/rag/index.js');
const { chunkText } = await import('../server/rag/chunk.js');
const { setRetryDelays } = await import('../server/llm.js');

let server;
let baseUrl;
let courseId;

const sentence = (i) => `Fact number ${i} explains how plant cells turn light into stored chemical energy.`;
const longText = Array.from({ length: 300 }, (_, i) => sentence(i)).join(' ');

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  courseId = getDb().prepare("INSERT INTO courses (name) VALUES ('Biology')").run().lastInsertRowid;
});

after(() => {
  server.close();
  closeDb();
  fake.restore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function uploadText(title, text) {
  const form = new FormData();
  form.append('courseId', courseId);
  form.append('title', title);
  form.append('text', text);
  const res = await fetch(`${baseUrl}/api/materials`, { method: 'POST', body: form });
  assert.equal(res.status, 202);
  return (await res.json()).id;
}

const counts = (db, id) => ({
  chunks: db.prepare('SELECT count(*) AS n FROM chunks WHERE material_id = ?').get(id).n,
  vectors: db
    .prepare('SELECT count(*) AS n FROM chunk_vectors WHERE rowid IN (SELECT id FROM chunks WHERE material_id = ?)')
    .get(id).n,
});

test('new material is indexed: chunks and vectors are stored and it becomes ready', async () => {
  const id = await uploadText('Photosynthesis', longText);
  await whenIdle();

  const material = await (await fetch(`${baseUrl}/api/materials/${id}`)).json();
  const expected = chunkText(longText);
  assert.equal(material.status, 'ready');
  assert.equal(material.chunkCount, expected.length);
  assert.ok(material.chunkCount > 1);

  const db = getDb();
  const rows = db.prepare('SELECT id, position, text FROM chunks WHERE material_id = ? ORDER BY position').all(id);
  assert.deepEqual(rows.map((r) => r.text), expected);
  assert.deepEqual(rows.map((r) => r.position), expected.map((_, i) => i));

  // rowid of every vector is the id of its chunk, it stores the material for filtered search,
  // and vectors are unit length
  for (const row of rows) {
    const vector = db.prepare('SELECT embedding, material_id FROM chunk_vectors WHERE rowid = ?').get(BigInt(row.id));
    assert.ok(vector, `vector for chunk ${row.id}`);
    assert.equal(vector.material_id, id);
    const values = new Float32Array(vector.embedding.buffer, vector.embedding.byteOffset, 8);
    const length = Math.sqrt(values.reduce((sum, x) => sum + x * x, 0));
    assert.ok(Math.abs(length - 1) < 1e-5);
  }
});

test('reindexing replaces the old chunks and vectors', async () => {
  const id = await uploadText('Reindexed', longText);
  await whenIdle();
  const db = getDb();
  const before = counts(db, id);

  await indexMaterial(id);
  assert.deepEqual(counts(db, id), before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM chunks').get().n, db.prepare('SELECT count(*) AS n FROM chunk_vectors').get().n);
});

test('deleting a material removes its chunks and vectors but not those of others', async () => {
  const keepId = await uploadText('Keep', longText);
  const deleteId = await uploadText('Delete', longText);
  await whenIdle();
  const db = getDb();
  const keepBefore = counts(db, keepId);
  const chunkIds = db.prepare('SELECT id FROM chunks WHERE material_id = ?').all(deleteId).map((r) => r.id);
  assert.ok(chunkIds.length > 0);

  const res = await fetch(`${baseUrl}/api/materials/${deleteId}`, { method: 'DELETE' });
  assert.deepEqual(await res.json(), { deleted: true });

  assert.deepEqual(counts(db, deleteId), { chunks: 0, vectors: 0 });
  for (const chunkId of chunkIds) {
    assert.equal(db.prepare('SELECT count(*) AS n FROM chunk_vectors WHERE rowid = ?').get(BigInt(chunkId)).n, 0);
  }
  assert.deepEqual(counts(db, keepId), keepBefore);
});

test('unreachable Ollama sets status error with the exact message', async () => {
  // The embedding request is retried first; shorter delays keep the test fast
  setRetryDelays({ baseMs: 1, rateLimitMs: 1 });
  fake.unreachable = true;
  fake.unreachableCalls = 0;
  try {
    const id = await uploadText('Offline', 'Some text about cells.');
    await whenIdle();
    const material = await (await fetch(`${baseUrl}/api/materials/${id}`)).json();
    assert.equal(material.status, 'error');
    assert.equal(material.error, 'Embedding service (Ollama) is not reachable.');
    assert.equal(material.chunkCount, 0);
    assert.equal(fake.unreachableCalls, 4);
  } finally {
    fake.unreachable = false;
    setRetryDelays();
  }
});

test('a transient Ollama error during indexing is retried and the material becomes ready', async () => {
  setRetryDelays({ baseMs: 1, rateLimitMs: 1 });
  fake.embedErrors = [500];
  try {
    const id = await uploadText('Retried', longText);
    await whenIdle();
    const material = await (await fetch(`${baseUrl}/api/materials/${id}`)).json();
    assert.equal(material.status, 'ready');
    assert.equal(material.chunkCount, chunkText(longText).length);
    assert.deepEqual(fake.embedErrors, []);
  } finally {
    fake.embedErrors = [];
    setRetryDelays();
  }
});

test('indexing a material deleted in the meantime stores nothing', async () => {
  const db = getDb();
  const id = db
    .prepare("INSERT INTO materials (course_id, title, type, content, status) VALUES (?, 'Gone', 'text', 'Text.', 'ready')")
    .run(courseId).lastInsertRowid;
  const result = await indexMaterial(id, {
    embed: async (texts) => {
      db.prepare('DELETE FROM materials WHERE id = ?').run(id);
      return texts.map(() => new Float32Array(8).fill(0.5));
    },
  });
  assert.equal(result, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM chunks WHERE material_id = ?').get(id).n, 0);
});
