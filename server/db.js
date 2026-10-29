import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';

const MATERIALS_COLUMNS = `
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text','txt','srt','vtt','pdf')),
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing','ready','error')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  page_offsets TEXT,                -- PDF only: JSON array, offset in content where each page starts
  outline TEXT                      -- PDF only: JSON [{ title, start }] of top-level bookmarks
`;

// A material has notes in several styles, at most one row per style. Ids are never reused, so
// a job for deleted notes can never write into notes created after them.
const NOTES_COLUMNS = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  style TEXT NOT NULL DEFAULT 'study-notes',
  content TEXT,                     -- Markdown
  model TEXT,                       -- "<provider>:<model>"
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing','ready','error')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  chapters TEXT,                    -- by-chapter: JSON { method, chapters: [{ title, start }] }
  requested_provider TEXT,          -- provider (local | openai) and model resolved for the last
  requested_model TEXT,             -- request; a job restored after a restart uses exactly these
  UNIQUE (material_id, style)
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS materials (${MATERIALS_COLUMNS});
CREATE TABLE IF NOT EXISTS notes (${NOTES_COLUMNS});
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
  migrateMaterialsType(db);
  migrateNotesStyle(db);
  migrateChapterColumns(db);
  migrateRequestedLlmColumns(db);
  createVectorTable(db, embedDim);
  return db;
}

// One vector per chunk; rowid = chunks.id. material_id is a metadata column of the vec0 table, so
// search can keep only the chunks of allowed materials inside the nearest-neighbor query.
const vectorTableSql = (name, dim) =>
  `CREATE VIRTUAL TABLE ${name} USING vec0(embedding float[${dim}], material_id integer)`;

function createVectorTable(db, embedDim) {
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chunk_vectors'").get();
  if (!existing) db.exec(vectorTableSql('chunk_vectors', embedDim));
  else if (!/\bmaterial_id\b/.test(existing.sql)) migrateVectorMaterialIds(db, existing.sql);
}

// Databases created before search filtered by material have vectors without material_id. A vec0
// table cannot get a new column, so the table is recreated and the vectors are copied back with
// the material of their chunk, keeping their rowids and their dimension; nothing is embedded
// again. Vectors without a chunk could never be found by search and are not copied. The copy goes
// through an ordinary table because renaming a vec0 table does not rename its shadow tables.
function migrateVectorMaterialIds(db, sql) {
  const dim = Number(sql.match(/float\[(\d+)\]/)[1]);
  db.transaction(() => {
    db.exec(`CREATE TEMP TABLE chunk_vectors_copy AS
      SELECT v.rowid AS id, v.embedding, c.material_id FROM chunk_vectors v JOIN chunks c ON c.id = v.rowid`);
    db.exec('DROP TABLE chunk_vectors');
    db.exec(vectorTableSql('chunk_vectors', dim));
    db.exec(`INSERT INTO chunk_vectors (rowid, embedding, material_id)
      SELECT id, embedding, material_id FROM chunk_vectors_copy`);
    db.exec('DROP TABLE chunk_vectors_copy');
  })();
}

// Databases created before PDF import do not allow type 'pdf'. SQLite cannot alter a CHECK
// constraint, so the table is rebuilt with foreign keys off (otherwise dropping it would
// cascade to notes and chunks); the row ids stay the same, so all references stay valid.
function migrateMaterialsType(db) {
  const { sql } = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'materials'")
    .get();
  if (sql.includes("'pdf'")) return;

  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`CREATE TABLE materials_new (${MATERIALS_COLUMNS});
        INSERT INTO materials_new (id, course_id, title, type, content, status, error, created_at)
          SELECT id, course_id, title, type, content, status, error, created_at FROM materials;
        DROP TABLE materials;
        ALTER TABLE materials_new RENAME TO materials;`);
      if (db.pragma('foreign_key_check').length > 0) {
        throw new Error('Migration of the materials table broke foreign keys.');
      }
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

// Databases created before note styles have one notes row per material (UNIQUE material_id).
// The table is rebuilt with the style column and UNIQUE (material_id, style); existing notes
// keep their ids and become style 'study-notes'. No table references notes, so foreign keys
// can stay on.
function migrateNotesStyle(db) {
  const columns = db.pragma('table_info(notes)').map((column) => column.name);
  if (columns.includes('style')) return;

  db.transaction(() => {
    db.exec(`CREATE TABLE notes_new (${NOTES_COLUMNS});
      INSERT INTO notes_new (id, material_id, style, content, model, status, error, created_at)
        SELECT id, material_id, 'study-notes', content, model, status, error, created_at FROM notes;
      DROP TABLE notes;
      ALTER TABLE notes_new RENAME TO notes;`);
  })();
}

// Databases created before the by-chapter style have no PDF page offsets, PDF outline or
// detected chapters. The columns are added empty: PDFs imported before have no pages or outline,
// so chapter detection skips the PDF outline for them.
function migrateChapterColumns(db) {
  addTextColumn(db, 'materials', 'page_offsets');
  addTextColumn(db, 'materials', 'outline');
  addTextColumn(db, 'notes', 'chapters');
}

// Databases created before the requested provider was stored have no columns for it. They are
// added empty; notes that were still processing then have no stored choice, and a restored job
// for them fails instead of guessing a provider.
function migrateRequestedLlmColumns(db) {
  addTextColumn(db, 'notes', 'requested_provider');
  addTextColumn(db, 'notes', 'requested_model');
}

// Adds an empty TEXT column when the table does not have it yet; existing rows keep their data
function addTextColumn(db, table, column) {
  const columns = db.pragma(`table_info(${table})`).map((info) => info.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
}

// The value of a JSON column (e.g. materials.outline, notes.chapters), or fallback when it is
// empty or not valid JSON; an invalid value is logged instead of failing the request or job
export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch (err) {
    console.warn(`[db] Ignoring a stored value that is not valid JSON: ${err.message}`);
    return fallback;
  }
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
