import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFakeOllama } from './helpers/fake-ollama.js';
import { installFakeOpenAI } from './helpers/fake-openai.js';

// Temporary database; Ollama and OpenAI are faked, so no real calls are made
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-notes-styles-api-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OPENAI_MODELS = '';
process.env.ALLOW_EXTERNAL = 'true';
const fakeOllama = installFakeOllama({ dim: 8 });
const fakeOpenAI = installFakeOpenAI();

const { app } = await import('../server/index.js');
const { getDb, closeDb } = await import('../server/db.js');
const { enqueue, whenIdle } = await import('../server/jobs.js');
const { NOTE_STYLES, getStyle } = await import('../server/notes/styles.js');

let server;
let baseUrl;
let materialId;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const db = getDb();
  const courseId = db.prepare("INSERT INTO courses (name) VALUES ('Biology')").run().lastInsertRowid;
  materialId = Number(
    db
      .prepare("INSERT INTO materials (course_id, title, type, content, status) VALUES (?, 'Cells', 'text', 'Cells are small.', 'ready')")
      .run(courseId).lastInsertRowid
  );
});

after(() => {
  server.close();
  closeDb();
  fakeOpenAI.restore();
  fakeOllama.restore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const notesUrl = (suffix = '') => `${baseUrl}/api/materials/${materialId}/notes${suffix}`;

async function generate(style, answer) {
  fakeOpenAI.answer = answer;
  const res = await fetch(notesUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ style, provider: 'openai' }),
  });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { style, status: 'processing' });
  await whenIdle();
}

test('GET /api/note-styles lists id, name and description of every style', async () => {
  const styles = await (await fetch(`${baseUrl}/api/note-styles`)).json();
  assert.deepEqual(
    styles,
    NOTE_STYLES.map(({ id, name, description }) => ({ id, name, description }))
  );
  assert.equal(styles[0].id, 'study-notes');
});

test('two styles of the same material are stored separately, each from its own prompt', async () => {
  fakeOpenAI.requests.length = 0;
  await generate('outline', '## Outline notes');
  await generate('brief', '## Brief notes');

  assert.deepEqual(
    fakeOpenAI.requests.map((r) => r.body.instructions),
    [getStyle('outline').prompt, getStyle('brief').prompt]
  );

  // The list follows the order in which styles are defined
  const list = await (await fetch(notesUrl())).json();
  assert.deepEqual(
    list.map(({ style, status, content, model }) => ({ style, status, content, model })),
    [
      { style: 'brief', status: 'ready', content: '## Brief notes', model: 'openai:test-model' },
      { style: 'outline', status: 'ready', content: '## Outline notes', model: 'openai:test-model' },
    ]
  );

  const outline = await (await fetch(notesUrl('/outline'))).json();
  assert.equal(outline.style, 'outline');
  assert.equal(outline.content, '## Outline notes');
});

test('regenerating one style leaves the other unchanged', async () => {
  await generate('brief', '## Brief again');
  assert.equal((await (await fetch(notesUrl('/brief'))).json()).content, '## Brief again');
  assert.equal((await (await fetch(notesUrl('/outline'))).json()).content, '## Outline notes');
});

test('POST without a style generates study notes', async () => {
  fakeOpenAI.answer = '## Summary';
  const res = await fetch(notesUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'openai' }),
  });
  assert.deepEqual(await res.json(), { style: 'study-notes', status: 'processing' });
  await whenIdle();
  assert.equal((await (await fetch(notesUrl('/study-notes'))).json()).status, 'ready');
});

test('DELETE removes notes in one style only', async () => {
  let res = await fetch(notesUrl('/brief'), { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deleted: true });
  assert.equal((await fetch(notesUrl('/brief'))).status, 404);
  assert.equal((await fetch(notesUrl('/outline'))).status, 200);

  res = await fetch(notesUrl('/brief'), { method: 'DELETE' });
  assert.equal(res.status, 404);
});

test('notes deleted while waiting for their job are not generated', async () => {
  fakeOpenAI.requests.length = 0;
  const { id } = getDb()
    .prepare("INSERT INTO notes (material_id, style) VALUES (?, 'simple') RETURNING id")
    .get(materialId);
  assert.equal((await fetch(notesUrl('/simple'), { method: 'DELETE' })).status, 200);
  // The job for the deleted row runs afterwards and finds nothing to do
  enqueue('notes', id, { provider: 'openai', model: 'test-model' });
  await whenIdle();
  assert.equal(fakeOpenAI.requests.length, 0);
  assert.equal(getDb().prepare("SELECT count(*) AS n FROM notes WHERE style = 'simple'").get().n, 0);
});

test('notes being generated include their progress; waiting notes are queued', async () => {
  // OpenAI answers wait until the gate is opened, so the jobs can be seen while they run
  let open;
  fakeOpenAI.wait = new Promise((resolve) => (open = resolve));
  const start = (style) =>
    fetch(notesUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ style, provider: 'openai' }),
    });

  try {
    fakeOpenAI.answer = '## Notes';
    await start('cheat-sheet');
    await start('lecture-guide');
    let running;
    for (let i = 0; i < 50 && running?.progress?.phase !== 'parts'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      running = await (await fetch(notesUrl('/cheat-sheet'))).json();
    }
    assert.equal(running.status, 'processing');
    assert.deepEqual(running.progress, { phase: 'parts', done: 0, total: 1, elapsedSeconds: 0 });

    const list = await (await fetch(notesUrl())).json();
    const waiting = list.find((n) => n.style === 'lecture-guide');
    assert.deepEqual(waiting.progress, { phase: 'queued', done: 0, total: 0, elapsedSeconds: 0 });
    assert.ok(list.every((n) => !('id' in n)));
    assert.ok(list.filter((n) => n.status !== 'processing').every((n) => !('progress' in n)));
  } finally {
    open();
    await whenIdle();
    delete fakeOpenAI.wait;
  }

  const done = await (await fetch(notesUrl('/cheat-sheet'))).json();
  assert.equal(done.status, 'ready');
  assert.ok(!('progress' in done));
});

test('an unknown style is rejected with 400', async () => {
  const expected = { error: 'Unknown note style "poem".' };
  let res = await fetch(notesUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ style: 'poem' }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), expected);

  res = await fetch(notesUrl('/poem'));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), expected);

  res = await fetch(notesUrl('/poem'), { method: 'DELETE' });
  assert.equal(res.status, 400);

  res = await fetch(notesUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ style: 5 }),
  });
  assert.equal(res.status, 400);
});
