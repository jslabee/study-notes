// Chapter detection for the by-chapter note style (docs/spec.md, "Nadgradnja 6"). It does not
// depend on how headings are written. Methods, in order; the first whose result passes
// validation is used:
//   outline  the PDF outline (bookmarks), read at import with the offsets of their pages
//   model    the model picks the chapter starts among candidate heading lines
//   topics   topic segmentation at the largest similarity drops between consecutive chunk
//            vectors; the model gives each section a short title
import { getDb } from '../db.js';
import { EmptyResponseError, LOCAL_CONTEXT_ERROR, LlmError, OutputLimitError } from '../llm.js';
import { CANDIDATES_PROMPT, SECTION_TITLE_PROMPT } from './styles.js';

export const MIN_CHAPTER_WORDS = 300;
export const MIN_CHAPTERS = 2;
export const MAX_CHAPTERS = 60;
// A candidate heading line is shorter than this
const MAX_CANDIDATE_CHARS = 120;
// Topic segmentation: about one section per this many chunks, within the section limits
const CHUNKS_PER_SECTION = 10;
const MIN_SECTIONS = 2;
const MAX_SECTIONS = 30;
// The start of a chunk is found in the text by its first words
const CHUNK_KEY_WORDS = 12;
const MAX_TITLE_CHARS = 100;

export const METHODS = ['outline', 'model', 'topics'];

export const countWords = (text) => text.split(/\s+/).filter(Boolean).length;

// The text of every chapter [{ title, text }]; the text before the first chapter belongs to it
export function chapterTexts(content, chapters) {
  return chapters.map((chapter, i) => ({
    title: chapter.title,
    text: content.slice(i === 0 ? 0 : chapter.start, chapters[i + 1]?.start ?? content.length).trim(),
  }));
}

// Checks chapters [{ title, start }] against the text: starts inside the text in increasing
// order, chapters shorter than MIN_CHAPTER_WORDS merged into a neighbor (the one before; the
// first into the one after it), and MIN_CHAPTERS to MAX_CHAPTERS chapters. Returns the valid
// chapters or null.
export function validateChapters(content, chapters) {
  if (!Array.isArray(chapters)) return null;
  const valid = chapters.every(
    (chapter, i) =>
      typeof chapter.title === 'string' &&
      chapter.title.trim() &&
      Number.isInteger(chapter.start) &&
      chapter.start >= 0 &&
      chapter.start < content.length &&
      (i === 0 || chapter.start > chapters[i - 1].start)
  );
  if (!valid) return null;

  let result = chapters.map(({ title, start }) => ({ title: title.trim(), start }));
  for (;;) {
    const words = chapterTexts(content, result).map((chapter) => countWords(chapter.text));
    const short = words.findIndex((n) => n < MIN_CHAPTER_WORDS);
    if (short < 0 || result.length < MIN_CHAPTERS) break;
    // Removing a start joins that chapter to the one before it; the first chapter's text joins
    // the next one, which then starts the text
    result = result.filter((_, i) => i !== short);
  }
  return result.length >= MIN_CHAPTERS && result.length <= MAX_CHAPTERS ? result : null;
}

// Method 1: the PDF outline stored with the material ([{ title, start }]). Entries on the same
// page (e.g. "Part I" and its first chapter) start at the same offset; the later, more specific
// one is kept.
export function fromOutline(outline) {
  return (outline ?? []).filter((entry, i, all) => all[i + 1]?.start !== entry.start);
}

// Method 2. Candidate heading lines: a line of its own (after a blank line or at the start of
// the text), shorter than MAX_CANDIDATE_CHARS and not mostly digits. Each has an id (from 1),
// its text, its offset and the number of words until the next candidate.
export function findCandidates(content) {
  const candidates = [];
  let previousBlank = true;
  let offset = 0;
  for (const raw of content.split('\n')) {
    const text = raw.trim();
    const start = offset;
    offset += raw.length + 1;
    const own = previousBlank;
    previousBlank = !text;
    if (!text || !own || text.length >= MAX_CANDIDATE_CHARS) continue;
    const visible = text.replace(/\s/g, '');
    if ((visible.match(/\d/g)?.length ?? 0) > visible.length / 2) continue;
    candidates.push({ id: candidates.length + 1, text, start: start + raw.indexOf(text), end: offset - 1 });
  }
  return withWordCounts(content, candidates);
}

