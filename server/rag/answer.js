import { complete as llmComplete } from '../llm.js';
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

// Answers a question from the most similar chunks; complete and embed are replaceable for tests
export async function answerQuestion(
  question,
  { courseId, complete = llmComplete, embed } = {}
) {
  const chunks = await searchChunks(question, { courseId, embed });

  const sources = chunks.map((chunk, i) => ({
    n: i + 1,
    materialId: chunk.materialId,
    title: chunk.title,
    chunkId: chunk.chunkId,
    text: chunk.text,
  }));

  // Without any excerpts there is nothing to answer from, so the model is not called
  if (chunks.length === 0) return { answer: NOT_FOUND_ANSWER, sources };

  const answer = await complete({
    system: ANSWER_SYSTEM_PROMPT,
    user: answerMessage(question, chunks),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  return { answer: answer.trim(), sources };
}
