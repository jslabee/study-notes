import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFakeOllama } from './helpers/fake-ollama.js';
import { installFakeOpenAI } from './helpers/fake-openai.js';
import { buildPdf, textStream } from './fixtures/make-pdf.js';

// Temporary database; Ollama and OpenAI are faked, so no real calls are made
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-notes-chapters-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OPENAI_MODELS = '';
process.env.ALLOW_EXTERNAL = 'true';
const fakeOllama = installFakeOllama({ dim: 8 });
const fakeOpenAI = installFakeOpenAI();

const { app } = await import('../server/index.js');
const { getDb, closeDb } = await import('../server/db.js');
const { whenIdle } = await import('../server/jobs.js');
const { outlineToChapters, pdfToTextWithPages } = await import('../server/materials/convert.js');
const chapters = await import('../server/notes/chapters.js');
const { generateNotes, mergeMessage, MAX_PART_CHARS } = await import('../server/notes/generate.js');
const { CANDIDATES_PROMPT, OVERVIEW_PROMPT, SECTION_TITLE_PROMPT, chapterPrompt, mergePrompt, getStyle } =
  await import('../server/notes/styles.js');
const {
  MIN_CHAPTER_WORDS,
  chapterTexts,
  detectChapters,
  findCandidates,
  parseChapterChoice,
  selectCandidates,
  topicBoundaries,
  validateChapters,
} = chapters;

let server;
let baseUrl;
let courseId;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  courseId = getDb().prepare("INSERT INTO courses (name) VALUES ('Biology')").run().lastInsertRowid;
});

