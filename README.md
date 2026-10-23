# Study Notes

Internal web app for Abakus plus that turns learning materials (lecture transcripts, scripts, books) into structured study notes and answers questions about them using retrieval-augmented generation (RAG).

## Features

- **Courses** group related materials.
- **Materials** are added as pasted text or as a TXT, SRT or VTT file of up to 5 MB (enough for a book of about 800 pages). Subtitle files are converted to plain text without numbers and timestamps.
- **Notes** are generated for each material in a fixed structure: Summary, Key points, Terms. Long materials are split into parts, summarized part by part and merged.
- **Questions** are answered from the most relevant excerpts of all materials (or of one course), with numbered references to the sources. If the materials do not contain the answer, the app says so.
- **Background processing**: indexing and note generation run in a background queue; the UI shows the status (Processing, Ready, Error) and refreshes automatically. New materials are searchable as soon as they are ready, and deleted materials are removed from search immediately.

## How it works

| Part | Technology |
|---|---|
| Server | Node.js (ES modules), Express, multer |
| Client | React with Vite, react-markdown |
| Database | SQLite via better-sqlite3, vectors via the sqlite-vec extension |
| Notes and answers | OpenAI API (model from `OPENAI_MODEL`) |
| Embeddings for search | Ollama with the `bge-m3` model, running locally |

Material text is split into chunks of about 400 words (60 words overlap), embedded with Ollama and stored in the same SQLite database. A question is embedded the same way, the 6 most similar chunks are found, and OpenAI answers using only those excerpts.

All model calls are in `server/llm.js`. The full specification (in Slovenian) is in `docs/spec.md`.

## Prerequisites

- **Node.js 22 or newer** (`node -v`). The scripts use Node's built-in `--env-file` and `node:test`.
- **Ollama** from [ollama.com](https://ollama.com), with the `bge-m3` model.
- **An OpenAI API key** with billing or credit set up, from [platform.openai.com](https://platform.openai.com).
- **Git**. On Windows, run the commands in Git Bash.

`better-sqlite3` ships prebuilt binaries for Windows, macOS and Linux. If installation ever fails with a compile error on Windows, install Visual Studio Build Tools with the "Desktop development with C++" workload.

## Installation

```bash
git clone <repository-url> study-notes
cd study-notes
npm install
npm --prefix client install
cp .env.example .env
```

Then edit `.env` (see below) and set at least `OPENAI_API_KEY`.

## Environment variables

All configuration is read from `.env` in the project root. `.env` is ignored by Git and must never be committed.

| Variable | Example | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | – | OpenAI API key, required for notes and answers |
| `OPENAI_MODEL` | `gpt-5-mini` | OpenAI model for notes and answers; check current model names on platform.openai.com |
| `OLLAMA_URL` | `http://localhost:11434` | Address of the Ollama server |
| `EMBED_MODEL` | `bge-m3` | Ollama embedding model |
| `EMBED_DIM` | `1024` | Vector length of the embedding model (1024 for `bge-m3`) |
| `PORT` | `3000` | Port of the Express server |
| `DB_PATH` | `data/app.db` | Path to the SQLite database file; the folder is created if missing |

`EMBED_DIM` is fixed when the database is first created. If you switch to an embedding model with a different vector length, use a new `DB_PATH` (or delete the old database) and add the materials again.

## Ollama and the embedding model

1. Install Ollama and make sure it is running (it starts a server on port 11434).
2. Download the embedding model:

   ```bash
   ollama pull bge-m3
   ```

3. Check that it returns a vector:

   ```bash
   curl http://localhost:11434/api/embed -d '{"model":"bge-m3","input":["test"]}'
   ```

Ollama must be running whenever materials are indexed or questions are asked. If it is not reachable, new materials get the status Error with the message "Embedding service (Ollama) is not reachable." Start Ollama and run `npm run reindex` to index them again.

The first embedding after Ollama starts can take a few seconds while the model loads.

## Running the app

### Development

```bash
npm run dev
```

Starts the server (with automatic restart on changes) and the Vite dev server together. Open http://localhost:5173. Vite forwards `/api` requests to the server on `PORT`.

### Production

```bash
npm run build
npm start
```

Builds the client into `client/dist`, then starts the server, which serves both the API and the built client on http://localhost:3000 (or your `PORT`).

### All scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Server and client in development mode |
| `npm run build` | Build the client into `client/dist` |
| `npm start` | Start the server (serves `client/dist` if it exists) |
| `npm test` | Run all tests |
| `npm run reindex` | Index all materials again (chunks and vectors) |
| `npm run eval` | Run the search evaluation |

## Using the app

1. **Materials** view: create a course with **New course**, then add a material with a title and either **Paste text** or **Upload file** (TXT, SRT or VTT, up to 5 MB).
2. The material appears in the list with status **Processing** and becomes **Ready** when it is indexed. The list refreshes automatically.
3. Click a material to open it. Press **Generate notes** to create notes (or **Regenerate** to create them again). Notes for long materials can take several minutes; the page refreshes automatically.
4. **Ask** view: type a question, choose a course or keep **All courses**, and press **Ask**. The answer cites numbered sources. Click a source to see its excerpt, or **Open material** to open the whole material.
5. Use **Delete** in the Materials view to remove a material together with its notes and search data.

## Tests

```bash
npm test
```

Runs all tests in `tests/` with `node:test`. The tests use temporary databases and fake Ollama and OpenAI services (`tests/helpers/`), so they need neither Ollama nor an API key, never call OpenAI and never touch `data/app.db`.

## Search evaluation

```bash
npm run eval
```

Checks how well search finds the right material. For each entry in `eval/questions.json` the script runs only the search (no answer model, no OpenAI calls) and prints whether the expected material is among the found sources, followed by the overall hit rate.

`eval/questions.json` contains three **sample** entries whose titles do not exist in your database. Replace them with real questions about your materials, using the exact material titles shown in the app (the comparison ignores case):

```json
[
  { "question": "What do plants need for photosynthesis?", "expectedMaterial": "Photosynthesis" }
]
```

Entries whose title does not match any material are marked in the output. The evaluation needs `.env`, a running Ollama and an existing database with at least one Ready material. It only reads the database.

## Limitations

- No user accounts or permissions; the app is meant for internal use on a trusted network.
- Only TXT, SRT and VTT files (save PDF or DOCX as TXT first), up to 5 MB. Materials and UI are English only.
- Material text is sent to the OpenAI API for notes and answers. For internal materials, this requires the company's approval. Embeddings are created locally with Ollama.
- The background queue is in memory and runs one job at a time. Notes for a long book can take several minutes, and other materials wait in the queue meanwhile. Unfinished jobs are restarted when the server starts.
- Each OpenAI call is limited to 4000 output tokens. With reasoning models, very long merges of notes could hit this limit; the notes then show an error.
- Search without a course filter takes the 6 nearest chunks; chunks of materials that are not Ready are skipped, so fewer than 6 sources can be returned while materials are being processed.

## Project structure

```
server/
  index.js        Express app and API routes
  db.js           database, tables, sqlite-vec
  llm.js          OpenAI and Ollama calls (the only place that calls models)
  jobs.js         in-memory background job queue
  materials/      conversion of uploads to text, storage
  notes/          notes generation
  rag/            chunking, indexing, search, answers, reindex script
client/src/
  App.jsx         navigation between views
  api.js          API calls
  views/          Materials, Material, Ask
tests/            node:test tests, fixtures and fake services
eval/             search evaluation (questions.json, run.js)
docs/             specification and development log
data/             SQLite database (not in Git)
```
