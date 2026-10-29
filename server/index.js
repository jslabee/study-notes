import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, parseJson } from './db.js';
import { enqueue, getNotesProgress, restoreJobs } from './jobs.js';
import { EMBEDDING_UNREACHABLE_ERROR, PROVIDERS, getLlmModels, resolveLlm } from './llm.js';
import { answerQuestion } from './rag/answer.js';
import { DEFAULT_STYLE, NOTE_STYLES, getStyle } from './notes/styles.js';
import { convertToText, pdfToTextWithPages } from './materials/convert.js';
import {
  createMaterial,
  deleteMaterial,
  getMaterial,
  listMaterials,
} from './materials/store.js';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.join(serverDir, '..', 'client', 'dist');

const MB = 1024 * 1024;
// Pasted text, TXT, SRT and VTT files and the text extracted from a PDF
const MAX_TEXT_SIZE = 5 * MB;
const MAX_PDF_SIZE = 30 * MB;
const FILE_TYPES = { '.txt': 'txt', '.srt': 'srt', '.vtt': 'vtt', '.pdf': 'pdf' };
const UNSUPPORTED_FILE_ERROR = 'Supported files are TXT, SRT, VTT and PDF.';
const TEXT_FILE_TOO_LARGE_ERROR = 'TXT, SRT and VTT files can be at most 5 MB.';
const PDF_TOO_LARGE_ERROR = 'PDF files can be at most 30 MB.';
const PDF_TEXT_TOO_LARGE_ERROR = 'The text extracted from the PDF is larger than 5 MB.';
const PASTED_TEXT_TOO_LARGE_ERROR = 'Pasted text can be at most 5 MB.';

// multer has a single file size limit, so it allows the largest (PDF) and text files are
// checked against their own limit in the route
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_SIZE, fieldSize: MAX_TEXT_SIZE, files: 1 },
  fileFilter: (req, file, cb) => {
    const type = FILE_TYPES[path.extname(file.originalname).toLowerCase()];
    // Remembered so the error handler can name the limit that was exceeded
    req.uploadType = type;
    if (type) cb(null, true);
    else cb(httpError(400, UNSUPPORTED_FILE_ERROR));
  },
});

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

function parseId(value, name) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, `Invalid ${name}.`);
  return id;
}

// Optional list of materials to search; omitted, null or empty means no material filter
function parseMaterialIds(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((id) => Number.isInteger(id) && id > 0)) {
    throw httpError(400, 'materialIds must be an array of material ids.');
  }
  const ids = [...new Set(value)];
  if (ids.length === 0) return undefined;

  const exists = getDb().prepare('SELECT 1 FROM materials WHERE id = ?');
  const unknown = ids.filter((id) => !exists.get(id));
  if (unknown.length > 0) {
    throw httpError(400, `Unknown material ids: ${unknown.join(', ')}.`);
  }
  return ids;
}

// Optional provider (auto | local | openai) and model; omitted values use the defaults
function parseLlmChoice(body) {
  const provider = body?.provider;
  const model = body?.model;
  if (provider !== undefined && provider !== null && provider !== '' && !PROVIDERS.includes(provider)) {
    throw httpError(400, 'provider must be auto, local or openai.');
  }
  if (model !== undefined && model !== null && typeof model !== 'string') {
    throw httpError(400, 'model must be a string.');
  }
  return { provider: provider || undefined, model: model?.trim() || undefined };
}

// A note style id from the URL or the request body; a missing body style is the default
function parseStyle(value, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return DEFAULT_STYLE;
  if (typeof value !== 'string' || !getStyle(value)) {
    throw httpError(400, `Unknown note style "${value}".`);
  }
  return value;
}

function requireMaterial(materialId) {
  const material = getDb()
    .prepare('SELECT id, length(content) AS length FROM materials WHERE id = ?')
    .get(materialId);
  if (!material) throw httpError(404, 'Material not found.');
  return material;
}

const NOTES_FIELDS = 'style, status, content, model, error, created_at AS createdAt, chapters';
const STYLE_ORDER = new Map(NOTE_STYLES.map((style, i) => [style.id, i]));

// Notes for the API: while they are being generated they include the job's progress
// { phase, done, total, elapsedSeconds } (null when no job is known for them). by-chapter notes
// include the detected chapters once they are known: { method, titles }, method outline, model,
// topics or null (no chapters found; summarized by parts). A stored detection that cannot be read
// is left out.
function withProgress({ id, chapters, ...notes }) {
  const stored = parseJson(chapters, null);
  const detection = Array.isArray(stored?.chapters) ? stored : null;
  const result = detection
    ? { ...notes, chapters: { method: detection.method, titles: detection.chapters.map((c) => c.title) } }
    : notes;
  return notes.status === 'processing' ? { ...result, progress: getNotesProgress(id) } : result;
}

