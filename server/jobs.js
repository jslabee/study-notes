import { getDb } from './db.js';
import { resolveLlm } from './llm.js';
import { generateNotes } from './notes/generate.js';
import { indexMaterial } from './rag/index.js';

const queue = [];
let running = false;
let idleWaiters = [];

const handlers = {
  index: (materialId) => indexMaterial(materialId),
  // Notes jobs use the id of the notes row, so each style of a material is its own job.
  // llm is the provider and model resolved for the request; restored jobs use the defaults.
  notes: async (notesId, llm) => {
    const row = getDb()
      .prepare(
        `SELECT n.style, m.title, m.content FROM notes n
         JOIN materials m ON m.id = n.material_id
         WHERE n.id = ? AND n.status = 'processing'`
      )
      .get(notesId);
    // Deleted (or no longer waiting) before the job started
    if (!row) return;

    const used = llm ?? (await resolveLlm({ textLength: row.content.length }));
    const content = await generateNotes(row, { style: row.style, ...used });
    getDb()
      .prepare("UPDATE notes SET content = ?, model = ?, status = 'ready', error = NULL WHERE id = ?")
      .run(content, `${used.provider}:${used.model}`, notesId);
  },
};

const failHandlers = {
  index: (materialId, message) => {
    getDb()
      .prepare("UPDATE materials SET status = 'error', error = ? WHERE id = ?")
      .run(message, materialId);
  },
  notes: (notesId, message) => {
    getDb().prepare("UPDATE notes SET status = 'error', error = ? WHERE id = ?").run(message, notesId);
  },
};

// Adds a job to the queue; jobs run one after another in the background
export function enqueue(type, id, options) {
  if (!handlers[type]) throw new Error(`Unknown job type: ${type}`);
  if (queue.some((job) => job.type === type && job.id === id)) return;
  queue.push({ type, id, options });
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
    await handlers[job.type](job.id, job.options);
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
    .prepare("SELECT id FROM notes WHERE status = 'processing' ORDER BY id")
    .all();
  for (const row of notes) enqueue('notes', row.id);
}

// Resolves when the queue is empty (used by tests)
export function whenIdle() {
  if (!running && queue.length === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}
