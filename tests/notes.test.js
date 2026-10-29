import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import OpenAI from 'openai';
import {
  LOCAL_CONTEXT_ERROR,
  LOCAL_OUTPUT_TOO_LONG_ERROR,
  OutputLimitError,
  withRetries,
} from '../server/llm.js';
import {
  COMPRESS_INSTRUCTION,
  GROUP_SIZE,
  countMerges,
  estimateMergesToFit,
  MAX_PART_CHARS,
  generateNotes,
  reduceNotes,
  reduceNotesToFit,
  splitInHalf,
  splitText,
} from '../server/notes/generate.js';
import {
  MERGE_INSTRUCTION,
  NOTES_SYSTEM_PROMPT,
  NOTE_STYLES,
  getStyle,
  mergePrompt,
} from '../server/notes/styles.js';

const MERGE_SYSTEM_PROMPT = mergePrompt(getStyle('study-notes'));

const words = (text) => text.split(/\s+/).filter(Boolean);

// Builds text of roughly totalChars from paragraphs of the given size
function makeText(totalChars, paragraphChars = 1000) {
  const sentence = 'Cells use energy from food to build new proteins. ';
  const paragraph = sentence.repeat(Math.ceil(paragraphChars / sentence.length)).trim();
  const paragraphs = [];
  let length = 0;
  for (let i = 0; length < totalChars; i++) {
    const p = `Paragraph ${i}. ${paragraph}`;
    paragraphs.push(p);
    length += p.length + 2;
  }
  return paragraphs.join('\n\n');
}

// Mock for llm.chat that records every call
function mockChat() {
  const calls = [];
  const chat = async ({ provider, model, system, user, maxOutputTokens }) => {
    calls.push({ provider, model, system, user, maxOutputTokens });
    const text = system === NOTES_SYSTEM_PROMPT ? `notes ${calls.length}` : `merged ${calls.length}`;
    return { text, provider, model };
  };
  return { calls, chat };
}

test('text of at most 60,000 characters is one unchanged part', () => {
  const text = `  ${'a'.repeat(MAX_PART_CHARS - 4)}  `;
  assert.deepEqual(splitText(text), [text]);
});

test('long text is split at paragraph ends into parts of at most 60,000 characters', () => {
  const text = makeText(200000);
  const parts = splitText(text);
  assert.ok(parts.length >= 4);
  for (const part of parts) {
    assert.ok(part.length <= MAX_PART_CHARS);
    assert.match(part, /^Paragraph \d+\./);
    assert.match(part, /\.$/);
  }
  assert.deepEqual(words(parts.join(' ')), words(text));
});

test('text without paragraph breaks is split at sentence ends', () => {
  const text = 'This is one sentence about biology. '.repeat(5000).trim();
  const parts = splitText(text);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.length <= MAX_PART_CHARS);
    assert.match(part, /^This .*\.$/s);
  }
  assert.deepEqual(words(parts.join(' ')), words(text));
});

test('text without punctuation is split at spaces and loses no words', () => {
  const text = 'word '.repeat(30000).trim();
  const parts = splitText(text);
  for (const part of parts) assert.ok(part.length <= MAX_PART_CHARS);
  assert.deepEqual(words(parts.join(' ')), words(text));
});

test('up to 10 notes are merged in one call', async () => {
  const groups = [];
  const result = await reduceNotes(['a', 'b', 'c'], async (group) => {
    groups.push(group);
    return `[${group.join(',')}]`;
  });
  assert.equal(result, '[a,b,c]');
  assert.deepEqual(groups, [['a', 'b', 'c']]);
  assert.equal(await reduceNotes(['only'], async () => assert.fail('no merge needed')), 'only');
});

test('more than 10 notes are merged in groups of 10, then the group results', async () => {
  const notes = Array.from({ length: 25 }, (_, i) => `n${i + 1}`);
  const groups = [];
  const result = await reduceNotes(notes, async (group) => {
    groups.push(group.length);
    return `[${group.join(',')}]`;
  });
  assert.deepEqual(groups, [10, 10, 5, 3]);
  assert.equal(
    result,
    `[[${notes.slice(0, 10).join(',')}],[${notes.slice(10, 20).join(',')}],[${notes.slice(20).join(',')}]]`
  );
});

