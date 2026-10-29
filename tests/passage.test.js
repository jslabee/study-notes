import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateChunk, pageAt } from '../server/rag/passage.js';
import { chunkText } from '../server/rag/chunk.js';

test('a chunk is found by its words although its whitespace was collapsed', () => {
  const content = 'Intro line.\n\nPlants   use\nlight.  They make sugar.\n\nEnd.';
  const position = locateChunk(content, 'Plants use light. They make sugar.');
  assert.deepEqual(position, { start: content.indexOf('Plants'), end: content.indexOf('sugar.') + 'sugar.'.length });
});

test('every chunk of a long text is located at its own place, also with overlap', () => {
  const sentences = Array.from({ length: 300 }, (_, i) => `Sentence number ${i} talks about topic ${i % 7}.`);
  const text = sentences.join('\n  ');
  const chunks = chunkText(text, { size: 50, overlap: 10 });
  assert.ok(chunks.length > 5);
  let previousStart = -1;
  for (const chunk of chunks) {
    const position = locateChunk(text, chunk);
    assert.ok(position, chunk.slice(0, 40));
    assert.equal(text.slice(position.start, position.end).replace(/\s+/g, ' '), chunk);
    assert.ok(position.start > previousStart);
    previousStart = position.start;
  }
});

test('a chunk that is not in the text has no position', () => {
  assert.equal(locateChunk('Some other text.', 'Missing words.'), null);
  assert.equal(locateChunk('Some text.', ''), null);
});

test('pageAt returns the 1-based page that contains the offset', () => {
  const offsets = [0, 100, 250];
  assert.equal(pageAt(offsets, 0), 1);
  assert.equal(pageAt(offsets, 99), 1);
  assert.equal(pageAt(offsets, 100), 2);
  assert.equal(pageAt(offsets, 400), 3);
  assert.equal(pageAt(null, 10), null);
  assert.equal(pageAt([], 10), null);
});
