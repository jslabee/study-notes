import { test, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFakeOllama } from './helpers/fake-ollama.js';
import { installFakeOpenAI } from './helpers/fake-openai.js';

// Temporary database; OpenAI is faked and answers with responses cut off by the output limit
// whenever fakeOpenAI.cutOff(body) is true
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-notes-output-limit-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
const fakeOllama = installFakeOllama({ dim: 8 });
const fakeOpenAI = installFakeOpenAI({ answer: '## Notes' });

const llm = await import('../server/llm.js');
const { getDb, closeDb } = await import('../server/db.js');
const { enqueue, whenIdle } = await import('../server/jobs.js');
const { getStyle, mergePrompt } = await import('../server/notes/styles.js');

const TOO_LONG = llm.OUTPUT_TOO_LONG_ERROR;
const MERGE = mergePrompt(getStyle('study-notes'));
const MATERIAL = 'Cells are the units of life.\n\nEnzymes speed up reactions.';
// The usage lines are checked in one test; the console stays quiet
const log = mock.method(console, 'log', () => {});

let materialId;

beforeEach(() => {
  fakeOpenAI.requests.length = 0;
  fakeOpenAI.cutOff = null;
  delete process.env.OPENAI_MAX_OUTPUT_TOKENS;
  delete process.env.OPENAI_REASONING_EFFORT;
  log.mock.resetCalls();
  if (materialId) return;
  const db = getDb();
  const courseId = db.prepare("INSERT INTO courses (name) VALUES ('Biology')").run().lastInsertRowid;
  materialId = Number(
    db
      .prepare("INSERT INTO materials (course_id, title, type, content, status) VALUES (?, 'Cells', 'text', ?, 'ready')")
      .run(courseId, MATERIAL).lastInsertRowid
  );
});

after(() => {
  log.mock.restore();
  closeDb();
  fakeOpenAI.restore();
  fakeOllama.restore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ask = () => llm.chat({ provider: 'openai', model: 'test-model', system: 'S', user: 'U' });
const limits = () => fakeOpenAI.requests.map((r) => r.body.max_output_tokens);

// Runs a notes job with OpenAI and returns the stored row
async function generateNotesRow() {
  const db = getDb();
  db.prepare('DELETE FROM notes WHERE material_id = ?').run(materialId);
  const id = db
    .prepare("INSERT INTO notes (material_id, style, status) VALUES (?, 'study-notes', 'processing')")
    .run(materialId).lastInsertRowid;
  enqueue('notes', Number(id), { provider: 'openai', model: 'test-model' });
  await whenIdle();
  return db.prepare('SELECT status, content, error FROM notes WHERE id = ?').get(id);
}

test('OpenAI calls use OPENAI_MAX_OUTPUT_TOKENS (default 16000) and no reasoning setting', async () => {
  await ask();
  process.env.OPENAI_MAX_OUTPUT_TOKENS = '9000';
  await llm.chat({ provider: 'openai', model: 'test-model', system: 'S', user: 'U', maxOutputTokens: 4000 });
  assert.deepEqual(limits(), [16000, 9000]);
  assert.ok(fakeOpenAI.requests.every((r) => !('reasoning' in r.body)));
});

test('OPENAI_REASONING_EFFORT is sent as the reasoning effort when set', async () => {
  process.env.OPENAI_REASONING_EFFORT = 'low';
  await ask();
  assert.deepEqual(fakeOpenAI.requests[0].body.reasoning, { effort: 'low' });
});

test('an incomplete response is retried once with double the limit', async () => {
  fakeOpenAI.cutOff = (body) => body.max_output_tokens < 32000;
  const reply = await ask();
  assert.equal(reply.text, '## Notes');
  assert.deepEqual(limits(), [16000, 32000]);
});

test('the higher limit is capped at 32000, and there is no retry when it would not be higher', async () => {
  process.env.OPENAI_MAX_OUTPUT_TOKENS = '20000';
  fakeOpenAI.cutOff = () => true;
  await assert.rejects(ask(), { message: TOO_LONG });
  assert.deepEqual(limits(), [20000, 32000]);

  fakeOpenAI.requests.length = 0;
  process.env.OPENAI_MAX_OUTPUT_TOKENS = '32000';
  await assert.rejects(ask(), llm.OutputLimitError);
  assert.deepEqual(limits(), [32000]);
});

test('a second incomplete response gives the "too long" error, never the truncated text', async () => {
  fakeOpenAI.cutOff = () => true;
  await assert.rejects(ask(), (err) => {
    assert.ok(err instanceof llm.OutputLimitError);
    assert.equal(err.message, TOO_LONG);
    return true;
  });
  assert.deepEqual(limits(), [16000, 32000]);
});

test('the token usage of each call is logged, with reasoning tokens', async () => {
  fakeOpenAI.cutOff = (body) => body.max_output_tokens < 32000;
  await ask();
  const lines = log.mock.calls.map((call) => call.arguments.join(' ')).filter((l) => l.startsWith('[llm]'));
  assert.deepEqual(lines, [
    '[llm] openai test-model: input 1, output 16000, reasoning 15995 tokens (limit 16000, incomplete)',
    '[llm] openai test-model: input 1, output 10, reasoning 4 tokens (limit 32000)',
  ]);
});

test('notes still incomplete after the retry are made from smaller parts, then merged', async () => {
  // Only the notes for the whole material are too long
  fakeOpenAI.cutOff = (body) => body.input.includes(MATERIAL);
  const row = await generateNotesRow();
  assert.deepEqual(row, { status: 'ready', content: '## Notes', error: null });

  const inputs = fakeOpenAI.requests.map((r) => r.body.input);
  assert.deepEqual(limits(), [16000, 32000, 16000, 16000, 16000]);
  assert.ok(inputs[2].includes('This is part 1 of 2.\n') && inputs[2].includes('Cells are the units of life.'));
  assert.ok(inputs[3].includes('This is part 2 of 2.\n') && inputs[3].includes('Enzymes speed up reactions.'));
  assert.equal(fakeOpenAI.requests[4].body.instructions, MERGE);

  // The finished job logs its duration, calls (the retry at a higher limit is part of one call)
  // and model
  const lines = log.mock.calls.map((c) => c.arguments.join(' ')).filter((l) => l.startsWith('[notes]'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[notes\] Notes \d+ \(study-notes\) ready: \d+ s, 4 calls, openai:test-model$/);
});

test('truncated text is never stored: when every attempt is cut off the notes fail', async () => {
  fakeOpenAI.cutOff = () => true;
  const row = await generateNotesRow();
  assert.equal(row.status, 'error');
  assert.equal(row.error, TOO_LONG);
  assert.ok(!row.content?.includes('truncated'));
  assert.ok(
    log.mock.calls.some((c) => /^\[notes\] Notes \d+ \(study-notes\) failed: \d+ s, \d+ calls, openai:test-model$/.test(c.arguments[0]))
  );
});

test('a final merge that is still too long fails the notes instead of storing a truncated merge', async () => {
  fakeOpenAI.cutOff = (body) => body.input.includes(MATERIAL) || body.instructions === MERGE;
  const row = await generateNotesRow();
  assert.deepEqual(
    [row.status, row.error, row.content?.includes('truncated') ?? false],
    ['error', TOO_LONG, false]
  );
  // Two parts were made, and their merge was tried twice
  assert.equal(fakeOpenAI.requests.filter((r) => r.body.instructions === MERGE).length, 2);
});
