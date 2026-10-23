import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, sameTitle } from '../eval/titles.js';

test('unnumbered titles match exactly, ignoring case and surrounding spaces', () => {
  assert.ok(sameTitle('Photosynthesis', 'Photosynthesis'));
  assert.ok(sameTitle('  photosynthesis ', 'PHOTOSYNTHESIS'));
  assert.ok(!sameTitle('Photosynthesis', 'Cell biology'));
});

test('a leading numbering prefix is ignored on either side', () => {
  assert.ok(sameTitle('2. Cell biology', 'Cell biology'));
  assert.ok(sameTitle('Roman Republic', '3. Roman Republic'));
  assert.ok(sameTitle('3) Roman Republic', '3. roman republic'));
  assert.ok(sameTitle('12. Cell biology', '2. Cell biology'));
  assert.ok(!sameTitle('2. Cell biology', 'Roman Republic'));
});

test('numbers that are not a numbering prefix are kept', () => {
  assert.equal(normalizeTitle('1984'), '1984');
  assert.equal(normalizeTitle('2nd lecture'), '2nd lecture');
  assert.equal(normalizeTitle('3.5 Energy'), '3.5 energy');
  assert.equal(normalizeTitle('Chapter 2. Cells'), 'chapter 2. cells');
  assert.ok(!sameTitle('1984', '84'));
});
