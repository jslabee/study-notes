import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIM = 8;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-notes-rag-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.EMBED_DIM = String(DIM);

const { getDb, closeDb } = await import('../server/db.js');
const { searchChunks } = await import('../server/rag/search.js');
const { ANSWER_SYSTEM_PROMPT, NOT_FOUND_ANSWER, answerMessage, answerQuestion } = await import(
  '../server/rag/answer.js'
);

// Unit vector at the given angle from the question vector [1, 0, 0, ...]
const atAngle = (angle) => {
  const v = new Float32Array(DIM);
  v[0] = Math.cos(angle);
  v[1] = Math.sin(angle);
  return v;
};
const questionEmbed = async (texts) => texts.map(() => atAngle(0));

let db;
let courseA;
let courseB;

function addMaterial(courseId, title, status = 'ready') {
  return Number(
    db
      .prepare("INSERT INTO materials (course_id, title, type, content, status) VALUES (?, ?, 'text', 'x', ?)")
      .run(courseId, title, status).lastInsertRowid
  );
}

function addChunk(materialId, angle, text = `chunk at ${angle}`) {
  const id = db
    .prepare('INSERT INTO chunks (material_id, position, text) VALUES (?, 0, ?)')
    .run(materialId, text).lastInsertRowid;
  db.prepare('INSERT INTO chunk_vectors (rowid, embedding, material_id) VALUES (?, ?, ?)').run(
    BigInt(id),
    atAngle(angle),
    BigInt(materialId)
  );
  return Number(id);
}

before(() => {
  db = getDb();
});

beforeEach(() => {
  db.exec('DELETE FROM chunk_vectors; DELETE FROM chunks; DELETE FROM materials; DELETE FROM courses;');
  courseA = Number(db.prepare("INSERT INTO courses (name) VALUES ('A')").run().lastInsertRowid);
  courseB = Number(db.prepare("INSERT INTO courses (name) VALUES ('B')").run().lastInsertRowid);
});

after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('search returns the 6 most similar chunks in order, with material titles', async () => {
  const material = addMaterial(courseA, 'Cells');
  const ids = [0.8, 0.1, 0.5, 0.3, 0.7, 0.2, 0.6, 0.4].map((angle) => ({ angle, id: addChunk(material, angle) }));
  const expected = [...ids].sort((a, b) => a.angle - b.angle).slice(0, 6).map((c) => c.id);

  const results = await searchChunks('question', { embed: questionEmbed });
  assert.deepEqual(results.map((r) => r.chunkId), expected);
  for (const r of results) {
    assert.equal(r.title, 'Cells');
    assert.equal(r.materialId, material);
    assert.match(r.text, /^chunk at /);
  }
});

test('search uses only materials with status ready', async () => {
  const processing = addMaterial(courseA, 'Processing', 'processing');
  const failed = addMaterial(courseA, 'Failed', 'error');
  const ready = addMaterial(courseA, 'Ready');
  addChunk(processing, 0.01);
  addChunk(failed, 0.02);
  for (const angle of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) addChunk(ready, angle);

  const results = await searchChunks('question', { embed: questionEmbed });
  // Closer chunks of materials that are not ready do not take the places of ready ones
  assert.equal(results.length, 6);
  assert.ok(results.every((r) => r.materialId === ready));
});

test('with courseId, the 6 nearest chunks of that course are found', async () => {
  const other = addMaterial(courseB, 'Other course');
  const own = addMaterial(courseA, 'Own course');
  for (let i = 0; i < 20; i++) addChunk(other, 0.01 + i * 0.01); // ranks 1-20
  const ownIds = [];
  for (let i = 0; i < 8; i++) ownIds.push(addChunk(own, 0.3 + i * 0.01)); // ranks 21-28

  const results = await searchChunks('question', { courseId: courseA, embed: questionEmbed });
  assert.deepEqual(results.map((r) => r.chunkId), ownIds.slice(0, 6));
  assert.ok(results.every((r) => r.title === 'Own course'));

  const all = await searchChunks('question', { embed: questionEmbed });
  assert.ok(all.every((r) => r.materialId === other));
});

