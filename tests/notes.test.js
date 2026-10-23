import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import OpenAI from 'openai';
import { withRetries } from '../server/llm.js';
import {
  GROUP_SIZE,
  MAX_PART_CHARS,
  MERGE_SYSTEM_PROMPT,
  NOTES_SYSTEM_PROMPT,
  generateNotes,
  reduceNotes,
  splitText,
} from '../server/notes/generate.js';

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

// Mock for llm.complete that records every call
function mockComplete() {
  const calls = [];
  const complete = async ({ system, user, maxOutputTokens }) => {
    calls.push({ system, user, maxOutputTokens });
    return system === NOTES_SYSTEM_PROMPT ? `notes ${calls.length}` : `merged ${calls.length}`;
  };
  return { calls, complete };
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
  const { calls, complete } = mockComplete();
  const result = await generateNotes({ title: 'Cells', content: 'Cells are small.' }, { complete });
  assert.equal(result, 'notes 1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].system, NOTES_SYSTEM_PROMPT);
  assert.equal(calls[0].maxOutputTokens, 4000);
  assert.equal(
    calls[0].user,
    'Material title: Cells\n\n<material>\nCells are small.\n</material>'
  );
});

test('long material: part notes with part lines, then merges with the merge prompt', async () => {
  const { calls, complete } = mockComplete();
  const content = makeText(12 * MAX_PART_CHARS);
  const partCount = splitText(content).length;
  assert.ok(partCount > 10);

  await generateNotes({ title: 'Big book', content }, { complete });

  const partCalls = calls.filter((c) => c.system === NOTES_SYSTEM_PROMPT);
  const mergeCalls = calls.filter((c) => c.system === MERGE_SYSTEM_PROMPT);
  assert.equal(partCalls.length, partCount);
  assert.equal(mergeCalls.length, Math.ceil(partCount / 10) + 1);
  partCalls.forEach((call, i) => {
    assert.ok(call.user.startsWith(`Material title: Big book\nThis is part ${i + 1} of ${partCount}.\n\n<material>\n`));
  });
  assert.match(mergeCalls[0].user, /^Material title: Big book\n\n<notes part="1">\nnotes 1\n<\/notes>/);
  for (const call of calls) assert.equal(call.maxOutputTokens, 4000);
});

test('prompts match the specification verbatim', () => {
  const spec = fs.readFileSync(new URL('../docs/spec.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const blocks = [...spec.matchAll(/```text\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  assert.ok(blocks.includes(NOTES_SYSTEM_PROMPT), 'notes prompt differs from docs/spec.md');
  assert.ok(blocks.includes(MERGE_SYSTEM_PROMPT), 'merge prompt differs from docs/spec.md');
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