after(() => {
  server.close();
  closeDb();
  fakeOpenAI.restore();
  fakeOllama.restore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Text of about `words` words in paragraphs; every sentence (7 words) names its topic
function body(topic, words = 400) {
  const sentences = Array.from({ length: Math.ceil(words / 7) }, (_, i) => `Sentence ${i} about ${topic} adds a fact.`);
  const paragraphs = [];
  for (let i = 0; i < sentences.length; i += 6) paragraphs.push(sentences.slice(i, i + 6).join(' '));
  return paragraphs.join('\n\n');
}

const noModel = async () => assert.fail('the model must not be called');
const fitsAll = () => true;

// --- Method 1: PDF outline ---

test('outline entries are mapped to the offsets where their pages start', () => {
  assert.deepEqual(
    outlineToChapters(
      [
        { title: ' Cells \n and tissues ', pageIndex: 0 },
        { title: 'Energy', pageIndex: 2 },
        { title: 'Missing page', pageIndex: 9 },
        { title: '  ', pageIndex: 1 },
      ],
      [0, 120, 260]
    ),
    [
      { title: 'Cells and tissues', start: 0 },
      { title: 'Energy', start: 260 },
    ]
  );
});

// Four pages of 400 words each; every line is a sentence naming its page
const bookPages = [1, 2, 3, 4].map((page) =>
  textStream(
    Array.from({ length: 40 }, (_, line) => [40, 800 - line * 16, `Page ${page} line ${line} says how a cell uses energy.`])
  )
);
const bookOutline = [
  { title: 'Cells', page: 0 },
  // A subsection is not a chapter
  { title: 'Energy', page: 1, children: [{ title: 'ATP', page: 2 }] },
  { title: 'Growth', page: 3 },
];

test('PDF import reads the top-level outline with the page offsets of the cleaned text', async () => {
  const { text, pageOffsets, outline } = await pdfToTextWithPages(buildPdf(bookPages, { outline: bookOutline }));
  assert.equal(pageOffsets.length, 4);
  assert.ok(text.slice(pageOffsets[3]).startsWith('Page 4 line 0 says'));
  assert.deepEqual(outline, [
    { title: 'Cells', start: 0 },
    { title: 'Energy', start: pageOffsets[1] },
    { title: 'Growth', start: pageOffsets[3] },
  ]);

  // Without bookmarks there is no outline
  assert.deepEqual((await pdfToTextWithPages(buildPdf(bookPages))).outline, []);
});

test('detection uses the PDF outline first, without any model call', async () => {
  const { text, outline } = await pdfToTextWithPages(buildPdf(bookPages, { outline: bookOutline }));
  const result = await detectChapters({ title: 'Book', content: text, outline }, { complete: noModel, fits: fitsAll });
  assert.equal(result.method, 'outline');
  assert.deepEqual(result.chapters, outline);
});

// --- Method 2: the model picks among candidate heading lines ---

const HEADER = 'BIOLOGY 101 - LECTURE NOTES';
const modelText = [
  'Biology for Beginners',
  'Contents',
  'Cells and Tissues',
  'How Plants Make Energy',
  'Growth',
  HEADER,
  'Cells and Tissues',
  body('cells', 200),
  'The cell membrane',
  body('membranes', 300),
  HEADER,
  'How Plants Make Energy',
  body('plants', 500),
  'Page 12 of 40',
  'Growth',
  body('growth', 500),
].join('\n\n');

// Candidate ids of lines by their text, the nth occurrence (from 0)
const idOf = (candidates, text, nth = 0) => candidates.filter((c) => c.text === text)[nth].id;

test('candidate lines include short lines of their own, with the words that follow them', () => {
  const candidates = findCandidates(modelText);
  const texts = candidates.map((c) => c.text);
  // Table of contents entries and running headers are candidates too; the model sorts them out
  assert.deepEqual(texts.slice(0, 7), [
    'Biology for Beginners',
    'Contents',
    'Cells and Tissues',
    'How Plants Make Energy',
    'Growth',
    HEADER,
    'Cells and Tissues',
  ]);
  // Mostly digits is not a heading, and long body paragraphs are not candidates
  assert.ok(!texts.includes('Page 12 of 40') || texts.every((t) => t !== '12'));
  assert.ok(candidates.every((c) => c.text.length < 120));
  assert.deepEqual(
    candidates.map((c) => c.id),
    candidates.map((_, i) => i + 1)
  );
  for (const c of candidates) assert.equal(modelText.slice(c.start, c.start + c.text.length), c.text);
  assert.equal(candidates.find((c) => c.text === 'Contents').words, 0);
  // The words up to the next candidate (here the short last paragraph of the section)
  const membrane = candidates.find((c) => c.text === 'The cell membrane');
  const next = candidates.find((c) => c.id === membrane.id + 1);
  assert.equal(membrane.words, chapters.countWords(modelText.slice(membrane.start + membrane.text.length, next.start)));
  assert.ok(membrane.words > 200);
});

test('lines that are mostly digits are not candidates', () => {
  const texts = findCandidates('Intro\n\n12 / 40\n\n2024-05-01\n\nChapter 3\n\nText').map((c) => c.text);
  assert.deepEqual(texts, ['Intro', 'Chapter 3', 'Text']);
});

test('the model chooses the chapters; table of contents, headers and subsections are left out', async () => {
  const requests = [];
  const complete = async (phase, system, user) => {
    requests.push({ phase, system, user });
    const sent = findCandidates(modelText);
    // A real model would leave out the table of contents, headers and the subsection
    return `\`\`\`json\n${JSON.stringify({
      chapters: [
        { id: idOf(sent, 'Cells and Tissues', 1), title: 'Cells and Tissues' },
        { id: idOf(sent, 'How Plants Make Energy', 1), title: ' How Plants\nMake Energy ' },
        { id: 999, title: 'Unknown id' },
        { id: idOf(sent, 'Growth', 1) },
      ],
    })}\n\`\`\``;
  };
  const result = await detectChapters({ title: 'Biology', content: modelText, outline: null }, { complete, fits: fitsAll });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].phase, 'detect');
  assert.equal(requests[0].system, CANDIDATES_PROMPT);
  assert.ok(requests[0].user.startsWith('Material title: Biology\n\n<candidates>\nid=1 | words=0 | Biology for Beginners\n'));
  assert.ok(requests[0].user.includes(`| ${HEADER}\n`));

  assert.equal(result.method, 'model');
  // The first chapter is short (200 words) only on its own; with the text before it, it is long
  // enough, so the three chapters stay
  assert.deepEqual(result.chapters, [
    { title: 'Cells and Tissues', start: modelText.indexOf('Cells and Tissues', modelText.indexOf(HEADER)) },
    { title: 'How Plants Make Energy', start: modelText.lastIndexOf('How Plants Make Energy') },
    { title: 'Growth', start: modelText.lastIndexOf('Growth') },
  ]);
});

