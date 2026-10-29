import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

// A database as created before search filtered by material: chunk_vectors has no material_id
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-notes-vectors-'));
process.env.DB_PATH = path.join(tmpDir, 'old.db');
process.env.EMBED_DIM = '8';

const unit = (index) => {
  const v = new Float32Array(8);
  v[index] = 1;
  return v;
};

const old = new Database(process.env.DB_PATH);
sqliteVec.load(old);
old.exec(`
  CREATE TABLE courses (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE materials (
    id INTEGER PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('text','txt','srt','vtt','pdf')),
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','ready','error')),
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE chunks (
    id INTEGER PRIMARY KEY,
    material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    text TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE chunk_vectors USING vec0(embedding float[8]);
  INSERT INTO courses (id, name) VALUES (1, 'Biology');
  INSERT INTO materials (id, course_id, title, type, content, status) VALUES
    (3, 1, 'Cells', 'txt', 'x', 'ready'),
    (7, 1, 'Plants', 'txt', 'x', 'ready');
  INSERT INTO chunks (id, material_id, position, text) VALUES
    (11, 3, 0, 'Cells are small.'),
    (12, 7, 0, 'Plants use light.'),
    (13, 7, 1, 'Leaves are green.');
`);
const insertOld = old.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)');
insertOld.run(11n, unit(0));
insertOld.run(12n, unit(1));
insertOld.run(13n, unit(2));
insertOld.run(99n, unit(0)); // a vector without a chunk
const embeddingsBefore = Object.fromEntries(
  old.prepare('SELECT rowid, embedding FROM chunk_vectors').all().map((r) => [r.rowid, r.embedding])
);
old.close();

const { getDb, closeDb } = await import('../server/db.js');
const { searchChunks } = await import('../server/rag/search.js');

after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const vectorRows = (db) =>
  db.prepare('SELECT rowid, embedding, material_id FROM chunk_vectors ORDER BY rowid').all();

test('existing vectors get the material of their chunk and keep their rowids and embeddings', () => {
  const db = getDb();
  assert.match(
    db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chunk_vectors'").get().sql,
    /float\[8\], material_id integer/
  );
  const rows = vectorRows(db);
  assert.deepEqual(
    rows.map((r) => [r.rowid, r.material_id]),
    [
      [11, 3],
      [12, 7],
      [13, 7],
    ]
  );
  for (const row of rows) assert.deepEqual(row.embedding, embeddingsBefore[row.rowid]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_temp_master WHERE name = 'chunk_vectors_copy'").get().n, 0);
});

test('search filters the migrated vectors by material', async () => {
  // The question is nearest to chunk 11 of material 3, but only material 7 is selected
  const embed = async () => [unit(0)];
  const results = await searchChunks('question', { materialIds: [7], embed });
  assert.deepEqual(results.map((r) => r.chunkId).sort(), [12, 13]);
  assert.deepEqual((await searchChunks('question', { embed }))[0].chunkId, 11);
});

test('opening the migrated database again changes nothing', () => {
  const before = vectorRows(getDb());
  closeDb();
  assert.deepEqual(vectorRows(getDb()), before);
});
