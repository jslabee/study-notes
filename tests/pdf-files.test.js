import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFakeOllama } from './helpers/fake-ollama.js';

// Its own database and files folder, so no file is written into data/
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-notes-files-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.FILES_DIR = path.join(tmpDir, 'pdf-files');
installFakeOllama();

const { app } = await import('../server/index.js');
const { getDb, closeDb } = await import('../server/db.js');
const { whenIdle } = await import('../server/jobs.js');
const { filesDir } = await import('../server/materials/files.js');

const pdf = fs.readFileSync(new URL('./fixtures/sample.pdf', import.meta.url));
const stored = (id) => path.join(process.env.FILES_DIR, `${id}.pdf`);
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
    body: JSON.stringify({ name: 'Files' }),
  });
  courseId = (await res.json()).id;
});

after(async () => {
  await whenIdle();
  await new Promise((resolve) => server.close(resolve));
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function upload(title, { name, content, text }) {
  const form = new FormData();
  form.append('courseId', courseId);
  form.append('title', title);
  if (text !== undefined) form.append('text', text);
  else form.append('file', new Blob([content]), name);
  const res = await fetch(`${baseUrl}/api/materials`, { method: 'POST', body: form });
  assert.equal(res.status, 202);
  return (await res.json()).id;
}

const material = async (id) => (await fetch(`${baseUrl}/api/materials/${id}`)).json();

test('an uploaded PDF is stored unchanged under FILES_DIR, named by material id', async () => {
  const id = await upload('Cells', { name: 'cells.pdf', content: pdf });
  await whenIdle();
  assert.deepEqual(fs.readFileSync(stored(id)), pdf);
  assert.equal((await material(id)).hasFile, true);
});

test('GET /api/materials/:id/file returns the stored PDF', async () => {
  const id = await upload('Served', { name: 'served.pdf', content: pdf });
  const res = await fetch(`${baseUrl}/api/materials/${id}/file`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('content-disposition'), 'inline');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), pdf);
});

test('text materials store no file and have no file to serve', async () => {
  const id = await upload('Notes', { text: 'Plain text.' });
  assert.equal(fs.existsSync(stored(id)), false);
  assert.equal((await material(id)).hasFile, false);
  const res = await fetch(`${baseUrl}/api/materials/${id}/file`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'File not found.' });
});

test('a PDF uploaded before files were stored has no file: hasFile is false and the file is 404', async () => {
  const id = await upload('Old PDF', { name: 'old.pdf', content: pdf });
  fs.rmSync(stored(id));
  assert.equal((await material(id)).hasFile, false);
  assert.equal((await fetch(`${baseUrl}/api/materials/${id}/file`)).status, 404);
});

test('the file of an unknown material is 404 and an invalid id is 400', async () => {
  assert.equal((await fetch(`${baseUrl}/api/materials/999999/file`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/materials/abc/file`)).status, 400);
});

test('deleting a material deletes its PDF file but not the files of others', async () => {
  const keep = await upload('Keep', { name: 'keep.pdf', content: pdf });
  const remove = await upload('Remove', { name: 'remove.pdf', content: pdf });
  await whenIdle();
  const res = await fetch(`${baseUrl}/api/materials/${remove}`, { method: 'DELETE' });
  assert.deepEqual(await res.json(), { deleted: true });
  assert.equal(fs.existsSync(stored(remove)), false);
  assert.equal(fs.existsSync(stored(keep)), true);
  assert.equal((await fetch(`${baseUrl}/api/materials/${remove}/file`)).status, 404);
});

test('deleting a material without a stored file still works', async () => {
  const id = await upload('No file', { name: 'nofile.pdf', content: pdf });
  await whenIdle();
  fs.rmSync(stored(id));
  const res = await fetch(`${baseUrl}/api/materials/${id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
});

test('a rejected PDF upload stores no file', async () => {
  const before = fs.readdirSync(process.env.FILES_DIR).length;
  const form = new FormData();
  form.append('courseId', courseId);
  form.append('title', 'Broken');
  form.append('file', new Blob([Buffer.from('not a pdf')]), 'broken.pdf');
  const res = await fetch(`${baseUrl}/api/materials`, { method: 'POST', body: form });
  assert.equal(res.status, 400);
  assert.equal(fs.readdirSync(process.env.FILES_DIR).length, before);
  assert.equal(getDb().prepare("SELECT count(*) FROM materials WHERE title = 'Broken'").pluck().get(), 0);
});

test('without FILES_DIR the files folder is next to the database', () => {
  const saved = process.env.FILES_DIR;
  try {
    delete process.env.FILES_DIR;
    assert.equal(filesDir(), path.join(tmpDir, 'files'));
  } finally {
    process.env.FILES_DIR = saved;
  }
  assert.equal(filesDir(), path.resolve(saved));
});

test('when the PDF cannot be saved, the upload fails and leaves no material', async () => {
  const saved = process.env.FILES_DIR;
  // A file where the folder should be, so the folder cannot be created
  const blocker = path.join(tmpDir, 'not-a-folder');
  fs.writeFileSync(blocker, '');
  process.env.FILES_DIR = path.join(blocker, 'files');
  const errorLog = console.error;
  console.error = () => {};
  try {
    const form = new FormData();
    form.append('courseId', courseId);
    form.append('title', 'Unsaved');
    form.append('file', new Blob([pdf]), 'unsaved.pdf');
    const res = await fetch(`${baseUrl}/api/materials`, { method: 'POST', body: form });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'The PDF file could not be saved.' });
    assert.equal(getDb().prepare("SELECT count(*) FROM materials WHERE title = 'Unsaved'").pluck().get(), 0);
  } finally {
    console.error = errorLog;
    process.env.FILES_DIR = saved;
  }
});
