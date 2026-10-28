import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.js';
import { enqueue, restoreJobs } from './jobs.js';
import { EMBEDDING_UNREACHABLE_ERROR } from './llm.js';
import { answerQuestion } from './rag/answer.js';
import { convertToText, pdfToText } from './materials/convert.js';
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

export const app = express();

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
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
  try {
    content =
      type === 'pdf'
        ? await pdfToText(file.buffer)
        : convertToText(file ? file.buffer.toString('utf8') : String(text), type);
  } catch (err) {
    throw httpError(400, err.message);
  }
  if (type === 'pdf' && Buffer.byteLength(content) > MAX_TEXT_SIZE) {
    throw httpError(413, PDF_TEXT_TOO_LARGE_ERROR);
  }

  const id = createMaterial({ courseId, title, type, content });
  enqueue('index', id);
  res.status(202).json({ id, status: 'processing' });
});

app.get('/api/materials/:id', (req, res) => {
  const material = getMaterial(parseId(req.params.id, 'material id'));
  if (!material) throw httpError(404, 'Material not found.');
  res.json(material);
});

app.get('/api/materials/:id/notes', (req, res) => {
  const notes = getDb()
    .prepare(
      `SELECT status, content, model, error, created_at AS createdAt
       FROM notes WHERE material_id = ?`
    )
    .get(parseId(req.params.id, 'material id'));
  if (!notes) throw httpError(404, 'Notes not found.');
  res.json(notes);
});

app.post('/api/materials/:id/notes', (req, res) => {
  const materialId = parseId(req.params.id, 'material id');
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM materials WHERE id = ?').get(materialId)) {
    throw httpError(404, 'Material not found.');
  }

  // A request while notes are already being generated does not start a second job
  const existing = db.prepare('SELECT status FROM notes WHERE material_id = ?').get(materialId);
  if (existing?.status !== 'processing') {
    db.prepare(
      `INSERT INTO notes (material_id) VALUES (?)
       ON CONFLICT (material_id) DO UPDATE SET
         content = NULL, model = NULL, status = 'processing', error = NULL,
         created_at = CURRENT_TIMESTAMP`
    ).run(materialId);
    enqueue('notes', materialId);
  }
  res.status(202).json({ status: 'processing' });
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

  try {
    res.json(await answerQuestion(question, { courseId, materialIds }));
  } catch (err) {
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  getDb();
  restoreJobs();
  const port = process.env.PORT;
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}