export const app = express();

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/llm/models', async (req, res) => {
  res.json(await getLlmModels({ refresh: req.query.refresh === '1' }));
});

app.get('/api/note-styles', (req, res) => {
  res.json(NOTE_STYLES.map(({ id, name, description }) => ({ id, name, description })));
});

app.get('/api/courses', (req, res) => {
  const courses = getDb()
    .prepare(
      `SELECT c.id, c.name,
              (SELECT count(*) FROM materials m WHERE m.course_id = c.id) AS materialCount
       FROM courses c ORDER BY c.name`
    )
    .all();
  res.json(courses);
});

app.post('/api/courses', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) throw httpError(400, 'Course name is required.');

  const db = getDb();
  if (db.prepare('SELECT 1 FROM courses WHERE name = ?').get(name)) {
    throw httpError(409, 'A course with this name already exists.');
  }
  const result = db.prepare('INSERT INTO courses (name) VALUES (?)').run(name);
  res.status(201).json({ id: Number(result.lastInsertRowid), name, materialCount: 0 });
});

app.get('/api/materials', (req, res) => {
  const courseId =
    req.query.courseId === undefined ? undefined : parseId(req.query.courseId, 'course id');
  res.json(listMaterials(courseId));
});

app.post('/api/materials', upload.single('file'), async (req, res) => {
  const courseId = parseId(req.body?.courseId, 'course id');
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const text = req.body?.text;
  const file = req.file;

  if (!getDb().prepare('SELECT 1 FROM courses WHERE id = ?').get(courseId)) {
    throw httpError(404, 'Course not found.');
  }
  if (!title) throw httpError(400, 'Title is required.');
  if (file && text !== undefined) throw httpError(400, 'Provide either text or a file, not both.');
  if (!file && text === undefined) throw httpError(400, 'Provide text or a file.');

  const type = file ? FILE_TYPES[path.extname(file.originalname).toLowerCase()] : 'text';
  if (file && type !== 'pdf' && file.size > MAX_TEXT_SIZE) {
    throw httpError(413, TEXT_FILE_TOO_LARGE_ERROR);
  }

  let content;
  let pageOffsets = null;
  let outline = null;
  try {
    if (type === 'pdf') ({ text: content, pageOffsets, outline } = await pdfToTextWithPages(file.buffer));
    else content = convertToText(file ? file.buffer.toString('utf8') : String(text), type);
  } catch (err) {
    throw httpError(400, err.message);
  }
  if (type === 'pdf' && Buffer.byteLength(content) > MAX_TEXT_SIZE) {
    throw httpError(413, PDF_TEXT_TOO_LARGE_ERROR);
  }

  const id = createMaterial({ courseId, title, type, content, pageOffsets, outline });
  enqueue('index', id);
  res.status(202).json({ id, status: 'processing' });
});

app.get('/api/materials/:id', (req, res) => {
  const material = getMaterial(parseId(req.params.id, 'material id'));
  if (!material) throw httpError(404, 'Material not found.');
  res.json(material);
});

// Notes of all generated styles, in the order the styles are defined
app.get('/api/materials/:id/notes', (req, res) => {
  const materialId = parseId(req.params.id, 'material id');
  requireMaterial(materialId);
  const notes = getDb()
    .prepare(`SELECT id, ${NOTES_FIELDS} FROM notes WHERE material_id = ?`)
    .all(materialId)
    .sort((a, b) => (STYLE_ORDER.get(a.style) ?? Infinity) - (STYLE_ORDER.get(b.style) ?? Infinity));
  res.json(notes.map(withProgress));
});

app.get('/api/materials/:id/notes/:style', (req, res) => {
  const materialId = parseId(req.params.id, 'material id');
  const style = parseStyle(req.params.style);
  const notes = getDb()
    .prepare(`SELECT id, ${NOTES_FIELDS} FROM notes WHERE material_id = ? AND style = ?`)
    .get(materialId, style);
  if (!notes) throw httpError(404, 'Notes not found.');
  res.json(withProgress(notes));
});