test('with too many candidates, the ones followed by the most words are sent, in order', () => {
  const candidates = findCandidates(modelText);
  // Room for 3 candidate lines
  const sent = selectCandidates(modelText, candidates, (list) => list.length <= 3);
  const mostWords = [...candidates]
    .sort((a, b) => b.words - a.words || a.id - b.id)
    .slice(0, 3)
    .map((c) => c.id)
    .sort((a, b) => a - b);
  // In document order, with their original ids
  assert.deepEqual(
    sent.map((c) => c.id),
    mostWords
  );
  // None of the table of contents entries (no words after them) is sent
  const toc = candidates.slice(1, 5).map((c) => c.id);
  assert.ok(sent.every((c) => !toc.includes(c.id)));
  // Words are counted again to the next candidate that is sent
  const total = chapters.countWords(modelText.slice(sent[0].start));
  assert.equal(sent.reduce((sum, c) => sum + c.words, 0) + sent.reduce((sum, c) => sum + chapters.countWords(c.text), 0), total);
});

test('replies that are not valid JSON are rejected; unknown ids are ignored', () => {
  const candidates = [
    { id: 1, text: 'One', start: 0 },
    { id: 2, text: 'Two', start: 50 },
  ];
  assert.throws(() => parseChapterChoice('The chapters are 1 and 2.', candidates), chapters.InvalidReplyError);
  assert.throws(() => parseChapterChoice('{"chapters": [', candidates), chapters.InvalidReplyError);
  assert.throws(() => parseChapterChoice('{"parts": []}', candidates), chapters.InvalidReplyError);
  assert.deepEqual(parseChapterChoice('{"chapters":[{"id":"2","title":"Second"},{"id":7},{"id":2}]}', candidates), [
    { title: 'Second', start: 50 },
  ]);
  assert.deepEqual(parseChapterChoice('{"chapters":[]}', candidates), []);
});

// --- Method 3: topic segmentation ---

// Unit vector pointing mostly along axis `topic`, slightly different for each chunk
function topicVector(topic, i) {
  const v = new Float32Array(8);
  v[topic] = 1;
  v[7] = 0.05 * (i % 3);
  const length = Math.hypot(...v);
  return v.map((x) => x / length);
}

test('topic segmentation splits at the largest similarity drops into ordered sections', () => {
  // Three topics of 12, 9 and 15 chunks: 36 chunks, about 4 sections
  const topics = [...Array(12).fill(0), ...Array(9).fill(1), ...Array(15).fill(2)];
  const vectors = topics.map((topic, i) => topicVector(topic, i));
  const boundaries = topicBoundaries(vectors);
  assert.ok(boundaries.includes(12) && boundaries.includes(21), boundaries.join(','));
  assert.deepEqual(boundaries, [...boundaries].sort((a, b) => a - b));
  // Every section has at least half the average number of chunks
  const edges = [0, ...boundaries, vectors.length];
  const minimum = Math.floor(vectors.length / (boundaries.length + 1) / 2);
  for (let i = 1; i < edges.length; i++) assert.ok(edges[i] - edges[i - 1] >= minimum);

  // 2 to 30 sections
  assert.equal(topicBoundaries(vectors.slice(0, 5)).length, 1);
  assert.equal(topicBoundaries(Array.from({ length: 600 }, (_, i) => topicVector(i % 7, i))).length, 29);
  assert.deepEqual(topicBoundaries([topicVector(0, 0)]), []);
});

// A lecture without headings: 3 topics of 10 chunks (about 400 words each) with their vectors;
// only a greeting and a closing line are short lines of their own
const lectureChunks = ['cells', 'plants', 'growth']
  .flatMap((topic, t) => Array.from({ length: 10 }, (_, i) => ({ text: body(`${topic} part ${i}`, 400), topic: t })))
  .map((chunk, i) => ({ text: chunk.text, vector: topicVector(chunk.topic, i) }));
const lecture = ['Welcome to the lecture', ...lectureChunks.map((chunk) => chunk.text), 'Thank you'].join('\n\n');

