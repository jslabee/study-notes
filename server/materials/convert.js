import { extractTextItems, getDocumentProxy } from 'unpdf';

const TIMESTAMP_LINE = /-->/;
const SENTENCE_END = /[.!?]["')\]]?$/;
// A subtitle paragraph is closed at the first sentence end after this many characters
const MIN_PARAGRAPH_CHARS = 500;
// "12", "Page 12", "12 of 30", "12 / 30", "- 12 -"
const PAGE_NUMBER_LINE = /^(?:page\s+)?\d+(?:\s*(?:\/|of)\s*\d+)?$|^[-–—]\s*\d+\s*[-–—]$/i;
// Page numbers are only looked for among this many lines at the top and bottom of a page
const PAGE_EDGE_LINES = 2;
// A vertical gap larger than this many font sizes between two lines starts a new paragraph
const PARAGRAPH_GAP = 1.5;
const PARAGRAPH_BREAK = '\n\n';

export const NO_TEXT_ERROR = 'The file contains no readable text.';
export const NO_PDF_TEXT_ERROR =
  'This PDF contains no selectable text (scanned documents are not supported).';
export const INVALID_PDF_ERROR = 'The file is not a valid PDF.';

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

// Extracts the text of all pages of a PDF and cleans it; asynchronous because unpdf is
export async function pdfToText(buffer) {
  return (await pdfToTextWithPages(buffer)).text;
}

// Like pdfToText, also returns pageOffsets (the offset in the text where each page starts) and
// outline: the top-level entries of the PDF outline (bookmarks) as [{ title, start }], with the
// offset where the entry's page starts ([] when the PDF has no outline)
export async function pdfToTextWithPages(buffer) {
  let pdf;
  let pages;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer));
    ({ items: pages } = await extractTextItems(pdf));
  } catch {
    throw new Error(INVALID_PDF_ERROR);
  }

  const result = cleanPdfPagesWithOffsets(pages.map(itemsToLines));
  // A scanned document has no text layer, so nothing is extracted
  if (!result.text.trim()) throw new Error(NO_PDF_TEXT_ERROR);
  // A broken outline only means there are no chapters from it
  const entries = await readOutline(pdf).catch(() => []);
  return { ...result, outline: outlineToChapters(entries, result.pageOffsets) };
}

// Top-level outline entries with the index (from 0) of the page they point to; entries whose
// page cannot be resolved are left out
async function readOutline(pdf) {
  const entries = [];
  for (const item of (await pdf.getOutline()) ?? []) {
    try {
      // A destination is an array [page, ...] or the name of one
      const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
      if (!Array.isArray(dest)) continue;
      const pageIndex = Number.isInteger(dest[0]) ? dest[0] : await pdf.getPageIndex(dest[0]);
      entries.push({ title: item.title, pageIndex });
    } catch {
      // An entry with a broken destination is skipped
    }
  }
  return entries;
}

// Maps outline entries ({ title, pageIndex }) to chapters [{ title, start }], where start is the
// offset in the cleaned text where the entry's page starts
export function outlineToChapters(entries, pageOffsets) {
  return entries.flatMap(({ title, pageIndex }) => {
    const clean = String(title ?? '').replace(/\s+/g, ' ').trim();
    const start = pageOffsets[pageIndex];
    return clean && Number.isInteger(start) ? [{ title: clean, start }] : [];
  });
}

// Groups the text items of one page into lines; an empty string marks a paragraph break
function itemsToLines(items) {
  const lines = [];
  let current = null;
  let previous = null;

  const closeLine = () => {
    if (!current) return;
    if (previous && previous.y - current.y > PARAGRAPH_GAP * Math.max(previous.size, current.size)) {
      lines.push('');
    }
    lines.push(current.text);
    previous = current;
    current = null;
  };

  for (const item of items) {
    if (item.str) {
      // Text on a different baseline belongs to a new line even without an end-of-line mark
      if (current && Math.abs(current.y - item.y) > current.size / 2) closeLine();
      if (current) current.text += item.str;
      else current = { text: item.str, y: item.y, size: item.fontSize || item.height || 1 };
    }
    if (item.hasEOL) closeLine();
  }
  closeLine();
  return lines;
}

// Cleans the lines of all pages (arrays of strings, '' = paragraph break) into paragraphs
export function cleanPdfPages(pages) {
  return cleanPdfPagesWithOffsets(pages).text;
}

// Like cleanPdfPages, also returns pageOffsets: for every page, the offset in the text where its
// first remaining line starts (the end of the text for pages with no text left)
export function cleanPdfPagesWithOffsets(pages) {
  const trimmed = pages.map((lines) => lines.map((line) => line.trim()));

  // Headers and footers: a line that appears identically on more than half of the pages
  const pageCounts = new Map();
  for (const lines of trimmed) {
    for (const line of new Set(lines.filter(Boolean))) {
      pageCounts.set(line, (pageCounts.get(line) ?? 0) + 1);
    }
  }
  const repeated = (line) => trimmed.length > 1 && pageCounts.get(line) > trimmed.length / 2;

  const lines = [];
  // Index in lines of the first line of every page
  const pageStarts = [];
  for (const pageLines of trimmed) {
    const kept = pageLines.filter((line) => !line || !repeated(line));
    // Standalone page numbers at the top or bottom of the page
    const textIndexes = kept.flatMap((line, i) => (line ? [i] : []));
    const edges = new Set([
      ...textIndexes.slice(0, PAGE_EDGE_LINES),
      ...textIndexes.slice(-PAGE_EDGE_LINES),
    ]);
    // A page that ends with a finished sentence also ends the paragraph
    if (SENTENCE_END.test(lines.at(-1) ?? '')) lines.push('');
    pageStarts.push(lines.length);
    // Whitespace inside a line is collapsed here, so the paragraphs need no changes later
    // and the offsets of lines in them stay exact
    lines.push(
      ...kept
        .filter((line, i) => !(edges.has(i) && PAGE_NUMBER_LINE.test(line)))
        .map((line) => line.replace(/\s+/g, ' '))
    );
  }

  // Merge lines into paragraphs and join words hyphenated at line ends. lineOffsets has the
  // offset in the result where every line starts.
  const paragraphs = [];
  const lineOffsets = [];
  let length = 0;
  let current = '';
  const paragraphStart = () => (paragraphs.length > 0 ? length + PARAGRAPH_BREAK.length : 0);
  const closeParagraph = () => {
    if (!current) return;
    length = paragraphStart() + current.length;
    paragraphs.push(current);
    current = '';
  };
  for (const line of lines) {
    if (!line) {
      closeParagraph();
      lineOffsets.push(null);
    } else if (/\p{L}-$/u.test(current) && /^\p{Ll}/u.test(line)) {
      lineOffsets.push(paragraphStart() + current.length - 1);
      current = current.slice(0, -1) + line;
    } else if (/\p{L}-$/u.test(current) && /^\p{Lu}/u.test(line)) {
      // A hyphenated name or compound like "Smith-Jones" keeps its hyphen
      lineOffsets.push(paragraphStart() + current.length);
      current += line;
    } else {
      lineOffsets.push(paragraphStart() + (current ? current.length + 1 : 0));
      current = current ? `${current} ${line}` : line;
    }
  }
  closeParagraph();

  const text = paragraphs.join(PARAGRAPH_BREAK);
  const pageOffsets = pageStarts.map(
    (start) => lineOffsets.slice(start).find((offset) => offset !== null) ?? text.length
  );
  return { text, pageOffsets };
}
