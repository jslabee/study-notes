import { getDb } from './db.js';
import { getModel } from './llm.js';
import { generateNotes } from './notes/generate.js';

const queue = [];
let running = false;
let idleWaiters = [];

const handlers = {
  // Real indexing is added in step 5; for now the material only becomes ready
  index: (materialId) => {
    getDb()
      .prepare("UPDATE materials SET status = 'ready', error = NULL WHERE id = ?")
      .run(materialId);
  },
  notes: async (materialId) => {
    const material = getDb()
      .prepare('SELECT title, content FROM materials WHERE id = ?')
      .get(materialId);
    if (!material) return;

    const model = getModel();
    const content = await generateNotes(material);
    getDb()
      .prepare(
        "UPDATE notes SET content = ?, model = ?, status = 'ready', error = NULL WHERE material_id = ?"
      )
      .run(content, model, materialId);
  },
};

const failHandlers = {
  index: (materialId, message) => {
    getDb()
      .prepare("UPDATE materials SET status = 'error', error = ? WHERE id = ?")
      .run(message, materialId);
  },
  notes: (materialId, message) => {
    getDb()
      .prepare("UPDATE notes SET status = 'error', error = ? WHERE material_id = ?")
      .run(message, materialId);
  },
};

// Adds a job to the queue; jobs run one after another in the background
export function enqueue(type, id) {
  if (!handlers[type]) throw new Error(`Unknown job type: ${type}`);
  if (queue.some((job) => job.type === type && job.id === id)) return;
  queue.push({ type, id });
  if (!running) setImmediate(runNext);
}

async function runNext() {
  if (running) return;
  const job = queue.shift();
  if (!job) {
    idleWaiters.forEach((resolve) => resolve());
    idleWaiters = [];
    return;
  }

  running = true;
  try {
    await handlers[job.type](job.id);
  } catch (err) {
    console.error(`Job ${job.type} ${job.id} failed:`, err);
    try {
      failHandlers[job.type](job.id, err.message || 'Processing failed.');
    } catch (saveErr) {
      console.error(`Could not save error for job ${job.type} ${job.id}:`, saveErr);
    }
  } finally {
    running = false;
    setImmediate(runNext);
  }
}

// Re-queues all materials and notes that were still processing when the server stopped
export function restoreJobs() {
  const db = getDb();
  const materials = db
    .prepare("SELECT id FROM materials WHERE status = 'processing' ORDER BY id")
    .all();
  for (const row of materials) enqueue('index', row.id);

  const notes = db
    .prepare("SELECT material_id AS id FROM notes WHERE status = 'processing' ORDER BY id")
    .all();
  for (const row of notes) enqueue('notes', row.id);
}

// Resolves when the queue is empty (used by tests)
export function whenIdle() {
  if (!running && queue.length === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}
