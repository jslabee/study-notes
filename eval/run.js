// Search evaluation: npm run eval
// For every question in eval/questions.json, runs only the search (no answer model)
// and checks whether the expected material is among the found sources.
import fs from 'node:fs';
import { closeDb, getDb } from '../server/db.js';
import { searchChunks } from '../server/rag/search.js';

const QUESTIONS_FILE = new URL('./questions.json', import.meta.url);
const REQUIRED_ENV = ['DB_PATH', 'OLLAMA_URL', 'EMBED_MODEL', 'EMBED_DIM'];

const sameTitle = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

class EvalError extends Error {}

function readQuestions() {
  let questions;
  try {
    questions = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  } catch (err) {
    throw new EvalError(`Could not read eval/questions.json: ${err.message}`);
  }
  if (!Array.isArray(questions)) {
    throw new EvalError('eval/questions.json must contain a JSON array.');
  }
  if (questions.length === 0) {
    throw new EvalError(
      'eval/questions.json contains no questions. Add entries like ' +
        '{ "question": "...", "expectedMaterial": "material title" }.'
    );
  }
  questions.forEach((q, i) => {
    if (typeof q?.question !== 'string' || !q.question.trim()) {
      throw new EvalError(`Question ${i + 1} in eval/questions.json has no "question" text.`);
    }
    if (typeof q.expectedMaterial !== 'string' || !q.expectedMaterial.trim()) {
      throw new EvalError(`Question ${i + 1} in eval/questions.json has no "expectedMaterial".`);
    }
  });
  return questions;
}

function readMaterials() {
  // The database is only read; a missing file is reported instead of being created
  if (!fs.existsSync(process.env.DB_PATH)) {
    throw new EvalError(
      `Database not found at ${process.env.DB_PATH}. Start the app and add materials first.`
    );
  }
  try {
    const db = getDb();
    return {
      titles: db.prepare('SELECT title FROM materials').all().map((row) => row.title),
      readyChunks: db
        .prepare(
          `SELECT count(*) AS n FROM chunks c
           JOIN materials m ON m.id = c.material_id WHERE m.status = 'ready'`
        )
        .get().n,
    };
  } catch (err) {
    throw new EvalError(`Could not read the database: ${err.message}`);
  }
}

async function main() {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new EvalError(
      `Missing environment variables: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`
    );
  }

  const questions = readQuestions();
  const { titles, readyChunks } = readMaterials();
  if (readyChunks === 0) {
    throw new EvalError(
      'No indexed materials with status Ready. Add materials in the app or run npm run reindex.'
    );
  }

  console.log(`Search evaluation: ${questions.length} questions\n`);
  let hits = 0;
  let unknownTitles = 0;

  for (const [i, { question, expectedMaterial }] of questions.entries()) {
    let results;
    try {
      results = await searchChunks(question);
    } catch (err) {
      throw new EvalError(`Search failed: ${err.message}`);
    }

    const found = [...new Set(results.map((r) => r.title))];
    const rank = results.findIndex((r) => sameTitle(r.title, expectedMaterial)) + 1;
    if (rank > 0) hits++;

    console.log(`[${i + 1}/${questions.length}] ${rank > 0 ? `HIT (source ${rank})` : 'MISS'}`);
    console.log(`  Question: ${question}`);
    console.log(`  Expected: ${expectedMaterial}`);
    console.log(`  Found:    ${found.length > 0 ? found.join('; ') : '(no sources)'}`);
    if (!titles.some((title) => sameTitle(title, expectedMaterial))) {
      unknownTitles++;
      console.log('  Note:     no material with this title exists');
    }
    console.log('');
  }

  const rate = ((hits / questions.length) * 100).toFixed(1);
  console.log(`Hit rate: ${hits}/${questions.length} (${rate}%)`);
  if (unknownTitles > 0) {
    console.log(
      `\n${unknownTitles} expected title(s) do not match any material. ` +
        'Replace the sample entries in eval/questions.json with questions and titles from your materials.'
    );
  }
}

try {
  await main();
} catch (err) {
  console.error(err instanceof EvalError ? `Error: ${err.message}` : err);
  process.exitCode = 1;
} finally {
  closeDb();
}
