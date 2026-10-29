// Fills empty "My changes and outcome" lines in docs/devlog.md.
// Usage: node fill-devlog.mjs docs/devlog.md
// Only empty lines are filled; existing text is never changed.
import fs from 'node:fs';

const outcomes = {
  '23/10/2026, 16:52:05': 'Success. Claude Code found the specification under the old name docs/Nacrt_razvoja_aplikacije.md, so I renamed it to docs/spec.md.',
  '23/10/2026, 17:09:20': 'Partial. The file name and the system prompts were fixed. Flattened tables and missing code fences from the PDF export remained; I accepted them because Claude Code could still read the specification.',
  '23/10/2026, 17:14:38': 'Success. Checked "Server online" with npm run dev; npm test passed 3 of 3.',
  '23/10/2026, 17:21:13': 'Success. Verification only: better-sqlite3 works on Windows without Visual Studio Build Tools.',
  '23/10/2026, 18:24:58': 'Success. Step 3a accepted; npm test passed 21 of 21.',
  '23/10/2026, 18:37:13': 'Success. Tested pasted text, SRT and TXT upload in the browser; one oxlint warning left as is.',
  '23/10/2026, 18:59:50': 'Success. Notes were generated with OpenAI in the required structure (Summary, Key points, Terms).',
  '23/10/2026, 21:41:24': 'Success. Ollama with bge-m3 returned 1024-dimensional vectors and materials were indexed.',
  '23/10/2026, 21:56:37': 'Success. Questions were answered with numbered citations to the sources.',
  '23/10/2026, 22:45:01': 'Partial. The evaluation scored 0 of 3 because the sample titles did not match the stored titles; fixed in the next prompt.',
  '23/10/2026, 22:59:54': 'Success. The evaluation scored 3 of 3 after title normalization.',
  '23/10/2026, 23:01:49': 'My mistake: I typed a git command into Claude Code instead of the terminal. It only staged the files. Lesson: git commands go to the terminal.',
  '28/10/2026, 13:53:48': 'PDF import: success. This prompt (the UI redesign) was sent too early, while the PDF import was still running, so the summary above belongs to the PDF import. I sent the redesign again at 14:19.',
  '28/10/2026, 14:16:54': 'Success. Server-only change; the UI did not change in this step, as planned.',
  '28/10/2026, 14:19:39': 'Success. At first I did not see the new UI; after restarting the app it appeared and all point 8 functions worked.',
  '29/10/2026, 11:16:43': 'Success. Before this step I set up Ollama on Windows: PowerShell instead of Git Bash, and an NVIDIA Studio driver update so the GPU is used. gemma3:4b runs fully on the 6 GB GPU; llama3.1:8b only partly.',
  '29/10/2026, 11:41:03': 'Success. Notes in different styles are stored separately per material.',
  '29/10/2026, 17:46:50': 'Popover fix (prompt at 17:42): success. The test-server notification is automatic, not my prompt.',
  '29/10/2026, 17:51:57': 'Dividers (prompt at 17:49): no bug in the code. The dividers existed only on unmerged branches (fix/local-context, fix/local-merge), and main was behind. Lesson: merge each branch before starting the next.',
  '29/10/2026, 18:00:46': 'The diagnosis was confirmed. A merge left in progress blocked switching branches, so I ran git reset --hard HEAD, merged fix/local-merge and redid the popover merge. I resolved a docs/devlog.md conflict with "Accept Both Changes". The reset also deleted uncommitted work on jumping to the cited passage.',
  '29/10/2026, 12:00:35': 'Notes layout (prompt at 11:55): success. These entries appear out of time order because they came from another branch during a merge.',
  '29/10/2026, 13:26:00': 'Partial. LOCAL_CONTEXT_TOKENS was missing from my .env at first. After adding it, merging with the local model still failed; continued in fix/local-merge.',
  '29/10/2026, 13:35:55': 'Success. The cause was reasoning tokens counting toward the output limit. I set OPENAI_MAX_OUTPUT_TOKENS=16000 and OPENAI_REASONING_EFFORT=low in .env.',
  '29/10/2026, 15:15:38': 'Claude Code ran a long check with the real model in the background, so the summary is in the next entry.',
  '29/10/2026, 16:23:55': 'Success. The real cause was the output limit (2048 tokens), not the context. Local notes for the whole material now finish, but slowly.',
  '29/10/2026, 17:00:49': 'Progress and toolbar (prompt at 16:51): success. The progress bar shows the phase and steps; the toolbar no longer jumps when switching providers.',
  '29/10/2026, 19:24:27': 'Refused, correctly: my prompt named "Nadgradnja 7", but the section in the spec is "Nadgradnja 6", and page_offsets had been lost with the git reset.',
  '29/10/2026, 19:26:35': 'Success. By-chapter notes work with all three detection methods.',
  '29/10/2026, 19:51:11': 'Success. 33 findings, none critical. I also had OpenAI (ChatGPT) review the code: it found 6 findings, but it read an older version of the code and ran no tests. Both found the missing timeouts and the missing login; they disagreed on how serious the search filter problem is.',
  '29/10/2026, 20:48:26': 'R4 accepted. I later decided against the bind-address part of R5: the app must be reachable from all computers in the company network.',
  '29/10/2026, 20:55:09': 'Same prompt sent twice by mistake; the result is the same as above.',
  '29/10/2026, 20:59:27': 'Success. The app listens on all interfaces again; access is limited by the company network instead of a login.',
  '29/10/2026, 21:03:39': 'Success. README now matches the current app.',
  '29/10/2026, 21:23:58': 'Success. The existing database was migrated automatically on the next start, without reindexing. I updated docs/spec.md myself (Nadgradnja 7 and the notes after the code review).',
  '29/10/2026, 21:41:41': 'Success. The window scrollbar is gone; only the panels scroll.',
  '29/10/2026, 21:48:22': 'Partial. Only the server part was done before the Claude usage limit was reached; continued after the reset.',
  '29/10/2026, 22:51:51': 'Success. Opening a cited source scrolls to the highlighted passage and shows the PDF page again (this was lost with the earlier git reset).',
  '29/10/2026, 23:58:30': 'Works, but it had three options (System, Light, Dark); I wanted only Light and Dark, so I simplified it in the next prompt.',
  '29/10/2026, 20:28:36': 'Review fixes R1, R2, R3, R7, R13, R17 (prompt at 20:21): success. Claude Code found that Node.js stops waiting for response headers after 300 s and asked how to proceed; I chose streaming for local replies. Added the new timeout variables to .env.',
};

const file = process.argv[2] || 'docs/devlog.md';
const raw = fs.readFileSync(file, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split(/\r?\n/);
let current = null;
let filled = 0;
for (let i = 0; i < lines.length; i++) {
  const h = lines[i].match(/^### (\d\d\/\d\d\/\d{4}, \d\d:\d\d:\d\d)\s*$/);
  if (h) current = h[1];
  if (current && /^\*\*My changes and outcome:\*\*\s*$/.test(lines[i]) && outcomes[current]) {
    lines[i] = `**My changes and outcome:** ${outcomes[current]}`;
    filled++;
    current = null;
  }
}
fs.writeFileSync(file, lines.join(eol));
console.log(`Filled ${filled} entries in ${file}.`);
