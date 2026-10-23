import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { convertToText, NO_TEXT_ERROR } from '../server/materials/convert.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('SRT: removes sequence numbers and timestamps, keeps spoken text', () => {
  const text = convertToText(fixture('sample.srt'), 'srt');
  assert.equal(
    text,
    'Welcome to the lecture on photosynthesis. Plants turn light into chemical energy. 42 That is the answer.'
  );
  assert.doesNotMatch(text, /-->/);
});

test('VTT: removes header, notes, cue ids, timestamps and tags', () => {
  const text = convertToText(fixture('sample.vtt'), 'vtt');
  assert.equal(
    text,
    'Welcome to the lecture on photosynthesis. Plants turn light into chemical energy. ' +
      'Chlorophyll absorbs mostly red and blue light.'
  );
});

test('SRT with Windows line endings gives the same result', () => {
  const crlf = fixture('sample.srt').replace(/\r?\n/g, '\r\n');
  assert.equal(convertToText(crlf, 'srt'), convertToText(fixture('sample.srt'), 'srt'));
});

test('long subtitles are merged into paragraphs at sentence ends', () => {
  const sentence = 'This sentence is part of a long lecture about cells and energy.';
  const srt = Array.from(
    { length: 20 },
    (_, i) => `${i + 1}\n00:00:${String(i).padStart(2, '0')},000 --> 00:00:${String(i).padStart(2, '0')},900\n${sentence}\n`
  ).join('\n');
  const paragraphs = convertToText(srt, 'srt').split('\n\n');
  assert.ok(paragraphs.length > 1);
  for (const paragraph of paragraphs) assert.match(paragraph, /\.$/);
});

test('txt and text are returned unchanged', () => {
  const input = 'Line one.\n\n\nLine two.  ';
  assert.equal(convertToText(input, 'txt'), input);
  assert.equal(convertToText(input, 'text'), input);
});

test('empty result throws the exact error message', () => {
  assert.throws(() => convertToText('   \n\n', 'text'), { message: NO_TEXT_ERROR });
  assert.throws(() => convertToText('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n', 'vtt'), {
    message: 'The file contains no readable text.',
  });
});
