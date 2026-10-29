import {
  LOCAL_CONTEXT_ERROR,
  OutputLimitError,
  fitsLocalContext,
  chat as llmChat,
  llmConfig,
} from '../llm.js';
import { DEFAULT_STYLE, getStyle, mergePrompt } from './styles.js';

export const MAX_PART_CHARS = 60000;
export const GROUP_SIZE = 10;

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

const totalLength = (notesList) => notesList.reduce((sum, notes) => sum + notes.length, 0);
// Shortening that removes less than this share of the text no longer helps
const MIN_SHORTENING = 0.1;
// Partial results not written yet are assumed to be this share of their part, for the plan
const ESTIMATED_NOTES_SHARE = 0.25;

// Counts the model calls of a notes job for its progress: the current phase (parts, compress,
// merge), the calls done and the calls planned. The plan is an estimate; it is updated when
// parts are split, notes are shortened, merges are split or another merge level is needed.
export function createProgress(onProgress = () => {}) {
  const state = { phase: 'parts', done: 0, total: 0 };
  const report = () => onProgress({ ...state });
  return {
    start(phase) {
      state.phase = phase;
      report();
    },
    finish() {
      state.done++;
      state.total = Math.max(state.total, state.done);
      report();
    },
    // remaining: the calls still expected from now on
    plan(remaining) {
      state.total = state.done + remaining;
      report();
    },
    add(calls) {
      state.total += calls;
      report();
    },
  };
}

// Merges that reduceNotes makes for n notes in groups of groupSize
export function countMerges(n, groupSize = GROUP_SIZE) {
  let merges = 0;
  for (let current = n; current > 1; current = Math.ceil(current / groupSize)) {
    if (current <= groupSize) return merges + 1;
    merges += Math.floor(current / groupSize) + (current % groupSize > 1 ? 1 : 0);
  }
  return merges;
}

// Estimated calls to merge notes of these lengths in groups that fit: a merged note is assumed
// to be as long as its longest input, and when no two notes fit together each is assumed to be
// shortened to half (one compress call each)
export function estimateMergesToFit(lengths, fits) {
  const asNotes = (group) => group.map((length) => 'x'.repeat(length));
  let level = lengths;
  let calls = 0;
  while (level.length > 1 && Math.max(...level) >= 1) {
    const next = [];
    let group = [];
    const close = () => {
      if (group.length > 1) calls++;
      next.push(Math.max(...group));
      group = [];
    };
    for (const length of level) {
      if (group.length && !fits(asNotes([...group, length]))) close();
      group.push(length);
    }
    close();
    if (next.length < level.length) {
      level = next;
    } else {
      calls += level.length;
      level = level.map((length) => Math.floor(length / 2));
    }
  }
  return calls;
}

const noProgress = { plan() {}, add() {} };

