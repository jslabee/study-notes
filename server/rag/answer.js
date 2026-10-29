import { chat as llmChat, resolveLlm } from '../llm.js';
import { withPositions } from './passage.js';
import { searchChunks } from './search.js';

// Prompt is copied verbatim from docs/spec.md ("Iskanje (RAG)")
export const ANSWER_SYSTEM_PROMPT = `You answer questions about learning materials. Use only the excerpts below. Cite the source of every statement in square brackets, e.g. [2]. If the excerpts do not contain the answer, reply exactly: "I could not find the answer in the materials." Answer concisely.`;

export const NOT_FOUND_ANSWER = 'I could not find the answer in the materials.';
const MAX_OUTPUT_TOKENS = 4000;

export function answerMessage(question, chunks) {
  const excerpts = chunks
    .map((chunk, i) => `[${i + 1}] (${chunk.title}) ${chunk.text}`)
    .join('\n');
  return `Excerpts:\n${excerpts}\n\nQuestion: ${question}`;
}

// Answers a question from the most similar chunks with the requested provider and model;
// chat, resolve and embed are replaceable for tests
export async function answerQuestion(
  question,
  { courseId, materialIds, provider, model, chat = llmChat, resolve = resolveLlm, embed } = {}
) {
  const chunks = await searchChunks(question, { courseId, materialIds, embed });

  // start and end (offsets in the material text) and page (PDFs) let the source viewer open
  // at the cited passage
  const sources = withPositions(chunks).map((chunk, i) => ({
    n: i + 1,
    materialId: chunk.materialId,
    title: chunk.title,
    chunkId: chunk.chunkId,
    text: chunk.text,
    start: chunk.start,
    end: chunk.end,
    page: chunk.page,
  }));

  // Without any excerpts there is nothing to answer from, so no model is called
  if (chunks.length === 0) {
    return { answer: NOT_FOUND_ANSWER, sources, provider: null, model: null };
  }

  const user = answerMessage(question, chunks);
  const llm = await resolve({ provider, model, textLength: ANSWER_SYSTEM_PROMPT.length + user.length });
  const reply = await chat({
    ...llm,
    system: ANSWER_SYSTEM_PROMPT,
    user,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  return { answer: reply.text.trim(), sources, provider: reply.provider, model: reply.model };
}
