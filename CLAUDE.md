# Study Notes

Internal web app for Abakus plus. It turns learning materials (lecture transcripts, scripts, books) into structured study notes and answers questions about the content using RAG. The full specification is in docs/spec.md (written in Slovenian). Follow it exactly. Development is part of a diploma thesis, so the devlog matters as much as the code.

## Language
- All code, identifiers, comments, commit messages, UI text, prompts to the model and documentation are in English.
- Materials are in English. No other languages need to be supported.

## Tech stack
- Server: Node.js (ES modules), Express, multer, better-sqlite3, sqlite-vec, openai
- Client: React with Vite in client/, react-markdown, no router library
- Embeddings: Ollama, model bge-m3
- Tests: node:test (npm test)
- Do not add dependencies without my approval.

## Structure
- server/index.js: Express and API routes
- server/db.js: database and tables
- server/llm.js: OpenAI API and Ollama, the only place that calls models
- server/jobs.js: in-memory background job queue
- server/materials/, server/notes/, server/rag/: app modules
- client/src/: UI (App.jsx, api.js, views/)
- tests/, eval/

## Working rules
- Only do what the prompt asks. Do not change other modules.
- Copy model prompts from the specification verbatim.
- Read all configuration (paths, URLs, ports, keys) from environment variables; never hard-code localhost URLs or file paths.
- Run npm test after every change.
- Do not run git commit, merge or push. I do that after review.
- Never write API keys into code.
- Do not modify docs/devlog.md, docs/spec.md or anything in .claude/.
- If a prompt is unclear, ask instead of guessing.

## Devlog
Every reply that finishes work on a prompt must end with exactly these two lines:
SUMMARY: <one or two sentences: what was done and in which files>
TYPE: <design | implementation | bugfix | testing | documentation | question>
The script .claude/hooks/devlog.cjs copies them into docs/devlog.md automatically.