// The words after each candidate line until the next candidate (or the end of the text)
function withWordCounts(content, candidates) {
  return candidates.map((candidate, i) => ({
    ...candidate,
    words: countWords(content.slice(candidate.end, candidates[i + 1]?.start ?? content.length)),
  }));
}

export function candidatesMessage(title, candidates) {
  const lines = candidates.map((c) => `id=${c.id} | words=${c.words} | ${c.text}`).join('\n');
  return `Material title: ${title}\n\n<candidates>\n${lines}\n</candidates>`;
}

// The candidates sent to the model: all when they fit (fits(candidates)), otherwise the ones
// followed by the most words, as many as fit, in document order; word counts are then counted
// to the next candidate that is sent
export function selectCandidates(content, candidates, fits) {
  if (fits(candidates)) return candidates;
  const byWords = [...candidates].sort((a, b) => b.words - a.words || a.id - b.id);
  const top = (count) =>
    withWordCounts(
      content,
      byWords.slice(0, count).sort((a, b) => a.id - b.id)
    );
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(top(middle))) low = middle;
    else high = middle - 1;
  }
  return top(low);
}

export class InvalidReplyError extends Error {}

// The chapters chosen by the model: JSON {"chapters":[{"id", "title"}]} (also inside a code
// block). Unknown ids are ignored, a missing title is the candidate line itself.
export function parseChapterChoice(reply, candidates) {
  const text = String(reply ?? '');
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    throw new InvalidReplyError('The model did not reply with valid JSON.');
  }
  if (!Array.isArray(data?.chapters)) throw new InvalidReplyError('The reply has no chapters list.');

  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set();
  return data.chapters.flatMap((chapter) => {
    const candidate = byId.get(Number(chapter?.id));
    if (!candidate || seen.has(candidate.id)) return [];
    seen.add(candidate.id);
    const title = typeof chapter.title === 'string' && chapter.title.trim() ? chapter.title : candidate.text;
    return [{ title: title.replace(/\s+/g, ' ').trim(), start: candidate.start }];
  });
}

async function fromModel({ title, content }, { complete, fits }) {
  const candidates = findCandidates(content);
  if (candidates.length < MIN_CHAPTERS) return [];
  const sent = selectCandidates(content, candidates, (list) =>
    fits(CANDIDATES_PROMPT, candidatesMessage(title, list))
  );
  if (sent.length < MIN_CHAPTERS) return [];
  const reply = await complete('detect', CANDIDATES_PROMPT, candidatesMessage(title, sent), 'chapter candidates');
  return parseChapterChoice(reply, sent);
}

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

