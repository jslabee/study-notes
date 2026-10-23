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
