import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFakeOllama } from './helpers/fake-ollama.js';
import { buildPdf, textStream } from './fixtures/make-pdf.js';

// Every run uses its own temporary database; indexing uses fake embeddings
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-notes-test-'));
process.env.DB_PATH = path.join(tmpDir, 'nested', 'test.db');
const fakeOllama = installFakeOllama();

const { app } = await import('../server/index.js');
const { getDb, closeDb } = await import('../server/db.js');
const { whenIdle } = await import('../server/jobs.js');

let server;
let baseUrl;
let courseId;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${baseUrl}/api/courses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Biology' }),
  });
  assert.equal(res.status, 201);
  courseId = (await res.json()).id;
});

after(() => {
  server.close();
  closeDb();
  fakeOllama.restore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function postMaterial(fields, file) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  if (file) form.append('file', new Blob([file.content]), file.name);
  return fetch(`${baseUrl}/api/materials`, { method: 'POST', body: form });
}

test('database directory is created and courses are listed', async () => {
  assert.ok(fs.existsSync(process.env.DB_PATH));
  const res = await fetch(`${baseUrl}/api/courses`);
  assert.deepEqual(await res.json(), [{ id: courseId, name: 'Biology', materialCount: 0 }]);
});

test('duplicate course name is rejected', async () => {
  const res = await fetch(`${baseUrl}/api/courses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Biology' }),
  });
  assert.equal(res.status, 409);
  assert.equal(typeof (await res.json()).error, 'string');
});

test('pasted text material is created, becomes ready and is listed', async () => {
  const res = await postMaterial({ courseId, title: 'Cells', text: 'Cells are small.' });
  assert.equal(res.status, 202);
  const { id, status } = await res.json();
  assert.equal(status, 'processing');

  await whenIdle();

  const material = await (await fetch(`${baseUrl}/api/materials/${id}`)).json();
  assert.equal(material.status, 'ready');
  assert.equal(material.type, 'text');
  assert.equal(material.content, 'Cells are small.');
  assert.equal(material.chunkCount, 1);

  const list = await (await fetch(`${baseUrl}/api/materials?courseId=${courseId}`)).json();
  const item = list.find((m) => m.id === id);
  assert.deepEqual(Object.keys(item).sort(), [
    'chars', 'courseId', 'createdAt', 'hasNotes', 'id', 'status', 'title', 'type',
  ]);
  assert.equal(item.chars, 'Cells are small.'.length);
  assert.equal(item.hasNotes, false);
});

test('SRT file is converted to clean text', async () => {
  const content = fs.readFileSync(new URL('./fixtures/sample.srt', import.meta.url));
  const res = await postMaterial({ courseId, title: 'Lecture 1' }, { name: 'lecture.SRT', content });
  assert.equal(res.status, 202);
  const { id } = await res.json();
  await whenIdle();

  const material = await (await fetch(`${baseUrl}/api/materials/${id}`)).json();
  assert.equal(material.type, 'srt');
  assert.doesNotMatch(material.content, /-->/);
});

test('deleting a material removes it with its notes, chunks and vectors', async () => {
  const res = await postMaterial({ courseId, title: 'To delete', text: 'Temporary text.' });
  const { id } = await res.json();
  await whenIdle();

  // Chunks and vectors are created in step 5; insert them directly to check deletion
  const db = getDb();
  const dim = Number(process.env.EMBED_DIM || 1024);
  const chunkId = db
    .prepare('INSERT INTO chunks (material_id, position, text) VALUES (?, 0, ?)')
    .run(id, 'Temporary text.').lastInsertRowid;
  db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)').run(
    BigInt(chunkId),
    new Float32Array(dim)
  );
  db.prepare("INSERT INTO notes (material_id, content, status) VALUES (?, 'x', 'ready')").run(id);

  const del = await fetch(`${baseUrl}/api/materials/${id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { deleted: true });

  assert.equal((await fetch(`${baseUrl}/api/materials/${id}`)).status, 404);
  assert.equal(db.prepare('SELECT count(*) AS n FROM chunks WHERE material_id = ?').get(id).n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM notes WHERE material_id = ?').get(id).n, 0);
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM chunk_vectors WHERE rowid = ?').get(BigInt(chunkId)).n,
    0
  );

  assert.equal((await fetch(`${baseUrl}/api/materials/${id}`, { method: 'DELETE' })).status, 404);
});

test('unsupported file type is rejected with the exact message', async () => {
  const res = await postMaterial(
    { courseId, title: 'Slides' },
    { name: 'slides.docx', content: 'PK' }
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Supported files are TXT, SRT, VTT and PDF.' });
});

test('PDF file is converted to clean text', async () => {
  const content = fs.readFileSync(new URL('./fixtures/sample.pdf', import.meta.url));
  const res = await postMaterial({ courseId, title: 'Biology' }, { name: 'biology.PDF', content });
  assert.equal(res.status, 202);
  const { id } = await res.json();
  await whenIdle();

  const material = await (await fetch(`${baseUrl}/api/materials/${id}`)).json();
  assert.equal(material.type, 'pdf');
  assert.equal(material.status, 'ready');
  assert.match(material.content, /^Photosynthesis .* chloroplasts /);
  assert.doesNotMatch(material.content, /Introduction to Biology|Lecture notes/);
});

test('PDF without selectable text is rejected with the exact message', async () => {
  const content = fs.readFileSync(new URL('./fixtures/no-text.pdf', import.meta.url));
  const res = await postMaterial({ courseId, title: 'Scan' }, { name: 'scan.pdf', content });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    error: 'This PDF contains no selectable text (scanned documents are not supported).',
  });
});

test('PDF larger than 5 MB passes the size check; over 30 MB is rejected', async () => {
  // Not a valid PDF, so a file that passes the size limit fails on conversion instead
  const fits = await postMaterial(
    { courseId, title: 'Big PDF' },
    { name: 'big.pdf', content: Buffer.alloc(30 * 1024 * 1024, 'a') }
  );
  assert.equal(fits.status, 400);
  assert.deepEqual(await fits.json(), { error: 'The file is not a valid PDF.' });

  const res = await postMaterial(
    { courseId, title: 'Too big PDF' },
    { name: 'big.pdf', content: Buffer.alloc(30 * 1024 * 1024 + 1, 'a') }
  );
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: 'PDF files can be at most 30 MB.' });
});