test('a book of about 40 parts is merged in two levels', async () => {
  const notes = Array.from({ length: 41 }, (_, i) => `n${i + 1}`);
  const groups = [];
  await reduceNotes(notes, async (group) => {
    groups.push(group.length);
    return 'merged';
  });
  // 41 = 4 groups of 10 plus 1 note that needs no merge; then 5 results are merged once
  assert.equal(GROUP_SIZE, 10);
  assert.deepEqual(groups, [10, 10, 10, 10, 5]);
});

test('short material: one call with the exact notes prompt and no part line', async () => {
  const { calls, chat } = mockChat();
  const result = await generateNotes({ title: 'Cells', content: 'Cells are small.' }, { chat });
  assert.equal(result, 'notes 1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].system, NOTES_SYSTEM_PROMPT);
  assert.equal(calls[0].maxOutputTokens, 16000);
  assert.equal(
    calls[0].user,
    'Material title: Cells\n\n<material>\nCells are small.\n</material>'
  );
});

test('long material: part notes with part lines, then merges with the merge prompt', async () => {
  const { calls, chat } = mockChat();
  const content = makeText(12 * MAX_PART_CHARS);
  const partCount = splitText(content).length;
  assert.ok(partCount > 10);

  await generateNotes({ title: 'Big book', content }, { chat });

  const partCalls = calls.filter((c) => c.system === NOTES_SYSTEM_PROMPT);
  const mergeCalls = calls.filter((c) => c.system === MERGE_SYSTEM_PROMPT);
  assert.equal(partCalls.length, partCount);
  assert.equal(mergeCalls.length, Math.ceil(partCount / 10) + 1);
  partCalls.forEach((call, i) => {
    assert.ok(call.user.startsWith(`Material title: Big book\nThis is part ${i + 1} of ${partCount}.\n\n<material>\n`));
  });
  assert.match(mergeCalls[0].user, /^Material title: Big book\n\n<notes part="1">\nnotes 1\n<\/notes>/);
  for (const call of calls) assert.equal(call.maxOutputTokens, 16000);
});

test('the local provider splits into parts of LOCAL_PART_CHARS and passes the model on', async () => {
  process.env.LOCAL_PART_CHARS = '15000';
  const { calls, chat } = mockChat();
  const content = makeText(MAX_PART_CHARS);
  assert.equal(splitText(content).length, 2);

  await generateNotes({ title: 'Book', content }, { provider: 'local', model: 'gemma3:4b', chat });

  const partCalls = calls.filter((c) => c.system === NOTES_SYSTEM_PROMPT);
  assert.equal(partCalls.length, splitText(content, 15000).length);
  assert.ok(partCalls.length >= 4);
  for (const call of partCalls) {
    assert.ok(call.user.length < 15000 + 200);
  }
  for (const call of calls) assert.deepEqual([call.provider, call.model], ['local', 'gemma3:4b']);
});

test('the OpenAI provider keeps parts of 60,000 characters', async () => {
  process.env.LOCAL_PART_CHARS = '15000';
  const { calls, chat } = mockChat();
  const content = makeText(MAX_PART_CHARS);
  await generateNotes({ title: 'Book', content }, { provider: 'openai', model: 'gpt-5-mini', chat });
  assert.equal(calls.filter((c) => c.system === NOTES_SYSTEM_PROMPT).length, 2);
});

// The context check from the specification, computed here independently of server/llm.js:
// (system + user characters) / 3 + output tokens, plus 10%, must fit the context
const fitsContext = (call, context, output = 2048) =>
  (Math.ceil(call.system.length / 3) + Math.ceil(call.user.length / 3) + output) * 1.1 <= context;

// Runs fn with the local context settings, then restores the defaults
async function withLocalSettings({ context, partChars = 15000 }, fn) {
  process.env.LOCAL_CONTEXT_TOKENS = String(context);
  process.env.LOCAL_PART_CHARS = String(partChars);
  try {
    return await fn();
  } finally {
    delete process.env.LOCAL_CONTEXT_TOKENS;
    process.env.LOCAL_PART_CHARS = '15000';
  }
}

// Mock for a local model with long replies (about replyChars characters); each reply starts
// with the part numbers it covers, so the merge tree can be checked
function longReplyChat(replyChars) {
  const calls = [];
  const chat = async (request) => {
    calls.push(request);
    const covers =
      request.system === NOTES_SYSTEM_PROMPT
        ? [request.user.match(/This is part (\d+) of/)?.[1] ?? '1']
        : [...request.user.matchAll(/^covers: (.*)$/gm)].flatMap((m) => m[1].split(','));
    const head = `covers: ${covers.join(',')}\n`;
    return { text: head + 'x'.repeat(Math.max(0, replyChars - head.length)) };
  };
  return { calls, chat };
}

const coveredParts = (notes) => notes.match(/^covers: (.*)$/m)[1].split(',').map(Number);
const notesInMerge = (call) => call.user.match(/<notes part="/g).length;
const BOOK = makeText(40 * 15000);

async function generateBook(context, content = BOOK, partChars = 15000) {
  return withLocalSettings({ context, partChars }, async () => {
    const { calls, chat } = longReplyChat(6000);
    const result = await generateNotes(
      { title: 'Big book', content },
      { provider: 'local', model: 'gemma3:4b', chat }
    );
    return { calls, result };
  });
}

test('local, 16384 tokens: 40 long partial results are merged in levels that all fit', async () => {
  const partCount = splitText(BOOK, 15000).length;
  assert.ok(partCount >= 40);
  const { calls, result } = await generateBook(16384);

  for (const call of calls) {
    assert.ok(fitsContext(call, 16384), `a request of ${call.user.length} characters is too large`);
    assert.equal(call.maxOutputTokens, 2048);
  }
  const partCalls = calls.filter((c) => c.system === NOTES_SYSTEM_PROMPT);
  const mergeCalls = calls.filter((c) => c.system === MERGE_SYSTEM_PROMPT);
  assert.equal(partCalls.length, partCount);
  assert.equal(partCalls.length + mergeCalls.length, calls.length);

  // Every merge has at least two notes, and some merges combine earlier merges (more levels)
  for (const call of mergeCalls) assert.ok(notesInMerge(call) >= 2);
  assert.ok(mergeCalls.length > 2);
  assert.ok(mergeCalls.some((call) => /^covers: \d+,\d+/m.test(call.user)));

  // The final merge covers every part exactly once, in order
  assert.deepEqual(coveredParts(result), Array.from({ length: partCount }, (_, i) => i + 1));
  assert.equal(calls.at(-1).system, MERGE_SYSTEM_PROMPT);
});

test('local, 131072 tokens: the same material needs fewer calls', async () => {
  const small = await generateBook(16384);
  const large = await generateBook(131072);

  for (const call of large.calls) assert.ok(fitsContext(call, 131072));
  const largeMerges = large.calls.filter((c) => c.system === MERGE_SYSTEM_PROMPT);
  assert.equal(largeMerges.length, 1);
  assert.ok(large.calls.length < small.calls.length);
  assert.deepEqual(coveredParts(large.result), coveredParts(small.result));
});

test('local: a part that does not fit with its prompt is halved until it fits', async () => {
  const content = makeText(150000);
  // LOCAL_PART_CHARS is larger than the material, so it starts as one part
  assert.equal(splitText(content, 200000).length, 1);
  const { calls } = await generateBook(16384, content, 200000);

  const partCalls = calls.filter((c) => c.system === NOTES_SYSTEM_PROMPT);
  assert.ok(partCalls.length >= 3);
  for (const call of calls) assert.ok(fitsContext(call, 16384));

  // Parts are cut at paragraph ends, numbered, and lose no words
  const materials = partCalls.map((call, i) => {
    assert.ok(call.user.includes(`This is part ${i + 1} of ${partCalls.length}.\n`));
    return call.user.match(/<material>\n([\s\S]*)\n<\/material>/)[1];
  });
  for (const material of materials) {
    assert.match(material, /^Paragraph \d+\./);
    assert.match(material, /\.$/);
  }
  assert.deepEqual(words(materials.join(' ')), words(content));

  // With a large context the same part is sent whole
  const large = await generateBook(131072, content, 200000);
  assert.equal(large.calls.length, 1);
});

test('splitInHalf cuts near the middle at a paragraph, else a sentence, else a space', () => {
  assert.deepEqual(splitInHalf('One one.\n\nTwo two.\n\nThree.\n\nFour four.'), [
    'One one.\n\nTwo two.',
    'Three.\n\nFour four.',
  ]);
  assert.deepEqual(splitInHalf('First part here. Second part here.'), ['First part here.', 'Second part here.']);
  assert.deepEqual(splitInHalf('aaaa bbbb'), ['aaaa', 'bbbb']);
});

test('local merges are grouped by size; a note left on its own moves to the next level', async () => {
  const groups = [];
  // At most three notes fit in one merge
  const result = await reduceNotesToFit(['a', 'b', 'c', 'd', 'e', 'f', 'g'], {
    merge: async (group) => {
      groups.push(group.join(''));
      return `(${group.join('')})`;
    },
    compress: async () => assert.fail('nothing needs shortening'),
    fits: (group) => group.length <= 3,
  });
  assert.deepEqual(groups, ['abc', 'def', '(abc)(def)g']);
  assert.equal(result, '((abc)(def)g)');
});

test('local: notes that never fit together and cannot be shortened give the context message', async () => {
  await assert.rejects(
    reduceNotesToFit(['aaaa', 'bbbb'], {
      merge: async () => assert.fail('no merge is sent'),
      compress: async (notes) => notes,
      fits: () => false,
    }),
    { message: LOCAL_CONTEXT_ERROR }
  );
});

const COMPRESS_SYSTEM = `${NOTES_SYSTEM_PROMPT}\n\n${COMPRESS_INSTRUCTION}`;
const notesOf = (call) => [...call.user.matchAll(/<notes(?: part="\d+")?>\n([\s\S]*?)\n<\/notes>/g)].map((m) => m[1]);
const kindOf = (call) =>
  ({ [NOTES_SYSTEM_PROMPT]: 'part', [COMPRESS_SYSTEM]: 'compress', [MERGE_SYSTEM_PROMPT]: 'merge' })[
    call.system
  ];

// A local model whose partial results have partChars characters (in sentences, so they can be
// split); compress halves its input, merge joins the first words of its notes
function compressingChat(partChars, { mergeTooLong = () => false } = {}) {
  const calls = [];
  const chat = async (request) => {
    calls.push(request);
    const kind = kindOf(request);
    if (kind === 'part') {
      const n = request.user.match(/This is part (\d+) of/)?.[1] ?? '1';
      return { text: `P${n}. ${'Key point here. '.repeat(partChars / 16)}`.slice(0, partChars).trim() };
    }
    const notes = notesOf(request);
    if (kind === 'compress') return { text: notes[0].slice(0, Math.floor(notes[0].length / 2)).trim() };
    if (mergeTooLong(notes)) throw new OutputLimitError(LOCAL_OUTPUT_TOO_LONG_ERROR);
    return { text: `M(${notes.map((n) => n.split(/[ .]/)[0]).join('+')})` };
  };
  return { calls, chat };
}

// LOCAL_CONTEXT_TOKENS=8192 with 2048 output tokens: about 16,000 characters of input
async function generateSmallContext(content, chat, partChars = 8500) {
  return withLocalSettings({ context: 8192, partChars }, () =>
    generateNotes({ title: 'Book', content }, { provider: 'local', model: 'gemma3:4b', chat })
  );
}

test('local: two partial results that together exceed the limit are compressed before merging', async () => {
  // Two partial results of 8000 characters (about 2700 tokens each) do not fit in one merge
  const { calls, chat } = compressingChat(8000);
  const result = await generateSmallContext(makeText(16000), chat);

  assert.deepEqual(calls.map(kindOf), ['part', 'part', 'compress', 'compress', 'merge']);
  for (const call of calls) assert.ok(fitsContext(call, 8192), `${kindOf(call)} is too large`);
  // Each partial result is shortened on its own, with the style instructions and the
  // compress instruction, then the shortened results are merged
  assert.equal(notesOf(calls[2]).length, 1);
  assert.ok(notesOf(calls[2])[0].startsWith('P1.'));
  assert.ok(notesOf(calls[3])[0].startsWith('P2.'));
  assert.ok(notesOf(calls[4]).every((notes) => notes.length <= 4000));
  assert.equal(result, 'M(P1+P2)');
});

test('local: a partial result too large to compress in one call is split and its halves compressed', async () => {
  // The first partial result (20,000 characters) does not fit even a compress call on its own
  const { calls, chat } = compressingChat(20000);
  await generateSmallContext(makeText(16000), chat);

  for (const call of calls) assert.ok(fitsContext(call, 8192), `${kindOf(call)} is too large`);
  const compressCalls = calls.filter((c) => kindOf(c) === 'compress');
  assert.ok(compressCalls.length >= 4);
  assert.ok(compressCalls.every((call) => notesOf(call)[0].length < 20000));
  assert.equal(kindOf(calls.at(-1)), 'merge');
});

test('local: a merge cut off by the output limit is merged again from compressed notes', async () => {
  // Merging is cut off while the notes together have more than 6000 characters
  const merged = (notes) => notes.reduce((sum, n) => sum + n.length, 0) > 6000;
  const { calls, chat } = compressingChat(4000, { mergeTooLong: merged });
  const result = await generateSmallContext(makeText(16000), chat);

  assert.deepEqual(calls.map(kindOf), ['part', 'part', 'merge', 'compress', 'compress', 'merge']);
  assert.equal(result, 'M(P1+P2)');
});

test('local: a cut-off merge of more than two notes is first split into smaller merges', async () => {
  const merges = [];
  const result = await reduceNotesToFit(['a', 'b', 'c', 'd', 'e'], {
    merge: async (group) => {
      merges.push(group.join(''));
      // Merging more than two notes is cut off by the output limit
      if (group.length > 2) throw new OutputLimitError(LOCAL_OUTPUT_TOO_LONG_ERROR);
      return group.join('');
    },
    compress: async () => assert.fail('no shortening needed'),
    fits: () => true,
  });
  // abcde is cut off, so abc and de are merged first; abc is cut off too, so ab first, then ab + c
  assert.deepEqual(merges, ['abcde', 'abc', 'ab', 'abc', 'de', 'abcde']);
  assert.equal(result, 'abcde');
});

test('local: shortening that removes less than a tenth stops with the error', async () => {
  let compressCalls = 0;
  await assert.rejects(
    reduceNotesToFit(['a'.repeat(100), 'b'.repeat(100)], {
      merge: async () => {
        throw new OutputLimitError(LOCAL_OUTPUT_TOO_LONG_ERROR);
      },
      // Removes only 5% each time
      compress: async (notes) => {
        compressCalls++;
        return notes.slice(0, Math.ceil(notes.length * 0.95));
      },
      fits: () => true,
    }),
    { message: LOCAL_OUTPUT_TOO_LONG_ERROR }
  );
  assert.equal(compressCalls, 2);
});

test('countMerges gives the merges of groups of 10, level by level', () => {
  assert.deepEqual([1, 2, 10, 11, 25, 41].map((n) => countMerges(n)), [0, 1, 1, 2, 4, 5]);
});

// Records every progress report of a generateNotes run
function recordProgress() {
  const reports = [];
  return { reports, onProgress: (state) => reports.push(state) };
}

test('OpenAI progress: parts then merges, with the exact total planned from the start', async () => {
  const { calls, chat } = mockChat();
  const { reports, onProgress } = recordProgress();
  await generateNotes({ title: 'Big book', content: makeText(12 * MAX_PART_CHARS) }, { chat, onProgress });

  assert.ok(calls.length > 10);
  assert.ok(reports.every((r) => r.total === calls.length));
  assert.deepEqual(reports.at(-1), { phase: 'merge', done: calls.length, total: calls.length });
  const phases = [...new Set(reports.map((r) => r.phase))];
  assert.deepEqual(phases, ['parts', 'merge']);
  // done counts up by one per call
  const dones = reports.map((r) => r.done);
  assert.deepEqual([...new Set(dones)], Array.from({ length: calls.length + 1 }, (_, i) => i));
});

test('local progress: the total grows when partial results have to be compressed', async () => {
  const { calls, chat } = compressingChat(8000);
  const { reports, onProgress } = recordProgress();
  await withLocalSettings({ context: 8192, partChars: 8500 }, () =>
    generateNotes(
      { title: 'Book', content: makeText(16000) },
      { provider: 'local', model: 'gemma3:4b', chat, onProgress }
    )
  );

  // Planned at first: two parts and one merge; then two compress calls are added
  assert.equal(reports[0].total, 3);
  assert.deepEqual(reports.at(-1), { phase: 'merge', done: 5, total: 5 });
  assert.equal(calls.length, 5);
  assert.ok(reports.some((r) => r.phase === 'compress'));
  assert.ok(reports.every((r) => r.done <= r.total));
});

test('local progress: a cut-off merge adds the compress calls and the merge again', async () => {
  const merged = (notes) => notes.reduce((sum, n) => sum + n.length, 0) > 6000;
  const { calls, chat } = compressingChat(4000, { mergeTooLong: merged });
  const { reports, onProgress } = recordProgress();
  await withLocalSettings({ context: 8192, partChars: 8500 }, () =>
    generateNotes(
      { title: 'Book', content: makeText(16000) },
      { provider: 'local', model: 'gemma3:4b', chat, onProgress }
    )
  );
  assert.equal(calls.length, 6);
  assert.deepEqual(reports.at(-1), { phase: 'merge', done: 6, total: 6 });
});

test('estimateMergesToFit counts merges level by level and compress calls when nothing fits', () => {
  // At most 3 notes of any length fit together
  assert.equal(estimateMergesToFit([1, 1, 1, 1, 1, 1, 1], (group) => group.length <= 3), 3);
  // Notes fit in pairs only when together at most 100 characters: two compress calls, one merge
  assert.equal(
    estimateMergesToFit([80, 80], (group) => group.join('').length <= 100),
    3
  );
});

test('local: the output limit error remains when shortening no longer helps', async () => {
  const { chat } = compressingChat(4000, { mergeTooLong: () => true });
  await assert.rejects(generateSmallContext(makeText(16000), chat), {
    message: LOCAL_OUTPUT_TOO_LONG_ERROR,
  });
});

test('local: when the prompt alone does not fit, no request is sent', async () => {
  process.env.LOCAL_MAX_OUTPUT_TOKENS = '1000';
  try {
    await withLocalSettings({ context: 1000 }, () =>
      assert.rejects(
        generateNotes(
          { title: 'Cells', content: 'Cells are small.' },
          { provider: 'local', model: 'gemma3:4b', chat: async () => assert.fail('no call') }
        ),
        { message: LOCAL_CONTEXT_ERROR }
      )
    );
  } finally {
    delete process.env.LOCAL_MAX_OUTPUT_TOKENS;
  }
});

test('a merge that is too long is split: each half of the group is merged, then the results', async () => {
  const merges = [];
  // Part notes are "n1".."n3"; a merge of more than two notes is too long
  const chat = async ({ system, user }) => {
    if (system === NOTES_SYSTEM_PROMPT) return { text: `n${user.match(/part (\d+) of/)[1]}` };
    const notes = [...user.matchAll(/<notes part="\d+">\n(.*)\n<\/notes>/g)].map((m) => m[1]);
    if (notes.length > 2) throw new OutputLimitError();
    merges.push(notes);
    return { text: `(${notes.join('+')})` };
  };
  const result = await generateNotes(
    { title: 'Book', content: makeText(2.5 * MAX_PART_CHARS) },
    { provider: 'openai', model: 'gpt-5-mini', chat }
  );
  assert.deepEqual(merges, [['n1', 'n2'], ['(n1+n2)', 'n3']]);
  assert.equal(result, '((n1+n2)+n3)');
});

test('notes that stay too long for an unsplittable part give the error', async () => {
  const chat = async () => {
    throw new OutputLimitError();
  };
  await assert.rejects(
    generateNotes({ title: 'x', content: 'word' }, { provider: 'openai', model: 'gpt-5-mini', chat }),
    OutputLimitError
  );
});

test('prompts match the specification verbatim', () => {
  const spec = fs.readFileSync(new URL('../docs/spec.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const blocks = [...spec.matchAll(/```text\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  for (const style of NOTE_STYLES) {
    assert.ok(blocks.includes(style.prompt), `${style.id} prompt differs from docs/spec.md`);
  }
  assert.ok(blocks.includes(MERGE_INSTRUCTION), 'merge instruction differs from docs/spec.md');
  assert.equal(getStyle('study-notes').prompt, NOTES_SYSTEM_PROMPT);
});

test('the six styles are defined with names and descriptions', () => {
  assert.deepEqual(
    NOTE_STYLES.map((s) => s.id),
    ['study-notes', 'brief', 'outline', 'cheat-sheet', 'lecture-guide', 'simple']
  );
  for (const style of NOTE_STYLES) {
    assert.ok(style.name && style.description && style.prompt);
  }
  assert.equal(new Set(NOTE_STYLES.map((s) => s.prompt)).size, NOTE_STYLES.length);
});

test('each style uses its own prompt for a short material', async () => {
  for (const style of NOTE_STYLES) {
    const { calls, chat } = mockChat();
    await generateNotes({ title: 'Cells', content: 'Cells are small.' }, { style: style.id, chat });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].system, style.prompt);
    assert.equal(calls[0].user, 'Material title: Cells\n\n<material>\nCells are small.\n</material>');
  }
});

test('long material in a style: parts use the style prompt, merges insert it into the merge instruction', async () => {
  const outline = getStyle('outline');
  const merge = mergePrompt(outline);
  assert.ok(merge.startsWith('Below are partial results for individual parts'));
  assert.ok(merge.endsWith(`Instructions:\n${outline.prompt}`));
  assert.ok(!merge.includes('{style instructions}'));

  const calls = [];
  const chat = async ({ system, user }) => {
    calls.push({ system, user });
    return { text: system === outline.prompt ? `part ${calls.length}` : `merged ${calls.length}` };
  };
  const content = makeText(12 * MAX_PART_CHARS);
  const partCount = splitText(content).length;
  await generateNotes({ title: 'Big book', content }, { style: 'outline', chat });

  const partCalls = calls.filter((c) => c.system === outline.prompt);
  const mergeCalls = calls.filter((c) => c.system === merge);
  assert.equal(partCalls.length, partCount);
  assert.equal(mergeCalls.length, Math.ceil(partCount / 10) + 1);
  assert.equal(partCalls.length + mergeCalls.length, calls.length);
  partCalls.forEach((call, i) => {
    assert.ok(call.user.includes(`This is part ${i + 1} of ${partCount}.\n`));
  });
});

test('an unknown style is rejected before any model call', async () => {
  const chat = async () => assert.fail('model must not be called');
  await assert.rejects(
    generateNotes({ title: 'x', content: 'y' }, { style: 'poem', chat }),
    /Unknown note style "poem"/
  );
});

test('transient OpenAI errors are retried at most three times', async () => {
  let attempts = 0;
  const serverError = () => new OpenAI.InternalServerError(500, { message: 'boom' }, 'boom', new Headers());
  await assert.rejects(
    withRetries(async () => {
      attempts++;
      throw serverError();
    }, { baseDelayMs: 1 }),
    OpenAI.InternalServerError
  );
  assert.equal(attempts, 4);

  attempts = 0;
  const result = await withRetries(async () => {
    attempts++;
    if (attempts < 3) throw serverError();
    return 'ok';
  }, { baseDelayMs: 1 });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('non-transient errors are not retried', async () => {
  let attempts = 0;
  await assert.rejects(
    withRetries(async () => {
      attempts++;
      throw new OpenAI.AuthenticationError(401, { message: 'bad key' }, 'bad key', new Headers());
    }, { baseDelayMs: 1 })
  );
  assert.equal(attempts, 1);
});
