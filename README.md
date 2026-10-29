# Study Notes

Internal web app for Abakus plus that turns learning materials (lecture transcripts, scripts, books) into structured study notes and answers questions about them using retrieval-augmented generation (RAG). Notes and answers can be made by a local model through Ollama or by OpenAI.

## Features

- **Courses** group related materials. The home screen shows them as cards.
- **Import** of pasted text and of TXT, SRT, VTT and PDF files:
  - TXT, SRT and VTT files and pasted text up to 5 MB, enough for a book of about 800 pages. Subtitle files are converted to plain text without numbers and timestamps.
  - PDF files up to 30 MB with at most 5 MB of extracted text. Hyphenated words are joined, and page numbers and repeated headers and footers are removed. The PDF outline (bookmarks) is kept for chapter detection. Scanned PDFs without a text layer are not supported.
- **Source selection**: every source has a checkbox, and questions are answered only from the checked sources.
- **Local or OpenAI models**: a provider and model picker (Auto, Local, OpenAI) next to the chat input and in the Notes panel. Auto uses the local model for shorter texts and OpenAI for longer ones. The server can switch OpenAI off completely (`ALLOW_EXTERNAL=false`).
- **Note styles**: Study notes (summary, key points, terms), Brief, Outline, Cheat sheet, Lecture guide, Simple explanation and By chapter. Each style is generated and kept separately for every source.
- **By-chapter notes**: an overview of the whole material, a list of chapters, then a summary of each chapter. Chapters are detected from the PDF outline, then by the model from candidate heading lines, then by topic segmentation; the detected chapters are shown and can be detected again with **Detect again**.
- **Chat with citations**: answers cite numbered sources as chips; clicking a chip shows the cited excerpt and a link to the whole source. If the selected sources do not contain the answer, the app says so.
- **Background processing**: indexing and notes run in a background queue. The UI shows the status and progress and refreshes automatically; unfinished jobs continue after a server restart with the same provider and model.

## How it works

| Part | Technology |
|---|---|
| Server | Node.js (ES modules), Express, multer, unpdf (PDF text) |
| Client | React with Vite, react-markdown |
| Database | SQLite via better-sqlite3, vectors via the sqlite-vec extension |
| Notes and answers | A local chat model through Ollama, or the OpenAI API |
| Embeddings for search | Ollama with the `bge-m3` model, always local |

Material text is split into chunks of about 400 words (60 words overlap), embedded with Ollama and stored in the same SQLite database. A question is embedded the same way, the 6 most similar chunks of the selected sources are found, and the chosen model answers using only those excerpts.

Long materials are split into parts for notes: 60,000 characters for OpenAI and `LOCAL_PART_CHARS` for the local model (smaller when needed to fit `LOCAL_CONTEXT_TOKENS`). The parts are summarized one by one and the results are merged.

All model calls are in `server/llm.js`. The full specification (in Slovenian) is in `docs/spec.md`.

## Prerequisites

