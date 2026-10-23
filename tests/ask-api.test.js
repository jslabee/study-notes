import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFakeOllama } from './helpers/fake-ollama.js';
import { installFakeOpenAI } from './helpers/fake-openai.js';

// Temporary database; Ollama and OpenAI are faked, so no real calls are made
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-notes-ask-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
const fakeOllama = installFakeOllama({ dim: 8 });
const fakeOpenAI = installFakeOpenAI({ answer: 'Plants use light [1].' });

const { app } = await import('../server/index.js');
const { getDb, closeDb } = await import('../server/db.js');
const { whenIdle } = await import('../server/jobs.js');
const { ANSWER_SYSTEM_PROMPT } = await import('../server/rag/answer.js');

let server;
let baseUrl;
let biology;
let history;
let emptyCourse;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const db = getDb();
  const addCourse = (name) => Number(db.prepare('INSERT INTO courses (name) VALUES (?)').run(name).lastInsertRowid);
  biology = addCourse('Biology');
  history = addCourse('History');
  emptyCourse = addCourse('Empty');

  await upload(biology, 'Photosynthesis', 'Plants turn light into chemical energy. Chlorophyll absorbs light.');
  await upload(history, 'Rome', 'Rome was founded on seven hills. The republic had two consuls.');
  await whenIdle();
});

after(() => {
  server.close();
  closeDb();
  fakeOpenAI.restore();
  fakeOllama.restore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function upload(courseId, title, text) {
  const form = new FormData();
  form.append('courseId', courseId);
  form.append('title', title);
  form.append('text', text);
  const res = await fetch(`${baseUrl}/api/materials`, { method: 'POST', body: form });
  assert.equal(res.status, 202);
}

function ask(body) {
  return fetch(`${baseUrl}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('POST /api/ask returns { answer, sources } in the specified shape', async () => {
  fakeOpenAI.requests.length = 0;
  const res = await ask({ question: 'How do plants get energy?' });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(Object.keys(body).sort(), ['answer', 'sources']);
  assert.equal(body.answer, 'Plants use light [1].');
  assert.equal(body.sources.length, 2);
  body.sources.forEach((source, i) => {
    assert.deepEqual(Object.keys(source).sort(), ['chunkId', 'materialId', 'n', 'text', 'title']);
    assert.equal(source.n, i + 1);
  });
  assert.deepEqual(body.sources.map((s) => s.title).sort(), ['Photosynthesis', 'Rome']);
});

test('the OpenAI request uses the spec prompt and numbered excerpts matching sources', async () => {
  fakeOpenAI.requests.length = 0;
  const body = await (await ask({ question: 'Who founded Rome?' })).json();

  assert.equal(fakeOpenAI.requests.length, 1);
  const request = fakeOpenAI.requests[0].body;
  assert.equal(request.model, 'test-model');
  assert.equal(request.instructions, ANSWER_SYSTEM_PROMPT);
  assert.equal(request.max_output_tokens, 4000);
  const expectedInput =
    'Excerpts:\n' +
    body.sources.map((s) => `[${s.n}] (${s.title}) ${s.text}`).join('\n') +
    '\n\nQuestion: Who founded Rome?';
  assert.equal(request.input, expectedInput);
});

test('courseId limits sources to that course', async () => {
  const body = await (await ask({ question: 'Tell me about it.', courseId: history })).json();
  assert.ok(body.sources.length > 0);
  assert.ok(body.sources.every((s) => s.title === 'Rome'));
});

test('a course without materials gives the not-found answer without calling OpenAI', async () => {
  fakeOpenAI.requests.length = 0;
  const body = await (await ask({ question: 'Anything?', courseId: emptyCourse })).json();
  assert.deepEqual(body, { answer: 'I could not find the answer in the materials.', sources: [] });
  assert.equal(fakeOpenAI.requests.length, 0);
});

test('a deleted material no longer appears among sources', async () => {
  const db = getDb();
  const rome = db.prepare("SELECT id FROM materials WHERE title = 'Rome'").get().id;
  await upload(history, 'Temporary', 'A temporary note about Roman roads.');
  await whenIdle();
  const temp = db.prepare("SELECT id FROM materials WHERE title = 'Temporary'").get().id;

  let body = await (await ask({ question: 'Roman roads?', courseId: history })).json();
  assert.ok(body.sources.some((s) => s.materialId === temp));

  await fetch(`${baseUrl}/api/materials/${temp}`, { method: 'DELETE' });
  body = await (await ask({ question: 'Roman roads?', courseId: history })).json();
  assert.ok(body.sources.every((s) => s.materialId === rome));
});

test('invalid requests are rejected', async () => {
  assert.equal((await ask({})).status, 400);
  assert.equal((await ask({ question: '   ' })).status, 400);
  assert.equal((await ask({ question: 'x', courseId: 'abc' })).status, 400);
  assert.equal((await ask({ question: 'x', courseId: 9999 })).status, 404);
  const body = await (await ask({ question: '' })).json();
  assert.equal(body.error, 'Question is required.');
});

test('null or empty courseId means all courses', async () => {
  for (const courseId of [null, '']) {
    const res = await ask({ question: 'Energy?', courseId });
    assert.equal(res.status, 200);
    // One chunk each from Photosynthesis and Rome, from both courses
    assert.deepEqual((await res.json()).sources.map((s) => s.title).sort(), ['Photosynthesis', 'Rome']);
  }
});

test('unreachable Ollama returns 503 with the readable message', async () => {
  fakeOllama.unreachable = true;
  try {
    const res = await ask({ question: 'Energy?' });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'Embedding service (Ollama) is not reachable.' });
  } finally {
    fakeOllama.unreachable = false;
  }
});
