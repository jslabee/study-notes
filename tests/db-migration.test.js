import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// A database as created before PDF import, when materials.type did not allow 'pdf'
const OLD_SCHEMA = `
CREATE TABLE courses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE materials (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text','txt','srt','vtt')),
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing','ready','error')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  material_id INTEGER NOT NULL UNIQUE REFERENCES materials(id) ON DELETE CASCADE,
  content TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing','ready','error')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL
);
`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-notes-migration-'));
process.env.DB_PATH = path.join(tmpDir, 'old.db');
process.env.EMBED_DIM = '8';

const old = new Database(process.env.DB_PATH);
old.exec(OLD_SCHEMA);
old.exec(`
  INSERT INTO courses (id, name) VALUES (1, 'Biology');
  INSERT INTO materials (id, course_id, title, type, content, status, error, created_at) VALUES
    (3, 1, 'Cells', 'txt', 'Cells are small.', 'ready', NULL, '2026-01-01 10:00:00'),
    (7, 1, 'Lecture', 'srt', 'Plants use light.', 'error', 'Failed.', '2026-01-02 11:00:00');
  INSERT INTO notes (material_id, content, model, status) VALUES (3, '# Cells', 'm', 'ready');
  INSERT INTO chunks (id, material_id, position, text) VALUES (5, 3, 0, 'Cells are small.');
`);
const before = old.prepare('SELECT * FROM materials ORDER BY id').all();
old.close();

const { getDb, closeDb } = await import('../server/db.js');
const db = getDb();
// Read before the tests below delete rows
const notesBefore = db
  .prepare('SELECT id, material_id, style, content, model, status, error FROM notes ORDER BY id')
  .all();
const requestedBefore = db.prepare('SELECT requested_provider, requested_model FROM notes ORDER BY id').all();

after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('migration keeps all existing materials unchanged', () => {
  // The only change is the new, empty PDF columns
  assert.deepEqual(
    db.prepare('SELECT * FROM materials ORDER BY id').all(),
    before.map((material) => ({ ...material, page_offsets: null, outline: null }))
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM notes').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM chunks').get().n, 1);
});

test('migrated table allows the pdf type and still rejects unknown types', () => {
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'materials'").get();
  assert.match(sql, /'pdf'/);
  db.prepare("INSERT INTO materials (course_id, title, type, content) VALUES (1, 'Book', 'pdf', 'x')").run();
  assert.throws(() =>
    db.prepare("INSERT INTO materials (course_id, title, type, content) VALUES (1, 'X', 'docx', 'x')").run()
  );
});

test('foreign keys are enforced and cascade after the migration', () => {
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.throws(() =>
    db.prepare("INSERT INTO notes (material_id, status) VALUES (999, 'ready')").run()
  );

  db.prepare('DELETE FROM materials WHERE id = 3').run();
  assert.equal(db.prepare('SELECT count(*) AS n FROM notes').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM chunks').get().n, 0);

  db.prepare('DELETE FROM courses WHERE id = 1').run();
  assert.equal(db.prepare('SELECT count(*) AS n FROM materials').get().n, 0);
});

test('existing notes are kept as style study-notes and styles are unique per material', () => {
  assert.deepEqual(notesBefore, [
    { id: 1, material_id: 3, style: 'study-notes', content: '# Cells', model: 'm', status: 'ready', error: null },
  ]);
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'notes'").get();
  assert.match(sql, /UNIQUE \(material_id, style\)/);
  // Rebuilt notes have no requested provider or model yet
  assert.deepEqual(requestedBefore, [{ requested_provider: null, requested_model: null }]);
});

// A database as created before the requested provider and model were stored
const BEFORE_REQUESTED_LLM_SCHEMA = `
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
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  page_offsets TEXT,
  outline TEXT
);
CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  style TEXT NOT NULL DEFAULT 'study-notes',
  content TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','ready','error')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  chapters TEXT,
  UNIQUE (material_id, style)
);
INSERT INTO courses (id, name) VALUES (1, 'Biology');
INSERT INTO materials (id, course_id, title, type, content, status) VALUES (4, 1, 'Cells', 'txt', 'Cells.', 'ready');
INSERT INTO notes (id, material_id, style, content, model, status, created_at, chapters) VALUES
  (2, 4, 'by-chapter', '## Overview', 'local:gemma3:4b', 'ready', '2026-10-01 09:00:00', '{"method":null,"chapters":[]}'),
  (5, 4, 'brief', NULL, NULL, 'processing', '2026-10-02 09:00:00', NULL);
`;

test('the requested provider and model columns are added to existing notes, keeping their data', () => {
  closeDb();
  const previousPath = process.env.DB_PATH;
  process.env.DB_PATH = path.join(tmpDir, 'before-requested-llm.db');
  const raw = new Database(process.env.DB_PATH);
  raw.exec(BEFORE_REQUESTED_LLM_SCHEMA);
  const rowsBefore = raw.prepare('SELECT * FROM notes ORDER BY id').all();
  raw.close();

  try {
    const migrated = getDb();
    assert.deepEqual(
      migrated.prepare('SELECT * FROM notes ORDER BY id').all(),
      rowsBefore.map((row) => ({ ...row, requested_provider: null, requested_model: null }))
    );
    // Opening it again changes nothing
    closeDb();
    assert.equal(getDb().prepare('SELECT count(*) AS n FROM notes').get().n, 2);
  } finally {
    closeDb();
    process.env.DB_PATH = previousPath;
  }
});

test('opening an already migrated database changes nothing', () => {
  closeDb();
  const again = getDb();
  assert.match(
    again.prepare("SELECT sql FROM sqlite_master WHERE name = 'materials'").get().sql,
    /'pdf'/
  );
  assert.equal(again.prepare("SELECT name FROM sqlite_master WHERE name = 'materials_new'").get(), undefined);
  assert.equal(again.prepare("SELECT name FROM sqlite_master WHERE name = 'notes_new'").get(), undefined);
});
