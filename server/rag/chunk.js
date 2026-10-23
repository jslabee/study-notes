export const CHUNK_WORDS = 400;
export const OVERLAP_WORDS = 60;

export const countWords = (text) => text.split(/\s+/).filter(Boolean).length;

// Splits text into sentences; paragraph breaks also end a sentence
export function splitSentences(text) {
  return text
    .split(/\n\s*\n|(?<=[.!?]["')\]]?)\s+/)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// A sentence longer than a chunk (e.g. a transcript without punctuation) is split into
// pieces of OVERLAP_WORDS words, so chunks still stay near the size and can overlap
function toUnits(text, size, overlap) {
  const units = [];
  for (const sentence of splitSentences(text)) {
    const words = sentence.split(' ');
    if (words.length <= size) {
      units.push({ text: sentence, words: words.length });
      continue;
    }
    for (let i = 0; i < words.length; i += overlap) {
      const piece = words.slice(i, i + overlap);
      units.push({ text: piece.join(' '), words: piece.length });
    }
  }
  return units;
}

// Last units of a chunk that together have about `overlap` words; the first unit is
// never included, so every new chunk moves forward in the text
function overlapUnits(chunk, overlap) {
  const result = [];
  let words = 0;
  for (let i = chunk.length - 1; i > 0 && words < overlap; i--) {
    if (words + chunk[i].words > overlap * 2) break;
    result.unshift(chunk[i]);
    words += chunk[i].words;
  }
  return result;
}

// Splits text into chunks of about `size` words that end at sentence ends and
// overlap by about `overlap` words
export function chunkText(text, { size = CHUNK_WORDS, overlap = OVERLAP_WORDS } = {}) {
  const units = toUnits(text, size, overlap);
  const chunks = [];
  let current = [];
  let currentWords = 0;
  let newWords = 0;

  for (const unit of units) {
    if (newWords > 0 && currentWords + unit.words > size) {
      chunks.push(current);
      current = overlapUnits(current, overlap);
      currentWords = current.reduce((sum, u) => sum + u.words, 0);
      newWords = 0;
      // Shorten the overlap if it would push the new chunk over the size
      while (current.length > 0 && currentWords + unit.words > size) {
        currentWords -= current.shift().words;
      }
    }
    current.push(unit);
    currentWords += unit.words;
    newWords += unit.words;
  }
  if (newWords > 0) chunks.push(current);

  return chunks.map((chunk) => chunk.map((unit) => unit.text).join(' '));
}
