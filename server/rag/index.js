import { getDb } from '../db.js';
import { embed as llmEmbed } from '../llm.js';
import { chunkText } from './chunk.js';

// chunk_vectors has no foreign keys, so vectors are deleted before their chunks
export function deleteChunks(materialId) {
  const db = getDb();
  db.prepare(
    'DELETE FROM chunk_vectors WHERE rowid IN (SELECT id FROM chunks WHERE material_id = ?)'
  ).run(materialId);
  db.prepare('DELETE FROM chunks WHERE material_id = ?').run(materialId);
}

// Splits a material into chunks, stores them with their vectors and marks it ready.
// embed is replaceable so tests do not need Ollama. Returns the number of chunks.
export async function indexMaterial(materialId, { embed = llmEmbed } = {}) {
  const db = getDb();
  const material = db.prepare('SELECT content FROM materials WHERE id = ?').get(materialId);
  if (!material) return 0;

  const chunks = chunkText(material.content);
  const vectors = await embed(chunks);

  const insertChunk = db.prepare(
    'INSERT INTO chunks (material_id, position, text) VALUES (?, ?, ?)'
  );
  // The material is stored with each vector, so search can filter by it (see search.js)
  const insertVector = db.prepare(
    'INSERT INTO chunk_vectors (rowid, embedding, material_id) VALUES (?, ?, ?)'
  );

  const save = db.transaction(() => {
    // The material may have been deleted while embeddings were computed
    if (!db.prepare('SELECT 1 FROM materials WHERE id = ?').get(materialId)) return 0;

    deleteChunks(materialId);
    chunks.forEach((text, position) => {
      const chunkId = insertChunk.run(materialId, position, text).lastInsertRowid;
      insertVector.run(BigInt(chunkId), vectors[position], BigInt(materialId));
    });
    db.prepare("UPDATE materials SET status = 'ready', error = NULL WHERE id = ?").run(
      materialId
    );
    return chunks.length;
  });
  return save();
}
