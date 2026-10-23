const TIMESTAMP_LINE = /-->/;
const SENTENCE_END = /[.!?]["')\]]?$/;
// A subtitle paragraph is closed at the first sentence end after this many characters
const MIN_PARAGRAPH_CHARS = 500;

export const NO_TEXT_ERROR = 'The file contains no readable text.';

// Converts raw material input into clean text according to its type
export function convertToText(raw, type) {
  const text = String(raw ?? '').replace(/^﻿/, '');

  let result;
  if (type === 'txt' || type === 'text') {
    result = text;
  } else if (type === 'srt' || type === 'vtt') {
    result = subtitlesToText(text);
  } else {
    throw new Error(`Unknown material type: ${type}`);
  }

  if (!result.trim()) throw new Error(NO_TEXT_ERROR);
  return result;
}

function subtitlesToText(input) {
  const blocks = input.replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    // WEBVTT header and VTT metadata blocks contain no spoken text
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0])) continue;

    // Everything up to and including the timestamp line is a sequence number or cue id
    const timestampIndex = lines.findIndex((line) => TIMESTAMP_LINE.test(line));
    const textLines = lines.slice(timestampIndex + 1);

    const cue = textLines
      .map((line) => line.replace(/<[^>]*>/g, ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cue) cues.push(cue);
  }

  // Merge cues into paragraphs that end at a sentence boundary
  const paragraphs = [];
  let current = '';
  for (const cue of cues) {
    current = current ? `${current} ${cue}` : cue;
    if (current.length >= MIN_PARAGRAPH_CHARS && SENTENCE_END.test(cue)) {
      paragraphs.push(current);
      current = '';
    }
  }
  if (current) paragraphs.push(current);

  return paragraphs.join('\n\n');
}