test('PDF with more than 5 MB of text is rejected', async () => {
  // pdf.js ignores text outside the page, so the long lines need the largest page size
  const pages = [0, 1, 2].map((page) =>
    textStream(
      Array.from({ length: 1000 }, (_, i) => [10, 14390 - i * 14, `Page ${page} line ${i} ${'word '.repeat(380)}`])
    )
  );
  const content = buildPdf(pages, { width: 14400, height: 14400 });
  const res = await postMaterial({ courseId, title: 'Long PDF' }, { name: 'long.pdf', content });
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), {
    error: 'The text extracted from the PDF is larger than 5 MB.',
  });
});

test('text file larger than 5 MB is rejected', async () => {
  const content = Buffer.alloc(5 * 1024 * 1024 + 1, 'a');
  const res = await postMaterial({ courseId, title: 'Too big' }, { name: 'big.txt', content });
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: 'TXT, SRT and VTT files can be at most 5 MB.' });

  // Above the PDF limit, multer rejects the file before the route sees it
  const huge = Buffer.alloc(30 * 1024 * 1024 + 1, 'a');
  const res2 = await postMaterial({ courseId, title: 'Too big' }, { name: 'huge.vtt', content: huge });
  assert.equal(res2.status, 413);
  assert.deepEqual(await res2.json(), { error: 'TXT, SRT and VTT files can be at most 5 MB.' });
});

test('pasted text larger than 5 MB is rejected', async () => {
  const res = await postMaterial({ courseId, title: 'Too big', text: 'a'.repeat(5 * 1024 * 1024 + 1) });
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: 'Pasted text can be at most 5 MB.' });
});

test('file of exactly 5 MB is accepted', async () => {
  const content = Buffer.alloc(5 * 1024 * 1024, 'a');
  const res = await postMaterial({ courseId, title: 'Just fits' }, { name: 'fits.txt', content });
  assert.equal(res.status, 202);
  await whenIdle();
});

test('empty file is rejected with the exact message', async () => {
  const res = await postMaterial({ courseId, title: 'Empty' }, { name: 'empty.txt', content: '\n\n' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'The file contains no readable text.' });
});

test('material for unknown course and missing title are rejected', async () => {
  assert.equal((await postMaterial({ courseId: 9999, title: 'X', text: 'Y' })).status, 404);
  assert.equal((await postMaterial({ courseId, title: ' ', text: 'Y' })).status, 400);
  assert.equal((await postMaterial({ courseId, title: 'X' })).status, 400);
});

test('processing materials are queued again on restore', async () => {
  const { restoreJobs } = await import('../server/jobs.js');
  const db = getDb();
  const id = db
    .prepare("INSERT INTO materials (course_id, title, type, content) VALUES (?, 'Stuck', 'text', 'x')")
    .run(courseId).lastInsertRowid;
  restoreJobs();
  await whenIdle();
  assert.equal(db.prepare('SELECT status FROM materials WHERE id = ?').get(id).status, 'ready');
});
