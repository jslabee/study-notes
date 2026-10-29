import { LOCAL_CONTEXT_ERROR, fitsLocalContext, chat as llmChat, llmConfig } from '../llm.js';
import { DEFAULT_STYLE, getStyle, mergePrompt } from './styles.js';

export const MAX_PART_CHARS = 60000;
export const GROUP_SIZE = 10;
const MAX_OUTPUT_TOKENS = 4000;

const SENTENCE_END = /[.!?]["')\]]?(?=\s)/g;
const PARAGRAPH_BREAK = /\n[ \t]*\n/g;

function lastMatchEnd(regex, text, useStart) {
  let result = -1;
  for (const match of text.matchAll(regex)) {
    result = useStart ? match.index : match.index + match[0].length;
  }
  return result;
}

// Finds where to cut: the last paragraph end, else the last sentence end, else the last space.
// A cut in the first half of the window is not used, so parts do not become tiny.
function findCut(text, maxChars) {
  const minCut = Math.floor(maxChars / 2);
  const window = text.slice(0, maxChars);

  const paragraph = lastMatchEnd(PARAGRAPH_BREAK, window, true);
  if (paragraph >= minCut) return paragraph;

  // One extra character so a sentence ending exactly at the limit is found
  const sentence = lastMatchEnd(SENTENCE_END, text.slice(0, maxChars + 1), false);
  if (sentence >= minCut && sentence <= maxChars) return sentence;

  const space = window.search(/\s\S*$/);
  if (space >= minCut) return space;

  return maxChars;
}

// Splits text longer than maxChars into parts of at most maxChars characters
export function splitText(text, maxChars = MAX_PART_CHARS) {
  if (text.length <= maxChars) return [text];

  const parts = [];
  let rest = text.trim();
  while (rest.length > maxChars) {
    const cut = findCut(rest, maxChars);
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

// The cut nearest to the middle of the text, among cuts in its middle half
function nearestToMiddle(text, positions) {
  const middle = text.length / 2;
  return positions
    .filter((p) => p >= text.length / 4 && p <= (text.length * 3) / 4)
    .sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))[0];
}

// Cuts text in two near the middle: at a paragraph end, else a sentence end, else a space
export function splitInHalf(text) {
  const cut =
    nearestToMiddle(text, [...text.matchAll(PARAGRAPH_BREAK)].map((m) => m.index)) ??
    nearestToMiddle(text, [...text.matchAll(SENTENCE_END)].map((m) => m.index + m[0].length)) ??
    nearestToMiddle(text, [...text.matchAll(/\s/g)].map((m) => m.index)) ??
    Math.floor(text.length / 2);
  return [text.slice(0, cut).trim(), text.slice(cut).trim()].filter(Boolean);
}

// Halves every part that does not fit (fits(part, number, count)) until all parts fit; a part
// that cannot be cut further is kept, and the model call then refuses it
export function fitParts(parts, fits) {
  let current = parts;
  for (;;) {
    const next = current.flatMap((part, i) =>
      fits(part, i + 1, current.length) ? [part] : splitInHalf(part)
    );
    if (next.length === current.length) return current;
    current = next;
  }
}

// Merges level by level in groups that fit (fits(group)); a group has at least two notes, and a
// note left on its own at the end of a level moves to the next level unchanged
export async function reduceNotesToFit(notesList, mergeGroup, fits) {
  let current = notesList;
  while (current.length > 1) {
    const next = [];
    let group = [];
    for (const notes of current) {
      if (group.length === 1 && !fits([...group, notes])) throw new Error(LOCAL_CONTEXT_ERROR);
      if (group.length >= 2 && !fits([...group, notes])) {
        next.push(await mergeGroup(group));
        group = [];
      }
      group.push(notes);
    }
    next.push(group.length === 1 ? group[0] : await mergeGroup(group));
    current = next;
  }
  return current[0];
}

// Merges a list of notes; more than GROUP_SIZE are merged in groups, then the group results
export async function reduceNotes(notesList, mergeGroup, groupSize = GROUP_SIZE) {
  let current = notesList;
  while (current.length > 1) {
    if (current.length <= groupSize) return mergeGroup(current);
    const next = [];
    for (let i = 0; i < current.length; i += groupSize) {
      const group = current.slice(i, i + groupSize);
      next.push(group.length === 1 ? group[0] : await mergeGroup(group));
    }
    current = next;
  }
  return current[0];
}

export function notesMessage(title, content, part, partCount) {
  const partLine = partCount > 1 ? `This is part ${part} of ${partCount}.\n` : '';
  return `Material title: ${title}\n${partLine}\n<material>\n${content}\n</material>`;
}

export function mergeMessage(title, notesList) {
  const parts = notesList
    .map((notes, i) => `<notes part="${i + 1}">\n${notes}\n</notes>`)
    .join('\n\n');
  return `Material title: ${title}\n\n${parts}`;
}

// Creates notes in a style with the resolved provider and model. For the local model, parts of
// LOCAL_PART_CHARS are halved until each request fits the context (LOCAL_CONTEXT_TOKENS), and
// merges are grouped by size; OpenAI uses 60,000-character parts and groups of 10.
// chat is replaceable so tests do not call a model.
export async function generateNotes(
  { title, content },
  { style = DEFAULT_STYLE, provider, model, chat = llmChat } = {}
) {
  const noteStyle = getStyle(style);
  if (!noteStyle) throw new Error(`Unknown note style "${style}".`);

  const local = provider === 'local';
  const config = llmConfig();
  const merge = mergePrompt(noteStyle);
  const maxOutputTokens = local ? config.localMaxOutputTokens : MAX_OUTPUT_TOKENS;

  let parts = splitText(content, local ? config.localPartChars : MAX_PART_CHARS);
  if (local) {
    const fits = (part, number, count) =>
      fitsLocalContext(noteStyle.prompt, notesMessage(title, part, number, count));
    // Not even the prompt alone fits, so no split can help
    if (!fits('', 1, 2)) throw new Error(LOCAL_CONTEXT_ERROR);
    parts = fitParts(parts, fits);
  }

  const complete = async (system, user) =>
    (await chat({ provider, model, system, user, maxOutputTokens })).text;

  const partNotes = [];
  for (let i = 0; i < parts.length; i++) {
    partNotes.push(
      await complete(noteStyle.prompt, notesMessage(title, parts[i], i + 1, parts.length))
    );
  }

  const mergeGroup = (group) => complete(merge, mergeMessage(title, group));
  if (!local) return reduceNotes(partNotes, mergeGroup);
  return reduceNotesToFit(partNotes, mergeGroup, (group) =>
    fitsLocalContext(merge, mergeMessage(title, group))
  );
}
