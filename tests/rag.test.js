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
  db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)').run(BigInt(id), atAngle(angle));
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
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.materialId === ready));
  // The spec takes the 6 nearest chunks, so chunks of materials that are not ready reduce the count
  assert.equal(results.length, 4);
});

test('with courseId, the 30 nearest chunks are filtered to the first 6 of that course', async () => {
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

test('with courseId, chunks outside the 30 nearest are not found', async () => {
  const other = addMaterial(courseB, 'Other course');
  const own = addMaterial(courseA, 'Own course');
  for (let i = 0; i < 30; i++) addChunk(other, 0.01 + i * 0.01);
  addChunk(own, 1.2);

  assert.deepEqual(await searchChunks('question', { courseId: courseA, embed: questionEmbed }), []);
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
  const complete = async (args) => {
    calls.push(args);
    return ' ATP stores energy [1]. \n';
  };

  const result = await answerQuestion('What is ATP?', { complete, embed: questionEmbed });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].system, ANSWER_SYSTEM_PROMPT);
  assert.equal(calls[0].maxOutputTokens, 4000);
  assert.equal(
    calls[0].user,
    'Excerpts:\n[1] (Energy) ATP stores energy.\n[2] (Energy) Cells use ATP.\n\nQuestion: What is ATP?'
  );
  assert.deepEqual(result, {
    answer: 'ATP stores energy [1].',
    sources: [
      { n: 1, materialId: material, title: 'Energy', chunkId: first, text: 'ATP stores energy.' },
      { n: 2, materialId: material, title: 'Energy', chunkId: second, text: 'Cells use ATP.' },
    ],
  });
});

test('without any excerpts the model is not called and the not-found answer is returned', async () => {
  const complete = async () => assert.fail('model must not be called');
  const result = await answerQuestion('Anything?', { complete, embed: questionEmbed });
  assert.deepEqual(result, { answer: NOT_FOUND_ANSWER, sources: [] });
  assert.equal(NOT_FOUND_ANSWER, 'I could not find the answer in the materials.');
});