- **Node.js 22 or newer** (`node -v`). The scripts use Node's built-in `--env-file` and `node:test`.
- **Ollama** from [ollama.com](https://ollama.com), with the embedding model `bge-m3` and, for local notes and answers, a chat model such as `gemma3:4b` (see [Ollama](#ollama)).
- **An OpenAI API key** with billing or credit, from [platform.openai.com](https://platform.openai.com). Optional: without it, use the local model only.
- **Git**. On Windows, run the commands in Git Bash.

`better-sqlite3` ships prebuilt binaries for Windows, macOS and Linux. If installation fails with a compile error on Windows, install Visual Studio Build Tools with the "Desktop development with C++" workload.

## Installation

```bash
git clone <repository-url> study-notes
cd study-notes
npm install
npm --prefix client install
cp .env.example .env
```

Then edit `.env` (see [Configuration](#configuration)): set `OPENAI_API_KEY` if you use OpenAI, and `LOCAL_LLM_MODEL` to the local chat model you installed.

## Configuration

All configuration is read from `.env` in the project root. `.env` is ignored by Git and must never be committed. `.env.example` lists every variable with its recommended value. The numeric limits (`LOCAL_MAX_CHARS`, `LOCAL_PART_CHARS` and those under "Output and context limits" and "Time limits") fall back to the recommended value when they are missing or invalid; a missing `DEFAULT_PROVIDER` means `auto`.

### Basics

| Variable | Recommended | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | – | OpenAI API key. Needed only for the OpenAI provider; keep it out of Git. |
| `OPENAI_MODEL` | `gpt-5-mini` | Default OpenAI model, also used by Auto for long texts. Check current model names on platform.openai.com. |
| `OLLAMA_URL` | `http://localhost:11434` | Address of the Ollama server, for embeddings and local models. |
| `EMBED_MODEL` | `bge-m3` | Ollama embedding model used for search. |
| `EMBED_DIM` | `1024` | Vector length of the embedding model (1024 for `bge-m3`). |
| `PORT` | `3000` | Port of the Express server. |
| `DB_PATH` | `data/app.db` | Path to the SQLite database file; the folder is created if missing. |
| `FILES_DIR` | `data/files` | Folder for the original PDF files, named by material id. When unset, a `files` folder next to `DB_PATH`. |

`EMBED_DIM` is fixed when the database is first created. If you switch to an embedding model with a different vector length, use a new `DB_PATH` (or delete the old database) and add the materials again.

### Providers and models

| Variable | Recommended | Meaning |
|---|---|---|
| `LOCAL_LLM_MODEL` | `gemma3:4b` | Default local chat model in Ollama. It must be installed (`ollama pull`). |
| `LOCAL_MAX_CHARS` | `60000` | With Auto, texts up to this many characters use the local model, longer ones use OpenAI. |
| `LOCAL_PART_CHARS` | `15000` | Size of the parts a long text is split into for the local model. |
| `DEFAULT_PROVIDER` | `auto` | Provider used when the user has not chosen one: `auto`, `local` or `openai`. |
| `ALLOW_EXTERNAL` | `true` | `false` switches OpenAI off, so no material text leaves the computer. Auto then uses only the local model and refuses texts longer than `LOCAL_MAX_CHARS`. |
| `OPENAI_MODELS` | `gpt-5-mini` | Comma-separated OpenAI models offered in the picker. `OPENAI_MODEL` is always included. |

### Output and context limits

| Variable | Recommended | Meaning |
|---|---|---|
| `OPENAI_MAX_OUTPUT_TOKENS` | `16000` | Output limit of one OpenAI call for notes. A reply cut off by the limit is retried once with double the limit (at most 32,000); answers in the chat use 4,000. |
| `OPENAI_REASONING_EFFORT` | `low` | Reasoning effort for OpenAI reasoning models (`minimal`, `low`, `medium`, `high`). Leave empty for the model's default. |
| `LOCAL_CONTEXT_TOKENS` | `16384` | Context window of the local model in tokens. Requests that would not fit are split before they are sent. Must match `OLLAMA_CONTEXT_LENGTH` (see [Ollama](#ollama)). |
| `LOCAL_MAX_OUTPUT_TOKENS` | `2048` | Output limit of one local model call. |

### Time limits

| Variable | Recommended | Meaning |
|---|---|---|
| `EMBED_TIMEOUT_MS` | `60000` | Time limit of one embedding request (32 chunks). |
| `OPENAI_TIMEOUT_MS` | `300000` | Time limit of one OpenAI call. Node.js waits at most 300 s for a reply, so higher values have no effect. |
| `LOCAL_CHAT_TIMEOUT_MS` | `900000` | Time limit of one local model call. Local replies are streamed, so the limit covers the whole reply, but the first part of the reply must arrive within 300 s. |

A call that runs out of time is not retried; the error names the variable to increase. Calls that fail because of a connection problem, a server error or a rate limit are retried up to three times (rate limits wait as long as OpenAI asks, up to one minute).

## Ollama

Ollama must be running whenever materials are indexed, questions are asked or the local model is used.

1. Install Ollama and make sure it is running (it serves on port 11434).
2. Download the embedding model and a local chat model:

   ```bash
   ollama pull bge-m3
   ollama pull gemma3:4b
   ```

   Any installed chat model can be chosen in the app; set the default in `LOCAL_LLM_MODEL`. Larger models give better notes but are slower.
3. Set Ollama's context length to the same value as `LOCAL_CONTEXT_TOKENS` (16384 with the recommended settings). `OLLAMA_CONTEXT_LENGTH` is a setting of the **Ollama server**, not of this app's `.env`:
   - Windows: add a user environment variable `OLLAMA_CONTEXT_LENGTH` with the value `16384` (Settings → System → About → Advanced system settings → Environment Variables), then quit Ollama from the tray and start it again.
   - macOS and Linux: start the server with `OLLAMA_CONTEXT_LENGTH=16384 ollama serve`, or set the variable in the Ollama service configuration.

   If Ollama's context is smaller than `LOCAL_CONTEXT_TOKENS`, long requests are cut off and notes fail with a message about the local model's context.
4. Check that the embedding model works:

   ```bash
   curl http://localhost:11434/api/embed -d '{"model":"bge-m3","input":["test"]}'
   ```

If Ollama is not reachable, new materials get the status Error with the message "Embedding service (Ollama) is not reachable." Start Ollama, stop the app server and run `npm run reindex` to index them again. The first request after Ollama starts can take a few seconds while the model loads. **Settings** (gear icon in the top bar) shows whether Ollama is reachable and which chat models are installed.

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
| `npm run reindex` | Index all materials again (chunks and vectors). **Stop the server first.** |
| `npm run eval` | Run the search evaluation |

## Using the app

### Courses and sources

1. On the home screen, click **New course**, enter a name and click **Create course**. Click a course card to open its workspace.
2. The workspace has three panels: **Sources** (left), **Chat** (center) and **Notes** (right). Drag the dividers (or focus them and use the arrow keys) to resize the panels; on narrow screens the panels become tabs. **Reset layout** in **Settings** restores the default panel widths.
3. Click **Add source**. In the **Upload file** tab, drop a file or choose one (TXT, SRT, VTT or PDF); in the **Paste text** tab, paste the text. Give the source a title and add it.
4. The source appears with the status **Processing** and becomes **Ready** when it is indexed; a message appears when it is done. If processing fails, the status is **Error**; hover over or focus the badge to read the reason.
5. Use the open icon of a source to read its full text, and the trash icon to delete it together with its notes and search data.

### Selecting sources

Every source has a checkbox. Questions are answered only from the checked sources; **Select all** and **Clear** check or uncheck all of them, and the panel shows how many are selected. Clicking a source's **title** shows that source in the Notes panel (it does not change the checkboxes).

### Choosing the provider and model

The picker next to the chat input and in the Notes panel has three options:

- **Auto**: the local model (`LOCAL_LLM_MODEL`) when the text has at most `LOCAL_MAX_CHARS` characters and Ollama has the model, otherwise OpenAI (`OPENAI_MODEL`).
- **Local**: always the local model chosen in the list; never switches to OpenAI.
- **OpenAI**: the OpenAI model chosen in the list. It cannot be chosen when `ALLOW_EXTERNAL=false`, no API key is set or no OpenAI models are configured; hover over it to see why.

The choice applies to both chat and notes and is remembered in the browser. Notes that are still being generated when the server restarts continue with the same provider and model; if that model is no longer available, they fail with a message naming it instead of switching to another provider.

### Generating notes

1. Click a source title in the Sources panel.
2. In the Notes panel, choose a style in the style list (its description is shown below), choose the provider and model, and click **Generate** (**Regenerate** if notes in that style exist).
3. While the notes are generated, the panel shows the current step (for by-chapter notes the chapter, e.g. "Chapter 3 of 7"), the model calls done out of those planned, and the elapsed time. Long materials can take several minutes with OpenAI and much longer with a local model.
4. Generated styles are shown as tabs. **Copy** copies the notes as Markdown, **Delete** removes them. The expand button shows the notes at the full width (Esc returns).

**By chapter**: the notes start with an overview and a list of chapters, followed by a summary of each chapter. Above the notes, "Detected N chapters (PDF outline | model | topic segmentation)" shows how the chapters were found; expand it to see their titles. If no chapters are found, the material is summarized by parts. **Regenerate** reuses the detected chapters; **Detect again** detects them anew and then regenerates the notes.

### Asking questions

Type a question in the Chat panel and press Enter (Shift+Enter for a new line); with an empty chat, you can also click one of the suggested questions. The answer cites numbered sources as chips. Click a chip to see the source title and the cited excerpt; **Open source** opens the whole source. If the selected sources do not contain the answer, the reply is "I could not find the answer in the materials."

## Tests

```bash
npm test
```

Runs all tests in `tests/` with `node:test`. The tests use temporary databases and fake Ollama and OpenAI services (`tests/helpers/`), so they need neither Ollama nor an API key, never call a model and never touch `data/app.db`.

## Search evaluation

```bash
npm run eval
```

Checks how well search finds the right material. For each entry in `eval/questions.json` the script runs only the search (no answer model) and prints whether the expected material is among the found sources, followed by the overall hit rate.

Replace the sample entries in `eval/questions.json` with real questions about your materials, using the material titles shown in the app. The comparison ignores case and a leading numbering prefix, so `Cell biology` matches a material titled `2. Cell biology`:

```json
[
  { "question": "What do plants need for photosynthesis?", "expectedMaterial": "Photosynthesis" }
]
```

Entries whose title does not match any material are marked in the output. The evaluation needs `.env`, a running Ollama and an existing database with at least one Ready material. It only reads the database.

## Limitations

- **No login and no permissions.** Anyone who can reach the server can read, add and delete all materials and use the configured OpenAI key. Run the app only on a trusted internal company network, never on the public internet.
- **Local models are slow on long materials.** A book is split into many parts, and every part, merge and chapter is a separate call; notes can take a long time. Use Auto or OpenAI for long materials, or a smaller local model.
- **Stop the server before `npm run reindex`.** The script and a running server write to the same database without coordinating; the script prints a warning about this.
- With the OpenAI provider, material text is sent to the OpenAI API. For internal materials this requires the company's approval; set `ALLOW_EXTERNAL=false` to prevent it. Embeddings are always created locally with Ollama.
- The background queue is in memory and runs one job at a time, so a long notes job delays the indexing of new sources. Unfinished jobs start again from the beginning after a restart.
- Search takes the 30 nearest chunks of all materials and keeps the 6 best from the selected sources, so with many other materials a selected source can be missed.
- Only English materials. DOCX and scanned PDFs are not supported.

## Project structure

```
server/
  index.js        Express app and API routes
  db.js           database, tables, migrations, sqlite-vec
  llm.js          Ollama and OpenAI calls (the only place that calls models)
  jobs.js         in-memory background job queue
  materials/      conversion of uploads (TXT, SRT, VTT, PDF) to text, storage
  notes/          note styles, notes generation, chapter detection
  rag/            chunking, indexing, search, answers, reindex script
client/src/
  App.jsx         navigation between views
  api.js          API calls
  views/          Home, Workspace, SourceViewer
  components/     one component per file
  styles/         design tokens and styles
tests/            node:test tests, fixtures and fake services
eval/             search evaluation (questions.json, run.js)
docs/             specification, development log and code review
data/             SQLite database (not in Git)
```