test('invalid JSON from the model falls back to topic segmentation with short titles', async () => {
  const requests = [];
  const titles = ['"Cell Basics."', '## Plant Energy', 'Growth of Organisms'];
  const complete = async (phase, system, user) => {
    requests.push({ system, user });
    return system === CANDIDATES_PROMPT ? 'Sorry, I cannot do that.' : titles.shift();
  };
  const logs = [];
  const result = await detectChapters(
    { title: 'Lecture', content: lecture, outline: null },
    { complete, fits: fitsAll, chunks: () => lectureChunks, log: (line) => logs.push(line) }
  );
  assert.equal(requests[0].system, CANDIDATES_PROMPT);
  assert.ok(logs[0].startsWith('[chapters] model failed: '));
  assert.equal(result.method, 'topics');
  assert.deepEqual(
    result.chapters.map((c) => c.title),
    ['Cell Basics', 'Plant Energy', 'Growth of Organisms']
  );
  assert.deepEqual(
    result.chapters.map((c) => c.start),
    [0, lecture.indexOf(lectureChunks[10].text), lecture.indexOf(lectureChunks[20].text)]
  );
  const titleRequests = requests.filter((r) => r.system === SECTION_TITLE_PROMPT);
  assert.equal(titleRequests.length, 3);
  assert.ok(titleRequests[0].user.startsWith('Material title: Lecture\n\n<section>\nWelcome to the lecture\n\n'));
  assert.ok(titleRequests[1].user.startsWith('Material title: Lecture\n\n<section>\nSentence 0 about plants part 0'));
  for (const chapter of chapterTexts(lecture, result.chapters)) {
    assert.ok(chapters.countWords(chapter.text) >= MIN_CHAPTER_WORDS);
  }
});

test('the model method falls back when its reply is invalid; nothing found means summarize by parts', async () => {
  const logs = [];
  const content = ['Intro', body('a', 400), 'Next', body('b', 400)].join('\n\n');
  const result = await detectChapters(
    { title: 'Short', content, outline: null },
    { complete: async () => 'not json', fits: fitsAll, log: (line) => logs.push(line) }
  );
  assert.deepEqual(result, { method: null, chapters: [] });
  assert.ok(logs.some((line) => line.startsWith('[chapters] model failed: ')));
});

// --- Validation ---

test('validation keeps 2 to 60 chapters in increasing order and merges short ones', () => {
  const parts = ['A', 'B', 'C', 'D'].map((name, i) => ({ name, text: body(name, [400, 100, 400, 50][i]) }));
  const content = parts.map((p) => `${p.name}\n\n${p.text}`).join('\n\n');
  const at = (name) => content.indexOf(`${name}\n\nSentence 0 about ${name}`);
  const all = parts.map((p) => ({ title: p.name, start: at(p.name) }));

  // B (100 words) joins A, D (50 words) joins C
  assert.deepEqual(validateChapters(content, all), [
    { title: 'A', start: at('A') },
    { title: 'C', start: at('C') },
  ]);
  // A short first chapter joins the next one, which then starts the text
  const shortFirst = `Preface\n\n${body('p', 100)}\n\nMain\n\n${body('m', 400)}\n\nEnd\n\n${body('e', 400)}`;
  assert.deepEqual(
    validateChapters(shortFirst, [
      { title: 'Preface', start: 0 },
      { title: 'Main', start: shortFirst.indexOf('Main') },
      { title: 'End', start: shortFirst.indexOf('End') },
    ]).map((c) => c.title),
    ['Main', 'End']
  );

  // Not in increasing order, outside the text, or without a title
  assert.equal(validateChapters(content, [all[2], all[0]]), null);
  assert.equal(validateChapters(content, [all[0], all[0]]), null);
  assert.equal(validateChapters(content, [all[0], { title: 'X', start: content.length + 5 }]), null);
  assert.equal(validateChapters(content, [all[0], { title: ' ', start: all[2].start }]), null);
  // Fewer than 2 after merging
  const ab = `A\n\n${body('A', 400)}\n\nB\n\n${body('B', 100)}`;
  assert.equal(validateChapters(ab, [{ title: 'A', start: 0 }, { title: 'B', start: ab.indexOf('B\n\n') }]), null);
  assert.equal(validateChapters(content, []), null);
  // More than 60
  const many = Array.from({ length: 61 }, (_, i) => `H${i}\n\n${body(`t${i}`, 400)}`).join('\n\n');
  const starts = [...many.matchAll(/^H\d+$/gm)].map((m) => ({ title: m[0], start: m.index }));
  assert.equal(starts.length, 61);
  assert.equal(validateChapters(many, starts), null);
  assert.equal(validateChapters(many, starts.slice(0, 60)).length, 60);
});

// --- Generation ---

const bookTitles = ['Cells', 'Energy', 'Growth'];
const book = bookTitles.map((t) => `${t}\n\n${body(t, 400)}`).join('\n\n');
const bookDetection = {
  method: 'model',
  chapters: bookTitles.map((t) => ({ title: t, start: book.indexOf(`${t}\n\nSentence 0`) })),
};

