import { getDb } from '../db.js';
import { deleteChunks } from '../rag/index.js';

const LIST_COLUMNS = `
  m.id, m.course_id AS courseId, m.title, m.type, length(m.content) AS chars,
  m.status, EXISTS (
    SELECT 1 FROM notes n WHERE n.material_id = m.id AND n.status = 'ready'
  ) AS hasNotes,
  m.created_at AS createdAt
`;

export function listMaterials(courseId) {
  const db = getDb();
  const rows =
    courseId === undefined
      ? db.prepare(`SELECT ${LIST_COLUMNS} FROM materials m ORDER BY m.id DESC`).all()
      : db
          .prepare(
            `SELECT ${LIST_COLUMNS} FROM materials m WHERE m.course_id = ? ORDER BY m.id DESC`
          )
          .all(courseId);
  return rows.map((row) => ({ ...row, hasNotes: row.hasNotes === 1 }));
}

export function getMaterial(id) {
  return getDb()
    .prepare(
      `SELECT m.id, m.course_id AS courseId, m.title, m.type, m.content,
              length(m.content) AS chars, m.status, m.error, m.created_at AS createdAt,
              (SELECT count(*) FROM chunks c WHERE c.material_id = m.id) AS chunkCount
       FROM materials m WHERE m.id = ?`
    )
    .get(id);
}

export function createMaterial({ courseId, title, type, content }) {
  const result = getDb()
    .prepare('INSERT INTO materials (course_id, title, type, content) VALUES (?, ?, ?, ?)')
    .run(courseId, title, type, content);
  return Number(result.lastInsertRowid);
}

// Vectors are deleted first, then chunks, then the material (notes follow by cascade)
export function deleteMaterial(id) {
  const db = getDb();
  const remove = db.transaction(() => {
    deleteChunks(id);
    return db.prepare('DELETE FROM materials WHERE id = ?').run(id).changes > 0;
  });
  return remove();
}