test('with courseId, chunks of the course are found behind any number of closer chunks of other courses', async () => {
  const other = addMaterial(courseB, 'Other course');
  const own = addMaterial(courseA, 'Own course');
  for (let i = 0; i < 100; i++) addChunk(other, 0.001 + i * 0.001);
  const ownId = addChunk(own, 1.2);

  const results = await searchChunks('question', { courseId: courseA, embed: questionEmbed });
  assert.deepEqual(results.map((r) => r.chunkId), [ownId]);
});

test('with materialIds, the 6 nearest chunks of those materials are found', async () => {
  const other = addMaterial(courseA, 'Not selected');
  const first = addMaterial(courseA, 'Selected 1');
  const second = addMaterial(courseB, 'Selected 2');
  for (let i = 0; i < 20; i++) addChunk(other, 0.01 + i * 0.01); // ranks 1-20
  for (let i = 0; i < 4; i++) addChunk(first, 0.3 + i * 0.02); // ranks 21, 23, 25, 27
  for (let i = 0; i < 4; i++) addChunk(second, 0.31 + i * 0.02); // ranks 22, 24, 26, 28

  const results = await searchChunks('question', { materialIds: [first, second], embed: questionEmbed });
  // The 6 nearest of the selected chunks, in order of similarity
  assert.deepEqual(
    results.map((r) => r.title),
    ['Selected 1', 'Selected 2', 'Selected 1', 'Selected 2', 'Selected 1', 'Selected 2']
  );
});

test('the selected material returns its chunks behind many closer chunks of other and not-ready materials', async () => {
  // 300 closer chunks: of other ready materials in the same and another course, of a material
  // that is still processing and of one that failed
  const closer = [
    addMaterial(courseA, 'Not selected'),
    addMaterial(courseB, 'Other course'),
    addMaterial(courseA, 'Processing', 'processing'),
    addMaterial(courseA, 'Failed', 'error'),
  ];
  for (let i = 0; i < 300; i++) addChunk(closer[i % closer.length], 0.001 + i * 0.001);
  const selected = addMaterial(courseA, 'Selected');
  const selectedIds = [1.0, 1.4, 1.1, 1.3, 1.2, 1.5, 1.45, 1.05].map((angle) => ({ angle, id: addChunk(selected, angle) }));
  const nearest = [...selectedIds].sort((a, b) => a.angle - b.angle).slice(0, 6).map((c) => c.id);

  for (const options of [{ materialIds: [selected] }, { materialIds: [selected], courseId: courseA }]) {
    const results = await searchChunks('question', { ...options, embed: questionEmbed });
    assert.deepEqual(results.map((r) => r.chunkId), nearest);
    assert.ok(results.every((r) => r.title === 'Selected'));
  }

  // A selected material that is not ready contributes nothing, even with the closest chunks
  assert.deepEqual(await searchChunks('question', { materialIds: [closer[2], closer[3]], embed: questionEmbed }), []);
});

test('the answer to a question about a selected material comes from its chunks', async () => {
  const other = addMaterial(courseA, 'Other');
  for (let i = 0; i < 50; i++) addChunk(other, 0.001 + i * 0.001);
  const selected = addMaterial(courseA, 'Selected');
  addChunk(selected, 1.3, 'ATP is the energy currency of the cell.');

  const calls = [];
  const result = await answerQuestion('What is ATP?', {
    materialIds: [selected],
    embed: questionEmbed,
    resolve: async () => ({ provider: 'openai', model: 'test-model' }),
    chat: async (args) => {
      calls.push(args.user);
      return { text: 'ATP is the energy currency [1].', provider: 'openai', model: 'test-model' };
    },
  });
  assert.deepEqual(result.sources.map((s) => s.title), ['Selected']);
  assert.match(calls[0], /^Excerpts:\n\[1\] \(Selected\) ATP is the energy currency of the cell\.\n/);
});

test('without materialIds or with an empty list, all materials are searched', async () => {
  const one = addMaterial(courseA, 'One');
  const two = addMaterial(courseB, 'Two');
  addChunk(one, 0.1);
  addChunk(two, 0.2);

  for (const materialIds of [undefined, []]) {
    const results = await searchChunks('question', { materialIds, embed: questionEmbed });
    assert.deepEqual(results.map((r) => r.title), ['One', 'Two']);
  }
});

