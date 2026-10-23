import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS materials (
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
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  material_id INTEGER NOT NULL UNIQUE REFERENCES materials(id) ON DELETE CASCADE,
  content TEXT,                     -- Markdown
  model TEXT,
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing','ready','error')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL
);
`;

let db = null;

// Opens the database on first use, so modules can be imported without DB_PATH
export function getDb() {
  if (db) return db;

  const dbPath = process.env.DB_PATH;
  if (!dbPath) throw new Error('DB_PATH is not set.');
  const embedDim = Number(process.env.EMBED_DIM || 1024);

  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  db = new Database(dbPath);
  sqliteVec.load(db);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // one vector per chunk; rowid = chunks.id
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(embedding float[${embedDim}]);`
  );
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
