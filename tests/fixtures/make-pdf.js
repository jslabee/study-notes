// Generates the PDF fixtures without any PDF library: node tests/fixtures/make-pdf.js
//   sample.pdf   two pages of text with a repeated header and footer, page numbers,
//                a word hyphenated at a line end and two paragraphs on the first page
//   no-text.pdf  one page with only a drawn rectangle, like a scanned page without a text layer
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const LEADING = 16;

// Each page is a list of [x, y, text]; y grows upwards from the bottom of an A4 page
const SAMPLE_PAGES = [
  [
    [72, 800, 'Introduction to Biology'],
    [72, 740, 'Photosynthesis is the process by which green plants turn light into chemical'],
    [72, 740 - LEADING, 'energy. The process takes place in the chloro-'],
    [72, 740 - 2 * LEADING, 'plasts of plant cells.'],
    [72, 740 - 4 * LEADING, 'Chlorophyll absorbs mostly red and blue light and reflects green light.'],
    [72, 60, 'Lecture notes, spring term'],
    [290, 40, '1'],
  ],
  [
    [72, 800, 'Introduction to Biology'],
    [72, 740, 'Cellular respiration releases the energy stored in glucose. It takes place'],
    [72, 740 - LEADING, 'in the mitochondria.'],
    [72, 60, 'Lecture notes, spring term'],
    [290, 40, '2'],
  ],
];

const escape = (text) => text.replace(/[\\()]/g, (c) => `\\${c}`);

export function textStream(lines) {
  return lines
    .map(([x, y, text]) => `BT /F1 12 Tf 1 0 0 1 ${x} ${y} Tm (${escape(text)}) Tj ET`)
    .join('\n');
}

// Outline (bookmark) objects with ids from rootId on: entries are { title, page (index from 0),
// children }; each points to the top of its page
function outlineObjects(entries, rootId, pageIds) {
  let nextId = rootId + 1;
  const assign = (items) =>
    items.map((item) => ({ ...item, id: nextId++, children: assign(item.children ?? []) }));
  const tree = assign(entries);
  const bodies = new Map();
  const add = (items, parentId) => {
    items.forEach((item, i) => {
      const links = [
        i > 0 ? `/Prev ${items[i - 1].id} 0 R` : '',
        i < items.length - 1 ? `/Next ${items[i + 1].id} 0 R` : '',
        item.children.length
          ? `/First ${item.children[0].id} 0 R /Last ${item.children.at(-1).id} 0 R /Count ${item.children.length}`
          : '',
      ].join(' ');
      bodies.set(
        item.id,
        `<< /Title (${escape(item.title)}) /Parent ${parentId} 0 R /Dest [${pageIds[item.page]} 0 R /Fit] ${links} >>`
      );
      add(item.children, item.id);
    });
  };
  add(tree, rootId);
  bodies.set(
    rootId,
    `<< /Type /Outlines /First ${tree[0].id} 0 R /Last ${tree.at(-1).id} 0 R /Count ${tree.length} >>`
  );
  return [...bodies.entries()].sort(([a], [b]) => a - b).map(([, body]) => body);
}

// Builds a PDF from page content streams, computing the cross-reference offsets;
// pdf.js ignores text outside the page, so large test documents need a larger page.
// outline: optional bookmarks [{ title, page, children }]
export function buildPdf(streams, { width = 595, height = 842, outline = [] } = {}) {
  const pageIds = streams.map((_, i) => 4 + i * 2);
  const outlineId = 4 + streams.length * 2;
  const objects = [
    outline.length
      ? `<< /Type /Catalog /Pages 2 0 R /Outlines ${outlineId} 0 R >>`
      : '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${streams.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [i, stream] of streams.entries()) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
    );
  }
  if (outline.length) objects.push(...outlineObjects(outline, outlineId, pageIds));

  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const offset = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// Tests import the builder; the fixture files are only written when the script is run
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = new URL('./', import.meta.url);
  fs.writeFileSync(new URL('sample.pdf', dir), buildPdf(SAMPLE_PAGES.map(textStream)));
  fs.writeFileSync(new URL('no-text.pdf', dir), buildPdf(['0.5 g 72 72 451 698 re f']));
}
