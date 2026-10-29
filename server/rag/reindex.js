// Re-indexes all materials: npm run reindex
import { closeDb, getDb } from '../db.js';
import { indexMaterial } from './index.js';

// The script and a running server write to the same database without coordinating; a server
// started meanwhile would also queue the materials this script marks as processing
console.warn(
  'Warning: stop the server (npm run dev or npm start) before reindexing. ' +
    'The script and a running server write to the same database without coordinating.'
);

const db = getDb();
const materials = db.prepare('SELECT id, title FROM materials ORDER BY id').all();
const setProcessing = db.prepare(
  "UPDATE materials SET status = 'processing', error = NULL WHERE id = ?"
);
const setError = db.prepare("UPDATE materials SET status = 'error', error = ? WHERE id = ?");

let failed = 0;
for (const [i, material] of materials.entries()) {
  const label = `[${i + 1}/${materials.length}] ${material.title}`;
  setProcessing.run(material.id);
  try {
    const chunkCount = await indexMaterial(material.id);
    console.log(`${label}: ${chunkCount} chunks`);
  } catch (err) {
    failed++;
    setError.run(err.message, material.id);
    console.error(`${label}: ${err.message}`);
  }
}

console.log(`Reindexed ${materials.length - failed} of ${materials.length} materials.`);
closeDb();
process.exitCode = failed > 0 ? 1 : 0;