test('courseId and materialIds together keep only chunks matching both', async () => {
  const inCourse = addMaterial(courseA, 'In course');
  const otherCourse = addMaterial(courseB, 'Other course');
  addChunk(inCourse, 0.1);
  addChunk(otherCourse, 0.05);

  const results = await searchChunks('question', {
    courseId: courseA,
    materialIds: [inCourse, otherCourse],
    embed: questionEmbed,
  });
  assert.deepEqual(results.map((r) => r.title), ['In course']);
});

test('the question is embedded with the given embedding function', async () => {
  const seen = [];
  await searchChunks('What is ATP?', {
    embed: async (texts) => {
      seen.push(texts);
      return texts.map(() => atAngle(0));
    },
  });
  assert.deepEqual(seen, [['What is ATP?']]);
});

test('answer prompt matches the specification verbatim', () => {
  const spec = fs.readFileSync(new URL('../docs/spec.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const blocks = [...spec.matchAll(/```text\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  assert.ok(blocks.includes(ANSWER_SYSTEM_PROMPT), 'answer prompt differs from docs/spec.md');
});

test('answer message has numbered excerpts with titles, then the question', () => {
  const message = answerMessage('What is ATP?', [
    { title: 'Cells', text: 'Cells are small.' },
    { title: 'Energy', text: 'ATP stores energy.' },
  ]);
  assert.equal(
    message,
    'Excerpts:\n[1] (Cells) Cells are small.\n[2] (Energy) ATP stores energy.\n\nQuestion: What is ATP?'
  );
});

test('answerQuestion calls the model and returns the answer with numbered sources', async () => {
  const material = addMaterial(courseA, 'Energy');
  const first = addChunk(material, 0.1, 'ATP stores energy.');
  const second = addChunk(material, 0.2, 'Cells use ATP.');
  const calls = [];
  const resolve = async (args) => {
    calls.push({ resolve: args });
    return { provider: 'local', model: 'gemma3:4b' };
  };
  const chat = async (args) => {
    calls.push(args);
    return { text: ' ATP stores energy [1]. \n', provider: args.provider, model: args.model };
  };

  const result = await answerQuestion('What is ATP?', {
    provider: 'auto',
    chat,
    resolve,
    embed: questionEmbed,
  });

  const user =
    'Excerpts:\n[1] (Energy) ATP stores energy.\n[2] (Energy) Cells use ATP.\n\nQuestion: What is ATP?';
  assert.equal(calls.length, 2);
  // The provider is picked by the length of the whole prompt
  assert.deepEqual(calls[0].resolve, {
    provider: 'auto',
    model: undefined,
    textLength: ANSWER_SYSTEM_PROMPT.length + user.length,
  });
  assert.equal(calls[1].provider, 'local');
  assert.equal(calls[1].model, 'gemma3:4b');
  assert.equal(calls[1].system, ANSWER_SYSTEM_PROMPT);
  assert.equal(calls[1].maxOutputTokens, 4000);
  assert.equal(calls[1].user, user);
  assert.deepEqual(result, {
    answer: 'ATP stores energy [1].',
    provider: 'local',
    model: 'gemma3:4b',
    sources: [
      { n: 1, materialId: material, title: 'Energy', chunkId: first, text: 'ATP stores energy.' },
      { n: 2, materialId: material, title: 'Energy', chunkId: second, text: 'Cells use ATP.' },
    ],
  });
});

test('without any excerpts the model is not called and the not-found answer is returned', async () => {
  const chat = async () => assert.fail('model must not be called');
  const resolve = async () => assert.fail('provider must not be resolved');
  const result = await answerQuestion('Anything?', { chat, resolve, embed: questionEmbed });
  assert.deepEqual(result, { answer: NOT_FOUND_ANSWER, sources: [], provider: null, model: null });
  assert.equal(NOT_FOUND_ANSWER, 'I could not find the answer in the materials.');
});
