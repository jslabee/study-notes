import fs from 'node:fs';
import path from 'node:path';

// Original PDF files, one per material, named by material id. Materials uploaded before files
// were stored have none. Ids belong to one database, so by default the folder is next to it
// (data/files for DB_PATH=data/app.db) and every database has its own files.
export function filesDir() {
  if (process.env.FILES_DIR) return path.resolve(process.env.FILES_DIR);
  if (!process.env.DB_PATH) throw new Error('DB_PATH is not set.');
  return path.join(path.dirname(path.resolve(process.env.DB_PATH)), 'files');
}

export function pdfPath(materialId) {
  return path.join(filesDir(), `${materialId}.pdf`);
}

export function savePdf(materialId, buffer) {
  fs.mkdirSync(filesDir(), { recursive: true });
  fs.writeFileSync(pdfPath(materialId), buffer);
}

export function hasPdf(materialId) {
  return fs.existsSync(pdfPath(materialId));
}

// A missing file is not an error: older materials and non-PDF materials have none
export function deletePdf(materialId) {
  fs.rmSync(pdfPath(materialId), { force: true });
}