function mockChat() {
  const calls = [];
  const chat = async (args) => {
    calls.push(args);
    if (args.system === OVERVIEW_PROMPT) return { text: '## Overview\nThe whole book.\n\n## Chapters at a glance\n1. All.' };
    const title = bookTitles.find((t) => args.system === chapterPrompt(t));
    assert.ok(title, `unexpected system prompt: ${args.system.slice(0, 60)}`);
    return { text: `## ${title}\nSummary of ${title}.\n` };
  };
  return { calls, chat };
}

test('by-chapter notes are the overview, the chapters at a glance and one section per chapter', async () => {
  const { calls, chat } = mockChat();
  const progress = [];
  const notes = await generateNotes(
    { id: 1, title: 'Biology', content: book },
    { style: 'by-chapter', chat, detection: bookDetection, onProgress: (p) => progress.push(p) }
  );
  assert.equal(
    notes,
    [
      '## Overview\nThe whole book.\n\n## Chapters at a glance\n1. All.',
      '## Cells\nSummary of Cells.',
      '## Energy\nSummary of Energy.',
      '## Growth\nSummary of Growth.',
    ].join('\n\n')
  );
  assert.deepEqual(
    calls.map((c) => c.system),
    [...bookTitles.map(chapterPrompt), OVERVIEW_PROMPT]
  );
  assert.equal(getStyle('by-chapter').prompt, chapterPrompt('{chapter title}'));
  // Each chapter call has only its own chapter
  const texts = chapterTexts(book, bookDetection.chapters);
  assert.equal(calls[1].user, `Material title: Biology\n\n<material>\n${texts[1].text}\n</material>`);
  assert.ok(texts[1].text.startsWith('Energy\n\nSentence 0 about Energy'));
  // The overview gets every summary, in order
  assert.equal(
    calls[3].user,
    'Material title: Biology\n\n' +
      bookTitles.map((t, i) => `<chapter number="${i + 1}">\n## ${t}\nSummary of ${t}.\n\n</chapter>`).join('\n\n')
  );

  // Progress names the chapter being summarized ("Chapter 3 of 3"), then the overview
  assert.deepEqual(
    [...new Set(progress.filter((p) => p.chapter).map((p) => p.chapter.number))],
    [1, 2, 3]
  );
  assert.deepEqual(progress.find((p) => p.chapter?.number === 3).chapter, { kind: 'chapter', number: 3, count: 3 });
  assert.equal(progress.find((p) => p.total > 0).total, 4);
  const last = progress.at(-1);
  assert.equal(last.phase, 'overview');
  assert.ok(!('chapter' in last));
  assert.equal(last.done, 4);
  assert.equal(last.total, 4);
});

test('a chapter longer than one part is split and merged inside the chapter', async () => {
  const long = body('Energy', Math.ceil((MAX_PART_CHARS * 1.5) / 5));
  const content = `Cells\n\n${body('Cells')}\n\nEnergy\n\n${long}\n\nGrowth\n\n${body('Growth')}`;
  const detection = {
    method: 'model',
    chapters: bookTitles.map((t) => ({ title: t, start: content.indexOf(`${t}\n\nSentence 0`) })),
  };
  const calls = [];
  const merge = mergePrompt({ prompt: chapterPrompt('Energy') });
  const chat = async (args) => {
    calls.push(args);
    if (args.system === merge) return { text: '## Energy\nMerged.' };
    if (args.system === OVERVIEW_PROMPT) return { text: '## Overview\nAll.' };
    return { text: `notes ${calls.length}` };
  };
  const notes = await generateNotes({ id: 1, title: 'Biology', content }, { style: 'by-chapter', chat, detection });

  const energyParts = calls.filter((c) => c.system === chapterPrompt('Energy'));
  assert.equal(energyParts.length, 2);
  assert.ok(energyParts[0].user.includes('This is part 1 of 2.\n'));
  // Calls 2 and 3 are the parts of the Energy chapter; their notes are merged
  const merges = calls.filter((c) => c.system === merge);
  assert.equal(merges.length, 1);
  assert.equal(merges[0].user, mergeMessage('Biology', ['notes 2', 'notes 3']));
  assert.ok(merge.endsWith(`Instructions:\n${chapterPrompt('Energy')}`));
  assert.equal(notes, '## Overview\nAll.\n\nnotes 1\n\n## Energy\nMerged.\n\nnotes 5');
});