app.post('/api/materials/:id/notes', async (req, res) => {
  const materialId = parseId(req.params.id, 'material id');
  const style = parseStyle(req.body?.style, { optional: true });
  const choice = parseLlmChoice(req.body);
  // by-chapter: detect the chapters again instead of using the ones found before
  const redetect = req.body?.redetect === true;
  const material = requireMaterial(materialId);
  const db = getDb();

  // A request while notes in this style are already being generated does not start a second job
  const existing = db
    .prepare('SELECT status FROM notes WHERE material_id = ? AND style = ?')
    .get(materialId, style);
  if (existing?.status !== 'processing') {
    // Resolved here, so an invalid or unavailable choice is reported before anything changes. The
    // resolved provider and model are stored, so a job restored after a restart uses them too.
    const llm = await resolveLlm({ ...choice, textLength: material.length });
    const { id } = db
      .prepare(
        `INSERT INTO notes (material_id, style, requested_provider, requested_model) VALUES (?, ?, ?, ?)
         ON CONFLICT (material_id, style) DO UPDATE SET
           content = NULL, model = NULL, status = 'processing', error = NULL,
           chapters = CASE WHEN ? THEN NULL ELSE chapters END,
           requested_provider = excluded.requested_provider,
           requested_model = excluded.requested_model,
           created_at = CURRENT_TIMESTAMP
         RETURNING id`
      )
      .get(materialId, style, llm.provider, llm.model, redetect ? 1 : 0);
    enqueue('notes', id, llm);
  }
  res.status(202).json({ style, status: 'processing' });
});

// A job that is still running for these notes finds no row and its result is discarded
app.delete('/api/materials/:id/notes/:style', (req, res) => {
  const materialId = parseId(req.params.id, 'material id');
  const style = parseStyle(req.params.style);
  const result = getDb()
    .prepare('DELETE FROM notes WHERE material_id = ? AND style = ?')
    .run(materialId, style);
  if (result.changes === 0) throw httpError(404, 'Notes not found.');
  res.json({ deleted: true });
});

app.delete('/api/materials/:id', (req, res) => {
  if (!deleteMaterial(parseId(req.params.id, 'material id'))) {
    throw httpError(404, 'Material not found.');
  }
  res.json({ deleted: true });
});

app.post('/api/ask', async (req, res) => {
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  if (!question) throw httpError(400, 'Question is required.');

  const rawCourseId = req.body?.courseId;
  let courseId;
  if (rawCourseId !== undefined && rawCourseId !== null && rawCourseId !== '') {
    courseId = parseId(rawCourseId, 'course id');
    if (!getDb().prepare('SELECT 1 FROM courses WHERE id = ?').get(courseId)) {
      throw httpError(404, 'Course not found.');
    }
  }

  const materialIds = parseMaterialIds(req.body?.materialIds);
  const choice = parseLlmChoice(req.body);

  try {
    res.json(await answerQuestion(question, { courseId, materialIds, ...choice }));
  } catch (err) {
    // Provider and model errors already carry their status
    if (err.expose) throw err;
    // Failures of Ollama or OpenAI are reported with their readable message
    console.error(err);
    throw httpError(err.message === EMBEDDING_UNREACHABLE_ERROR ? 503 : 502, err.message);
  }
});

// Unknown API routes get a JSON 404 instead of the client app
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Serve the built client when it exists; all non-API routes return index.html
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api(\/|$)).*/, (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Unified error handling: always respond with { error } and a matching HTTP status
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      err.status = 413;
      err.message = req.uploadType === 'pdf' ? PDF_TOO_LARGE_ERROR : TEXT_FILE_TOO_LARGE_ERROR;
    } else if (err.code === 'LIMIT_FIELD_VALUE') {
      err.status = 413;
      err.message = PASTED_TEXT_TOO_LARGE_ERROR;
    } else {
      err.status = 400;
    }
  }
  const status = err.status || err.statusCode || 500;
  if (status >= 500 && !err.expose) console.error(err);
  res.status(status).json({
    error: (status < 500 || err.expose) && err.message ? err.message : 'Internal server error',
  });
});

// Opens the database, queues the jobs that were still processing and starts listening on PORT;
// resolves with the server once it listens, and rejects when it cannot (e.g. the port is in use)
export function startServer({ port = process.env.PORT } = {}) {
  getDb();
  restoreJobs();
  return new Promise((resolve, reject) => {
    const server = app.listen(port);
    server.once('listening', () => {
      console.log(`Server listening on port ${server.address().port}`);
      resolve(server);
    });
    server.once('error', reject);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((err) => {
    console.error(`Server could not start: ${err.message}`);
    process.exitCode = 1;
  });
}