// Method 3. Indexes of the chunks that start a new section: about one section per
// CHUNKS_PER_SECTION chunks (MIN_SECTIONS to MAX_SECTIONS), at the largest similarity drops
// between consecutive chunk vectors, with sections of at least half the average size
export function topicBoundaries(vectors) {
  const n = vectors.length;
  if (n < MIN_SECTIONS) return [];
  const sections = Math.min(n, Math.max(MIN_SECTIONS, Math.min(MAX_SECTIONS, Math.round(n / CHUNKS_PER_SECTION))));
  const minChunks = Math.max(1, Math.floor(n / sections / 2));
  const drops = vectors
    .slice(1)
    .map((vector, i) => ({ index: i + 1, drop: 1 - cosine(vectors[i], vector) }))
    .sort((a, b) => b.drop - a.drop || a.index - b.index);

  const chosen = [];
  for (const { index } of drops) {
    if (chosen.length === sections - 1) break;
    const far = [0, n, ...chosen].every((other) => Math.abs(other - index) >= minChunks);
    if (far) chosen.push(index);
  }
  return chosen.sort((a, b) => a - b);
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The offset of every chunk in the text, found by its first words after the previous chunk's
// start; null when a chunk cannot be found (e.g. the text changed after indexing)
export function chunkStarts(content, chunkTexts) {
  const starts = [];
  let from = 0;
  for (const text of chunkTexts) {
    const words = text.split(/\s+/).filter(Boolean).slice(0, CHUNK_KEY_WORDS);
    const pattern = new RegExp(words.map(escapeRegExp).join('\\s+'), 'g');
    pattern.lastIndex = from;
    const match = pattern.exec(content);
    if (!words.length || !match) return null;
    starts.push(match.index);
    from = match.index;
  }
  return starts;
}

// Chunk texts and vectors of a material, in order
export function loadChunks(materialId) {
  return getDb()
    .prepare(
      `SELECT c.text, v.embedding FROM chunks c
       JOIN chunk_vectors v ON v.rowid = c.id
       WHERE c.material_id = ? ORDER BY c.position`
    )
    .all(materialId)
    .map(({ text, embedding }) => ({
      text,
      vector: new Float32Array(embedding.buffer, embedding.byteOffset, embedding.byteLength / 4),
    }));
}

function fromTopics({ content }, chunks) {
  const starts = chunkStarts(content, chunks.map((chunk) => chunk.text));
  if (!starts) return [];
  const boundaries = topicBoundaries(chunks.map((chunk) => chunk.vector));
  if (boundaries.length === 0) return [];
  // Titles are written after validation, so merged sections cost no calls
  return [0, ...boundaries].map((index, i) => ({ title: `Section ${i + 1}`, start: i === 0 ? 0 : starts[index] }));
}

export function sectionMessage(title, text) {
  return `Material title: ${title}\n\n<section>\n${text}\n</section>`;
}

// A title from the model's reply: its first line without Markdown, quotes or a final period
export function cleanTitle(reply) {
  const line = String(reply ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return '';
  return line
    .replace(/^#+\s*/, '')
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .replace(/^title:\s*/i, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\.$/, '')
    .trim()
    .slice(0, MAX_TITLE_CHARS);
}

// A short title for every section; a section too long for one request is cut to what fits
async function titleSections({ title, content }, sections, { complete, fits }) {
  const titled = [];
  for (const [i, section] of chapterTexts(content, sections).entries()) {
    let text = section.text;
    while (text.length > 1 && !fits(SECTION_TITLE_PROMPT, sectionMessage(title, text))) {
      text = text.slice(0, Math.floor(text.length / 2));
    }
    const reply = await complete('detect', SECTION_TITLE_PROMPT, sectionMessage(title, text), `title of section ${i + 1}`);
    titled.push({ title: cleanTitle(reply) || `Section ${i + 1}`, start: sections[i].start });
  }
  return titled;
}

// Errors that mean a method's result cannot be used, so the next method is tried: a reply that
// is not the expected JSON, an empty reply, a reply cut off by the output limit, or a request
// too large for the local model's context
export function isUnusableResult(err) {
  return (
    err instanceof InvalidReplyError ||
    err instanceof EmptyResponseError ||
    err instanceof OutputLimitError ||
    (err instanceof LlmError && err.message === LOCAL_CONTEXT_ERROR)
  );
}

// Detects the chapters of a material with the first method whose result is valid:
// { method: 'outline' | 'model' | 'topics', chapters: [{ title, start }] }, or { method: null,
// chapters: [] } when no method finds any. complete(phase, system, user, purpose) calls the
// model, fits(system, user) tells whether a request fits the chosen provider, and
// chunks() returns the material's chunks with their vectors.
// Any other error (no connection, a rejected key, a rate limit, a timeout) is thrown, so the
// job fails and no weaker detection is returned (and stored) because of a passing problem.
export async function detectChapters(material, { complete, fits, chunks = () => [], log = console.log }) {
  const methods = {
    outline: async () => fromOutline(material.outline),
    model: () => fromModel(material, { complete, fits }),
    topics: async () => fromTopics(material, await chunks()),
  };
  for (const method of METHODS) {
    let found;
    try {
      found = validateChapters(material.content, await methods[method]());
    } catch (err) {
      if (!isUnusableResult(err)) throw err;
      log(`[chapters] ${method} failed: ${err.message}`);
      continue;
    }
    if (!found) continue;
    const chapters = method === 'topics' ? await titleSections(material, found, { complete, fits }) : found;
    return { method, chapters };
  }
  return { method: null, chapters: [] };
}
