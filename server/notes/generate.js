import { complete as llmComplete } from '../llm.js';

// Prompts are copied verbatim from docs/spec.md ("Zapiski")
export const NOTES_SYSTEM_PROMPT = `You are an assistant that creates study notes from learning material. Use only information from the material; do not add or invent anything. Respond only with the notes in Markdown, in exactly this structure:

## Summary
3 to 5 sentences about the content of the material.

## Key points
5 to 15 bullet points, each expressing one clear idea.

## Terms
Bullet points in the form **term** – short explanation. Only terms that are important in the material.`;

export const MERGE_SYSTEM_PROMPT = `Below are notes for individual parts of the same material. Merge them into a single set of notes with the same structure (Summary, Key points, Terms). Remove repetition. The summary should have 4 to 6 sentences and there should be at most 25 key points. Do not add anything.`;

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

// Creates notes for a material; complete is replaceable so tests do not call the API
export async function generateNotes({ title, content }, { complete = llmComplete } = {}) {
  const parts = splitText(content);

  const partNotes = [];
  for (let i = 0; i < parts.length; i++) {
    partNotes.push(
      await complete({
        system: NOTES_SYSTEM_PROMPT,
        user: notesMessage(title, parts[i], i + 1, parts.length),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      })
    );
  }

  return reduceNotes(partNotes, (group) =>
    complete({
      system: MERGE_SYSTEM_PROMPT,
      user: mergeMessage(title, group),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    })
  );
}
