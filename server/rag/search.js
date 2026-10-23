import { getDb } from '../db.js';
import { embed as llmEmbed } from '../llm.js';

export const RESULT_COUNT = 6;
export const COURSE_CANDIDATES = 30;

// Finds the chunks most similar to the question, only from ready materials.
// With a courseId, the 30 nearest chunks are searched and the first 6 from that course kept.
// embed is replaceable so tests do not need Ollama.
export async function searchChunks(question, { courseId, embed = llmEmbed } = {}) {
  const [vector] = await embed([question]);
  const filterByCourse = courseId !== undefined && courseId !== null;
  const k = filterByCourse ? COURSE_CANDIDATES : RESULT_COUNT;

  const rows = getDb()
    .prepare(
      `SELECT c.id AS chunkId, c.material_id AS materialId, m.course_id AS courseId,
              m.title, c.text, v.distance
       FROM (
         SELECT rowid, distance FROM chunk_vectors
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance
       ) v
       JOIN chunks c ON c.id = v.rowid
       JOIN materials m ON m.id = c.material_id
       WHERE m.status = 'ready'
       ORDER BY v.distance`
    )
    .all(vector, k);

  return rows
    .filter((row) => !filterByCourse || row.courseId === courseId)
    .slice(0, RESULT_COUNT)
    .map(({ chunkId, materialId, title, text, distance }) => ({
      chunkId,
      materialId,
      title,
      text,
      distance,
    }));
}
