import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK_WORDS, OVERLAP_WORDS, chunkText, countWords } from '../server/rag/chunk.js';

// Sentences of varying length (8 to 22 words), each numbered so they can be found again
function makeSentences(count) {
  return Array.from({ length: count }, (_, i) => {
    const filler = 'cells store energy in molecules and use it later '.repeat(3).split(' ');
    const extra = filler.slice(0, 5 + (i % 15)).join(' ');
    return `Sentence ${i} says ${extra}.`;
  });
}

const words = (text) => text.split(/\s+/).filter(Boolean);

// Number of words at the end of a that are repeated at the start of b
function overlapWords(a, b) {
  const wa = words(a);
  const wb = words(b);
  for (let n = Math.min(wa.length, wb.length); n > 0; n--) {
    if (wa.slice(-n).join(' ') === wb.slice(0, n).join(' ')) return n;
  }
  return 0;
}

test('short text is one chunk; empty text gives no chunks', () => {
  assert.deepEqual(chunkText('One sentence. Two sentences.'), ['One sentence. Two sentences.']);
  assert.deepEqual(chunkText('   \n\n '), []);
});

test('chunks have about 400 words and never more', () => {
  const chunks = chunkText(makeSentences(600).join(' '));
  assert.ok(chunks.length > 10);
  chunks.forEach((chunk, i) => {
    const n = countWords(chunk);
    assert.ok(n <= CHUNK_WORDS, `chunk ${i} has ${n} words`);
    if (i < chunks.length - 1) assert.ok(n >= CHUNK_WORDS - 30, `chunk ${i} has only ${n} words`);
  });
});

test('consecutive chunks overlap by about 60 words', () => {
  const chunks = chunkText(makeSentences(600).join(' '));
  for (let i = 1; i < chunks.length; i++) {
    const n = overlapWords(chunks[i - 1], chunks[i]);
    assert.ok(n >= OVERLAP_WORDS - 25 && n <= OVERLAP_WORDS + 25, `overlap ${i} is ${n} words`);
  }
});

test('chunks start and end at sentence boundaries', () => {
  const sentences = makeSentences(600);
  const chunks = chunkText(sentences.join(' '));
  for (const chunk of chunks) {
    assert.match(chunk, /^Sentence \d+ says /);
    assert.match(chunk, /\.$/);
  }
});

test('every sentence is in a chunk and the order is kept', () => {
  const sentences = makeSentences(600);
  const chunks = chunkText(sentences.join('\n\n'));
  const seen = chunks.flatMap((chunk) => [...chunk.matchAll(/Sentence (\d+) says/g)].map((m) => Number(m[1])));
  const unique = [...new Set(seen)];
  assert.deepEqual(unique, sentences.map((_, i) => i));
});

test('paragraph breaks end a sentence even without punctuation', () => {
  const text = `${'Heading without a period'}\n\n${makeSentences(200).join(' ')}`;
  const chunks = chunkText(text);
  assert.ok(chunks[0].startsWith('Heading without a period Sentence 0 says'));
  assert.match(chunks[1], /^Sentence \d+ says /);
});

test('text without punctuation is still chunked with overlap and no lost words', () => {
  const text = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(' ');
  const chunks = chunkText(text);
  assert.ok(chunks.length > 5);
  for (const chunk of chunks) assert.ok(countWords(chunk) <= CHUNK_WORDS);
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(overlapWords(chunks[i - 1], chunks[i]), OVERLAP_WORDS);
  }
  const all = new Set(chunks.flatMap(words));
  assert.equal(all.size, 3000);
});