test('without stored chapters they are detected first and reported; none found means parts', async () => {
  const { chat } = mockChat();
  let reported;
  const titles = [];
  const detecting = async (args) => {
    if (args.system === CANDIDATES_PROMPT) {
      const sent = [...args.user.matchAll(/^id=(\d+) \| words=\d+ \| (.*)$/gm)];
      const pick = sent.filter((m) => bookTitles.includes(m[2])).map((m) => ({ id: Number(m[1]) }));
      return { text: JSON.stringify({ chapters: pick }) };
    }
    return chat(args);
  };
  await generateNotes(
    { id: 1, title: 'Biology', content: book },
    { style: 'by-chapter', chat: detecting, onChapters: (d) => (reported = d), onProgress: (p) => titles.push(p.phase) }
  );
  assert.deepEqual(reported, bookDetection);
  assert.equal(titles[0], 'detect');

  // No outline, no candidates, no chunks: the parts of the normal split, named after the material
  const calls = [];
  await generateNotes(
    { id: 1, title: 'Cells', content: 'Cells are small.' },
    {
      style: 'by-chapter',
      chat: async (args) => {
        calls.push(args.system);
        return { text: 'x' };
      },
      chunks: () => [],
      onChapters: (d) => (reported = d),
    }
  );
  assert.deepEqual(reported, { method: null, chapters: [] });
  assert.deepEqual(calls, [chapterPrompt('Cells'), OVERVIEW_PROMPT]);
});

// --- API ---

test('the API stores the detected chapters; Detect again detects them anew', async () => {
  const form = new FormData();
  form.append('courseId', courseId);
  form.append('title', 'Cell book');
  form.append('file', new Blob([buildPdf(bookPages, { outline: bookOutline })]), 'book.pdf');
  const upload = await fetch(`${baseUrl}/api/materials`, { method: 'POST', body: form });
  const { id } = await upload.json();
  await whenIdle();

  const stored = getDb().prepare('SELECT page_offsets, outline FROM materials WHERE id = ?').get(id);
  assert.equal(JSON.parse(stored.page_offsets).length, 4);
  assert.deepEqual(
    JSON.parse(stored.outline).map((c) => c.title),
    ['Cells', 'Energy', 'Growth']
  );

  const generate = async (body) => {
    const res = await fetch(`${baseUrl}/api/materials/${id}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ style: 'by-chapter', provider: 'openai', ...body }),
    });
    assert.equal(res.status, 202);
    await whenIdle();
    return (await fetch(`${baseUrl}/api/materials/${id}/notes/by-chapter`)).json();
  };

  fakeOpenAI.answer = '## Notes';
  let notes = await generate();
  assert.equal(notes.status, 'ready');
  assert.deepEqual(notes.chapters, { method: 'outline', titles: ['Cells', 'Energy', 'Growth'] });
  assert.equal(notes.content, Array(4).fill('## Notes').join('\n\n'));

  // Regenerating uses the stored chapters; Detect again replaces them
  getDb()
    .prepare("UPDATE notes SET chapters = ? WHERE material_id = ? AND style = 'by-chapter'")
    .run(JSON.stringify({ method: 'model', chapters: [{ title: 'Kept', start: 0 }, { title: 'Too', start: 3000 }] }), id);
  notes = await generate();
  assert.deepEqual(notes.chapters, { method: 'model', titles: ['Kept', 'Too'] });
  notes = await generate({ redetect: true });
  assert.deepEqual(notes.chapters, { method: 'outline', titles: ['Cells', 'Energy', 'Growth'] });

  // Other styles have no chapters
  fakeOpenAI.answer = '## Brief';
  const brief = await (async () => {
    await fetch(`${baseUrl}/api/materials/${id}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ style: 'brief', provider: 'openai' }),
    });
    await whenIdle();
    return (await fetch(`${baseUrl}/api/materials/${id}/notes/brief`)).json();
  })();
  assert.ok(!('chapters' in brief));

  const styles = await (await fetch(`${baseUrl}/api/note-styles`)).json();
  assert.deepEqual(styles.at(-1), {
    id: 'by-chapter',
    name: 'By chapter',
    description: 'Overview and a summary of each chapter or section (books, long scripts, lectures)',
  });
});
