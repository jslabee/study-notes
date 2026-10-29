import { getDb } from '../db.js';
import { embed as llmEmbed } from '../llm.js';

export const RESULT_COUNT = 6;

// The materials whose chunks may be found: ready materials, only of the course when a courseId is
// given and only the listed ones when materialIds is a non-empty list
function allowedMaterialIds(db, { courseId, materialIds }) {
  const byCourse = courseId !== undefined && courseId !== null;
  const ids = db
    .prepare(`SELECT id FROM materials WHERE status = 'ready'${byCourse ? ' AND course_id = ?' : ''}`)
    .pluck()
    .all(...(byCourse ? [courseId] : []));
  if (!materialIds?.length) return ids;
  const selected = new Set(materialIds);
  return ids.filter((id) => selected.has(id));
}

// Finds the 6 chunks most similar to the question among the chunks of the allowed materials (see
// allowedMaterialIds). The material filter is part of the nearest-neighbor query (material_id is
// a metadata column of chunk_vectors), so closer chunks of other materials never take the places
// of allowed ones.
// embed is replaceable so tests do not need Ollama.
export async function searchChunks(question, { courseId, materialIds, embed = llmEmbed } = {}) {
  const [vector] = await embed([question]);
  // Read after the embedding, so the statuses are current when the query runs
  const db = getDb();
  const allowed = allowedMaterialIds(db, { courseId, materialIds });
  if (allowed.length === 0) return [];

  return db
    .prepare(
      `SELECT c.id AS chunkId, c.material_id AS materialId, m.title, c.text, v.distance
       FROM (
         SELECT rowid, distance FROM chunk_vectors
         WHERE embedding MATCH ? AND k = ?
           AND material_id IN (SELECT value FROM json_each(?))
         ORDER BY distance
       ) v
       JOIN chunks c ON c.id = v.rowid
       JOIN materials m ON m.id = c.material_id
       ORDER BY v.distance`
    )
    .all(vector, RESULT_COUNT, JSON.stringify(allowed));
}
