import OpenAI from 'openai';

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

let client = null;
let clientKey = null;

function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI API key is missing. Set OPENAI_API_KEY in .env.');
  // Retries are handled here, so the SDK's own retries are turned off
  if (!client || clientKey !== apiKey) {
    client = new OpenAI({ apiKey, maxRetries: 0 });
    clientKey = apiKey;
  }
  return client;
}

export function getModel() {
  const model = process.env.OPENAI_MODEL;
  if (!model) throw new Error('OpenAI model is not set. Set OPENAI_MODEL in .env.');
  return model;
}

// Rate limits, timeouts, connection problems and server errors are worth retrying
function isTransient(err) {
  if (err instanceof OpenAI.APIConnectionError) return true;
  if (!(err instanceof OpenAI.APIError)) return false;
  if (err.status === 429) return err.code !== 'insufficient_quota';
  return err.status === 408 || err.status === 409 || err.status >= 500;
}

function readableError(err, model) {
  if (err instanceof OpenAI.APIConnectionError) return new Error('Could not reach the OpenAI API.');
  if (!(err instanceof OpenAI.APIError)) return err;
  if (err.status === 401) return new Error('OpenAI rejected the API key. Check OPENAI_API_KEY.');
  if (err.status === 404) return new Error(`Model "${model}" is not available. Check OPENAI_MODEL.`);
  if (err.code === 'insufficient_quota') {
    return new Error('OpenAI quota exceeded. Check billing on the OpenAI account.');
  }
  if (err.status === 429) return new Error('OpenAI rate limit reached. Try again later.');
  return new Error(`OpenAI request failed: ${err.message}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs fn, retrying up to MAX_RETRIES times with a growing delay on transient errors
export async function withRetries(fn, { retries = MAX_RETRIES, baseDelayMs = RETRY_BASE_MS } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isTransient(err)) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
}

// Sends a system instruction and a user message to OpenAI and returns the text reply
export async function complete({ system, user, maxOutputTokens }) {
  const openai = getClient();
  const model = getModel();

  let response;
  try {
    response = await withRetries(() =>
      openai.responses.create({
        model,
        instructions: system,
        input: user,
        max_output_tokens: maxOutputTokens,
      })
    );
  } catch (err) {
    throw readableError(err, model);
  }

  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason || 'unknown reason';
    throw new Error(`The model response was incomplete (${reason}).`);
  }
  if (!response.output_text?.trim()) throw new Error('The model returned an empty response.');
  return response.output_text;
}

const EMBED_BATCH_SIZE = 32;
export const EMBEDDING_UNREACHABLE_ERROR = 'Embedding service (Ollama) is not reachable.';

function embeddingConfig() {
  const url = process.env.OLLAMA_URL;
  const model = process.env.EMBED_MODEL;
  const dim = Number(process.env.EMBED_DIM);
  if (!url) throw new Error('Ollama URL is not set. Set OLLAMA_URL in .env.');
  if (!model) throw new Error('Embedding model is not set. Set EMBED_MODEL in .env.');
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error('Embedding size is not set. Set EMBED_DIM in .env.');
  }
  return { url: url.replace(/\/+$/, ''), model, dim };
}

// Scales a vector to length 1
export function normalize(vector) {
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!length) throw new Error('The embedding model returned a zero vector.');
  return Float32Array.from(vector, (value) => value / length);
}

// Returns one normalized Float32Array per text, using Ollama with at most 32 texts per call
export async function embed(texts) {
  const { url, model, dim } = embeddingConfig();
  const vectors = [];

  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);

    let res;
    try {
      res = await fetch(`${url}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: batch }),
      });
    } catch {
      throw new Error(EMBEDDING_UNREACHABLE_ERROR);
    }

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(`Embedding request failed: ${body?.error || `status ${res.status}`}.`);
    }

    const { embeddings } = await res.json();
    if (!Array.isArray(embeddings) || embeddings.length !== batch.length) {
      throw new Error('The embedding service returned an unexpected response.');
    }
    for (const vector of embeddings) {
      if (vector.length !== dim) {
        throw new Error(`Embedding has ${vector.length} values, but EMBED_DIM is ${dim}.`);
      }
      vectors.push(normalize(vector));
    }
  }
  return vectors;
}