// Merges level by level in groups that fit (fits(group)); a note that fits with no neighbor
// moves to the next level unchanged. When no two neighbors fit together, every note is first
// shortened on its own (compress). A merge whose reply is cut off by the output limit is split
// into two smaller merges, and a cut-off merge of two notes is tried again with shortened notes.
// The errors are the last resort, when shortening stops helping.
export async function reduceNotesToFit(notesList, { merge, compress, fits, progress = noProgress }) {
  async function shorten(list, failure) {
    const shorter = [];
    for (const notes of list) shorter.push(await compress(notes));
    const before = totalLength(list);
    if (!before || totalLength(shorter) > before * (1 - MIN_SHORTENING)) throw failure;
    return shorter;
  }

  async function mergeOrShorten(group) {
    try {
      return await merge(group);
    } catch (err) {
      if (!(err instanceof OutputLimitError)) throw err;
      if (group.length === 2) {
        // Two compress calls and the merge again
        progress.add(3);
        return mergeOrShorten(await shorten(group, err));
      }
      const middle = Math.ceil(group.length / 2);
      const halves = [group.slice(0, middle), group.slice(middle)];
      progress.add(halves.filter((half) => half.length > 1).length + 1);
      const merged = [];
      for (const half of halves) merged.push(half.length === 1 ? half[0] : await mergeOrShorten(half));
      return mergeOrShorten(merged);
    }
  }

  let current = notesList;
  while (current.length > 1) {
    // Each level is planned again from the notes it really has
    progress.plan(estimateMergesToFit(current.map((notes) => notes.length), fits));
    const next = [];
    let group = [];
    const close = async () => {
      next.push(group.length === 1 ? group[0] : await mergeOrShorten(group));
      group = [];
    };
    for (const notes of current) {
      if (group.length && !fits([...group, notes])) await close();
      group.push(notes);
    }
    await close();
    current =
      next.length < current.length ? next : await shorten(current, new Error(LOCAL_CONTEXT_ERROR));
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

export const COMPRESS_INSTRUCTION =
  'Shorten this to at most half its length, keeping the structure and the most important points.';

export function compressMessage(title, notes) {
  return `Material title: ${title}\n\n<notes>\n${notes}\n</notes>`;
}

export function mergeMessage(title, notesList) {
  const parts = notesList
    .map((notes, i) => `<notes part="${i + 1}">\n${notes}\n</notes>`)
    .join('\n\n');
  return `Material title: ${title}\n\n${parts}`;
}

// Creates notes in a style with the resolved provider and model. For the local model, parts of
// LOCAL_PART_CHARS are halved until each request fits the context (LOCAL_CONTEXT_TOKENS), merges
// are grouped by size, and partial results are shortened when they do not fit together or when a
// merged reply is cut off by LOCAL_MAX_OUTPUT_TOKENS; OpenAI uses 60,000-character parts and
// groups of 10.
// chat is replaceable so tests do not call a model. onProgress receives { phase, done, total }
// whenever a call starts or ends or the plan changes.
export async function generateNotes(
  { title, content },
  { style = DEFAULT_STYLE, provider, model, chat = llmChat, onProgress } = {}
) {
  const noteStyle = getStyle(style);
  if (!noteStyle) throw new Error(`Unknown note style "${style}".`);

  const local = provider === 'local';
  const config = llmConfig();
  const merge = mergePrompt(noteStyle);
  const maxOutputTokens = local ? config.localMaxOutputTokens : config.openaiMaxOutputTokens;

  let parts = splitText(content, local ? config.localPartChars : MAX_PART_CHARS);
  if (local) {
    const fits = (part, number, count) =>
      fitsLocalContext(noteStyle.prompt, notesMessage(title, part, number, count));
    // Not even the prompt alone fits, so no split can help
    if (!fits('', 1, 2)) throw new Error(LOCAL_CONTEXT_ERROR);
    parts = fitParts(parts, fits);
  }

  // Every model call is one step of the progress; purpose only goes into the log of local calls
  const progress = createProgress(onProgress);
  async function complete(phase, system, user, purpose) {
    progress.start(phase);
    try {
      return (await chat({ provider, model, system, user, maxOutputTokens, purpose })).text;
    } finally {
      progress.finish();
    }
  }

  const mergeFits = (group) => fitsLocalContext(merge, mergeMessage(title, group));
  // Planned merges: exact for OpenAI; for the local model estimated from the partial results so
  // far, with a quarter of the part's length for those not written yet
  const plannedMerges = (partNotes) =>
    local
      ? estimateMergesToFit(
          parts.map((part, i) => partNotes[i]?.length ?? Math.ceil(part.length * ESTIMATED_NOTES_SHARE)),
          mergeFits
        )
      : countMerges(parts.length);

  // Notes for a part that are too long even with a higher output limit: the part is replaced by
  // its two halves, and the later parts are numbered on from there
  const partNotes = [];
  progress.plan(parts.length + plannedMerges(partNotes));
  for (let i = 0; i < parts.length; ) {
    try {
      partNotes.push(
        await complete(
          'parts',
          noteStyle.prompt,
          notesMessage(title, parts[i], i + 1, parts.length),
          `part ${i + 1} of ${parts.length}`
        )
      );
      i++;
    } catch (err) {
      const halves = err instanceof OutputLimitError ? splitInHalf(parts[i]) : [];
      if (halves.length < 2) throw err;
      parts.splice(i, 1, ...halves);
      progress.plan(parts.length - i + plannedMerges(partNotes));
    }
  }

  // A merge that is too long is split the same way: each half of the group is merged, then the
  // two results; when only two notes are left the error is final
  async function mergeGroup(group) {
    try {
      return await complete('merge', merge, mergeMessage(title, group), `merge of ${group.length} notes`);
    } catch (err) {
      if (!(err instanceof OutputLimitError) || group.length < 3) throw err;
      const middle = Math.ceil(group.length / 2);
      const halves = [group.slice(0, middle), group.slice(middle)];
      progress.add(halves.filter((half) => half.length > 1).length + 1);
      return mergeGroup([await mergeOrKeep(halves[0]), await mergeOrKeep(halves[1])]);
    }
  }
  const mergeOrKeep = (group) => (group.length === 1 ? group[0] : mergeGroup(group));

  if (!local) {
    progress.plan(countMerges(partNotes.length));
    return reduceNotes(partNotes, mergeGroup);
  }

  // Shortens one partial result with the style instructions; a result too large for one call
  // (or whose shortened reply is cut off) is split, and its halves are shortened
  const compressSystem = `${noteStyle.prompt}\n\n${COMPRESS_INSTRUCTION}`;
  async function compress(notes) {
    const user = compressMessage(title, notes);
    // The one planned call for this note is replaced by one call per half, or added to them
    // when it was made and cut off
    let unplanned = -1;
    if (fitsLocalContext(compressSystem, user)) {
      try {
        return await complete('compress', compressSystem, user, `compress of 1 note (${notes.length} chars)`);
      } catch (err) {
        if (!(err instanceof OutputLimitError)) throw err;
        unplanned = 0;
      }
    }
    const halves = splitInHalf(notes);
    if (halves.length < 2) throw new Error(LOCAL_CONTEXT_ERROR);
    progress.add(halves.length + unplanned);
    const shorter = [];
    for (const half of halves) shorter.push(await compress(half));
    return shorter.join('\n\n');
  }

  return reduceNotesToFit(partNotes, {
    merge: (group) =>
      complete('merge', merge, mergeMessage(title, group), `merge of ${group.length} notes`),
    compress,
    fits: mergeFits,
    progress,
  });
}
