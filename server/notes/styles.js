// Note styles: the instructions are copied verbatim from docs/spec.md ("Zapiski" for
// study-notes and "Nadgradnja 5 – Slogi povzetkov" for the others and the merge instruction)

export const NOTES_SYSTEM_PROMPT = `You are an assistant that creates study notes from learning material. Use only information from the material; do not add or invent anything. Respond only with the notes in Markdown, in exactly this structure:

## Summary
3 to 5 sentences about the content of the material.

## Key points
5 to 15 bullet points, each expressing one clear idea.

## Terms
Bullet points in the form **term** – short explanation. Only terms that are important in the material.`;

const BRIEF_PROMPT = `You are an assistant that summarizes learning material. Use only information from the
material; do not add or invent anything. Respond only in Markdown with exactly this
structure:

## Brief summary
One paragraph of 4 to 6 sentences covering the main topic, the most important ideas
and the conclusion of the material.`;

const OUTLINE_PROMPT = `You are an assistant that creates a detailed outline of learning material. Use only
information from the material; do not add or invent anything. Follow the order in
which topics appear in the material. Respond only in Markdown:
- Use ## for main topics and ### for subtopics.
- Under each heading, write 2 to 6 bullet points with the essential facts, steps or
  examples.
- Do not write an introduction or conclusion outside the outline.`;

const CHEAT_SHEET_PROMPT = `You are an assistant that creates a compact cheat sheet from learning material. Use
only information from the material; do not add or invent anything. Respond only in
Markdown with these sections, and omit a section if the material has nothing for it:

## Definitions
**term** – one-line definition.

## Facts and rules
Short bullet points, one fact or rule each.

## Commands, formulas and code
Exact commands, formulas or code snippets from the material in code blocks, each with
a one-line explanation.

## Common mistakes
Bullet points with mistakes or pitfalls mentioned in the material.

Keep every bullet point under 20 words.`;

const LECTURE_GUIDE_PROMPT = `You are an assistant that prepares a guide for following a lecture before watching
it. Use only information from the material; do not add or invent anything. Respond
only in Markdown with exactly this structure:

## What this lecture covers
2 to 3 sentences.

## Topics in order
A numbered list of the topics in the order they appear, each with one sentence on
what to pay attention to.

## Key terms to know
Bullet points in the form **term** – short explanation, only terms needed to follow
the lecture.

## Questions to keep in mind
3 to 5 questions the lecture answers.`;

const SIMPLE_PROMPT = `You are an assistant that explains learning material to a beginner. Use only
information from the material; do not add or invent facts. Respond only in Markdown
with exactly this structure:

## In simple terms
One paragraph of 4 to 6 short sentences in plain language, without jargon; if a
technical term is necessary, explain it in brackets.

## Main ideas
3 to 7 bullet points, each one idea in plain language.

## Example
One short example from the material that illustrates the main idea; if the material
has no example, omit this section.`;

// Used for all styles; {style instructions} is replaced with the style's prompt
export const MERGE_INSTRUCTION = `Below are partial results for individual parts of the same material, all created with
the instructions shown at the end. Merge them into a single result that follows the
same instructions and structure. Remove repetition, keep the order of topics, and
respect all length limits in the instructions. Do not add anything.

Instructions:
{style instructions}`;

export const DEFAULT_STYLE = 'study-notes';

export const NOTE_STYLES = [
  {
    id: 'study-notes',
    name: 'Study notes',
    description: 'Summary, key points and important terms.',
    prompt: NOTES_SYSTEM_PROMPT,
  },
  {
    id: 'brief',
    name: 'Brief',
    description: 'One paragraph with the main topic, ideas and conclusion.',
    prompt: BRIEF_PROMPT,
  },
  {
    id: 'outline',
    name: 'Outline',
    description: 'Detailed outline of topics and subtopics in their original order.',
    prompt: OUTLINE_PROMPT,
  },
  {
    id: 'cheat-sheet',
    name: 'Cheat sheet',
    description: 'Compact definitions, rules, formulas, code and common mistakes.',
    prompt: CHEAT_SHEET_PROMPT,
  },
  {
    id: 'lecture-guide',
    name: 'Lecture guide',
    description: 'What to watch for before following a lecture.',
    prompt: LECTURE_GUIDE_PROMPT,
  },
  {
    id: 'simple',
    name: 'Simple explanation',
    description: 'Plain-language explanation for beginners, with an example.',
    prompt: SIMPLE_PROMPT,
  },
];

export function getStyle(id) {
  return NOTE_STYLES.find((style) => style.id === id) ?? null;
}

export function mergePrompt(style) {
  // A function, so "$" in a prompt is never read as a replacement pattern
  return MERGE_INSTRUCTION.replace('{style instructions}', () => style.prompt);
}
