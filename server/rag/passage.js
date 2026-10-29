import { getDb, parseJson } from '../db.js';

// Words of a text with the offset where each starts and ends
function wordsWithOffsets(text) {
  return Array.from(text.matchAll(/\S+/g), (match) => ({
    word: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

// Where a chunk is in the text of its material: { start, end } offsets, or null when it is not
// found. Chunks keep the words of the text in order but collapse the whitespace between them
// (see chunk.js), so the chunk is found as a run of words, not as a substring. Overlapping
// chunks share words, but only the cited chunk has all of its words in a row at its place.
export function locateChunk(content, chunkText, words = wordsWithOffsets(content)) {
  const target = chunkText.split(/\s+/).filter(Boolean);
  if (target.length === 0) return null;
  for (let i = 0; i + target.length <= words.length; i++) {
    let j = 0;
    while (j < target.length && words[i + j].word === target[j]) j++;
    if (j === target.length) {
      return { start: words[i].start, end: words[i + target.length - 1].end };
    }
  }
  return null;
}

// 1-based number of the PDF page that contains the offset, or null without page offsets
export function pageAt(pageOffsets, offset) {
  if (!Array.isArray(pageOffsets) || pageOffsets.length === 0) return null;
  let page = 1;
  for (let i = 1; i < pageOffsets.length; i++) {
    if (pageOffsets[i] <= offset) page = i + 1;
  }
  return page;
}

// Adds to every chunk ({ materialId, text, ... }) where it is in its material: start and end
// offsets in the material text and, for PDFs, the page where it starts. start, end and page are
// null when the chunk is not found or the material has no page offsets.
export function withPositions(chunks) {
  const db = getDb();
  const getMaterial = db.prepare('SELECT content, page_offsets FROM materials WHERE id = ?');
  const materials = new Map();
  return chunks.map((chunk) => {
    if (!materials.has(chunk.materialId)) {
      const row = getMaterial.get(chunk.materialId);
      materials.set(
        chunk.materialId,
        row && {
          content: row.content,
          words: wordsWithOffsets(row.content),
          pageOffsets: parseJson(row.page_offsets, null),
        }
      );
    }
    const material = materials.get(chunk.materialId);
    const position = material && locateChunk(material.content, chunk.text, material.words);
    return {
      ...chunk,
      start: position?.start ?? null,
      end: position?.end ?? null,
      page: position ? pageAt(material.pageOffsets, position.start) : null,
    };
  });
}
