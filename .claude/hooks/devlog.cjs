// Appends Claude Code prompts and summaries to docs/devlog.md
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const event = process.argv[2]; // 'prompt' or 'stop'
let input = '';

process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const root = process.env.CLAUDE_PROJECT_DIR || data.cwd || process.cwd();
    const file = path.join(root, 'docs', 'devlog.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let entry = '';

    if (event === 'prompt') {
      const time = new Date().toLocaleString('en-GB');
      const prompt = String(data.prompt || '').trim().replace(/\n/g, '\n> ');
      entry = `\n### ${time}\n\n**Prompt:**\n\n> ${prompt}\n`;
    }

    if (event === 'stop' && !data.stop_hook_active) {
      const lines = String(data.last_assistant_message || '').split('\n');
      const field = (label) =>
        (lines.find((l) => l.trim().startsWith(label)) || '')
          .replace(label, '')
          .trim();

      let git = '-';
      try {
        const branch = execSync('git branch --show-current', { cwd: root })
          .toString()
          .trim();
        const changed = execSync('git status --short', { cwd: root })
          .toString()
          .split('\n')
          .filter(Boolean).length;
        git = `branch ${branch}, changed files: ${changed}`;
      } catch {}

      entry =
        `\n**Summary:** ${field('SUMMARY:') || '(no summary)'}\n\n` +
        `**Type:** ${field('TYPE:') || '-'}\n\n` +
        `**Git:** ${git}\n\n` +
        `**My changes and outcome:** \n`;
    }

    if (entry) fs.appendFileSync(file, entry);
  } catch {
    // A devlog error must never block work.
  }
  process.exit(0);
});
