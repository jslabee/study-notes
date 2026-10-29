import OpenAI from 'openai';

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

export const PROVIDERS = ['auto', 'local', 'openai'];
const LOCAL_MODELS_TTL_MS = 30000;
const OLLAMA_TIMEOUT_MS = 5000;

// Errors with an HTTP status that the API returns to the client as they are
export class LlmError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

function positiveInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function llmConfig() {
  const defaultProvider = process.env.DEFAULT_PROVIDER || 'auto';
  if (!PROVIDERS.includes(defaultProvider)) {
    throw new LlmError(500, 'DEFAULT_PROVIDER must be auto, local or openai.');
  }
  return {
    defaultProvider,
    allowExternal: process.env.ALLOW_EXTERNAL?.trim().toLowerCase() !== 'false',
    localModel: process.env.LOCAL_LLM_MODEL || '',
    openaiModel: process.env.OPENAI_MODEL || '',
    localMaxChars: positiveInt('LOCAL_MAX_CHARS', 60000),
    localPartChars: positiveInt('LOCAL_PART_CHARS', 15000),
    localContextTokens: positiveInt('LOCAL_CONTEXT_TOKENS', 16384),
    localMaxOutputTokens: positiveInt('LOCAL_MAX_OUTPUT_TOKENS', 2048),
  };
}

export const LOCAL_CONTEXT_ERROR =
  "The material is too large for the local model's context. Use Auto or OpenAI, or increase LOCAL_CONTEXT_TOKENS and OLLAMA_CONTEXT_LENGTH.";
const CONTEXT_SAFETY_MARGIN = 0.1;

// A rough token count: about four characters per token
export const estimateTokens = (text) => Math.ceil(text.length / 4);

// Whether a local request fits LOCAL_CONTEXT_TOKENS: the estimated input (system prompt and user
// message) plus LOCAL_MAX_OUTPUT_TOKENS, with a 10% safety margin
export function fitsLocalContext(system, user) {
  const { localContextTokens, localMaxOutputTokens } = llmConfig();
  const tokens = estimateTokens(system) + estimateTokens(user) + localMaxOutputTokens;
  return tokens * (1 + CONTEXT_SAFETY_MARGIN) <= localContextTokens;
}

// OPENAI_MODELS, or only OPENAI_MODEL when the list is empty; the default is always allowed
export function openaiModels() {
  const { openaiModel } = llmConfig();
  const models = (process.env.OPENAI_MODELS || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (openaiModel && !models.includes(openaiModel)) models.unshift(openaiModel);
  return [...new Set(models)];
}

function ollamaUrl() {
  const url = process.env.OLLAMA_URL;
  return url ? url.replace(/\/+$/, '') : null;
}

// Ollama treats "name" and "name:latest" as the same model
const withoutLatest = (name) => name.replace(/:latest$/, '');
export const sameModel = (a, b) => withoutLatest(a) === withoutLatest(b);

// A model is offered for chat when /api/show lists "completion"; without a capabilities field
// (older Ollama) it is offered as well
async function canChat(url, name) {
  try {
    const res = await fetch(`${url}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name }),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
    if (!res.ok) return true;
    const { capabilities } = await res.json();
    return !Array.isArray(capabilities) || capabilities.includes('completion');
  } catch {
    return true;
  }
}

async function fetchLocalModels() {
  const url = ollamaUrl();
  if (!url) return { reachable: false, models: [] };

  let tags;
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS) });
    if (!res.ok) return { reachable: false, models: [] };
    tags = await res.json();
  } catch {
    return { reachable: false, models: [] };
  }

  const embedModel = process.env.EMBED_MODEL;
  const candidates = (tags.models ?? []).filter(
    (model) => !(embedModel && sameModel(model.name, embedModel))
  );
  const chatModels = await Promise.all(
    candidates.map(async (model) =>
      (await canChat(url, model.name)) ? { name: model.name, size: model.size } : null
    )
  );
  return { reachable: true, models: chatModels.filter(Boolean) };
}

let localCache = null;

// Installed local chat models, cached for 30 seconds; refresh bypasses the cache
export async function listLocalModels({ refresh = false } = {}) {
  if (!refresh && localCache && Date.now() - localCache.at < LOCAL_MODELS_TTL_MS) {
    return localCache.value;
  }
  const value = await fetchLocalModels();
  localCache = { at: Date.now(), value };
  return value;
}

// Forgets the cached list (used by tests)
export function clearLocalModelCache() {
  localCache = null;
}

// Everything the client needs to offer providers and models
export async function getLlmModels({ refresh = false } = {}) {
  const config = llmConfig();
  return {
    default: {
      provider: config.defaultProvider,
      localModel: config.localModel,
      openaiModel: config.openaiModel,
    },
    allowExternal: config.allowExternal,
    local: await listLocalModels({ refresh }),
    openai: { configured: Boolean(process.env.OPENAI_API_KEY), models: openaiModels() },
  };
}

const EXTERNAL_DISABLED_ERROR = 'The external provider (OpenAI) is disabled by ALLOW_EXTERNAL.';
const OLLAMA_UNREACHABLE_ERROR = 'The local model service (Ollama) is not reachable.';

function resolveOpenai(model, config) {
  if (!config.allowExternal) throw new LlmError(403, EXTERNAL_DISABLED_ERROR);
  if (model) {
    if (!openaiModels().includes(model)) {
      throw new LlmError(400, `Model "${model}" is not an allowed OpenAI model.`);
    }
    return { provider: 'openai', model };
  }
  if (!config.openaiModel) {
    throw new LlmError(500, 'OpenAI model is not set. Set OPENAI_MODEL in .env.');
  }
  return { provider: 'openai', model: config.openaiModel };
}

// The installed name of the requested (or default) local model, or an error explaining why not
function findLocalModel(model, config, local) {
  if (!local.reachable) return { error: new LlmError(503, OLLAMA_UNREACHABLE_ERROR) };
  const wanted = model || config.localModel;
  if (!wanted) {
    return { error: new LlmError(500, 'Local model is not set. Set LOCAL_LLM_MODEL in .env.') };
  }
  const installed = local.models.find((m) => sameModel(m.name, wanted));
  if (installed) return { name: installed.name };
  if (model) {
    return { error: new LlmError(400, `Model "${model}" is not an installed local chat model.`) };
  }
  return {
    error: new LlmError(
      503,
      `The local model "${wanted}" is not installed in Ollama. Run "ollama pull ${wanted}" or change LOCAL_LLM_MODEL.`
    ),
  };
}

// Picks the provider and model for a request:
// - local never falls back to OpenAI;
// - openai is refused when ALLOW_EXTERNAL is false;
// - auto uses the local model for texts of at most LOCAL_MAX_CHARS when Ollama is reachable and
//   the model is installed, otherwise OpenAI (or an error when OpenAI is not allowed). With auto,
//   a given model is the local model; OpenAI then uses OPENAI_MODEL.
export async function resolveLlm({ provider, model, textLength = 0 } = {}) {
  const config = llmConfig();
  const requested = provider || config.defaultProvider;
  if (!PROVIDERS.includes(requested)) {
    throw new LlmError(400, 'provider must be auto, local or openai.');
  }

  if (requested === 'openai') return resolveOpenai(model, config);

  if (requested === 'local') {
    const local = findLocalModel(model, config, await listLocalModels());
    if (local.error) throw local.error;
    return { provider: 'local', model: local.name };
  }

  const fits = textLength <= config.localMaxChars;
  let local = null;
  if (fits || model) {
    local = findLocalModel(model, config, await listLocalModels());
    // A model that was asked for by name must exist, even when the text is too long for it
    if (model && local.error?.status === 400) throw local.error;
    if (fits && !local.error) return { provider: 'local', model: local.name };
  }

  if (!config.allowExternal) {
    if (!fits) {
      throw new LlmError(
        422,
        `The text has ${textLength} characters, more than LOCAL_MAX_CHARS (${config.localMaxChars}), and the external provider is disabled.`
      );
    }
    throw local.error;
  }
  return resolveOpenai(undefined, config);
}

let openaiClient = null;
let openaiClientKey = null;

function getOpenaiClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI API key is missing. Set OPENAI_API_KEY in .env.');
  // Retries are handled here, so the SDK's own retries are turned off
  if (!openaiClient || openaiClientKey !== apiKey) {
    openaiClient = new OpenAI({ apiKey, maxRetries: 0 });
    openaiClientKey = apiKey;
  }
  return openaiClient;
}

let localClient = null;
let localClientUrl = null;

// Ollama's OpenAI-compatible endpoint, used through the same openai package
function getLocalClient() {
  const url = ollamaUrl();
  if (!url) throw new Error('Ollama URL is not set. Set OLLAMA_URL in .env.');
  if (!localClient || localClientUrl !== url) {
    // Ollama ignores the key, but the SDK requires one
    localClient = new OpenAI({ baseURL: `${url}/v1`, apiKey: 'ollama', maxRetries: 0 });
    localClientUrl = url;
  }
  return localClient;
}

// Rate limits, timeouts, connection problems and server errors are worth retrying
function isTransient(err) {
  if (err instanceof OpenAI.APIConnectionError) return true;
  if (!(err instanceof OpenAI.APIError)) return false;
  if (err.status === 429) return err.code !== 'insufficient_quota';
  return err.status === 408 || err.status === 409 || err.status >= 500;
}

function readableOpenaiError(err, model) {
  if (err instanceof OpenAI.APIConnectionError) return new Error('Could not reach the OpenAI API.');
  if (!(err instanceof OpenAI.APIError)) return err;
  if (err.status === 401) return new Error('OpenAI rejected the API key. Check OPENAI_API_KEY.');
  if (err.status === 404) return new Error(`Model "${model}" is not available on OpenAI.`);
  if (err.code === 'insufficient_quota') {
    return new Error('OpenAI quota exceeded. Check billing on the OpenAI account.');
  }
  if (err.status === 429) return new Error('OpenAI rate limit reached. Try again later.');
  return new Error(`OpenAI request failed: ${err.message}`);
}

// Ollama's errors when the request does not fit the model's context
const isContextError = (err) => err instanceof OpenAI.APIError && /context|token/i.test(err.message);

function readableLocalError(err, model) {
  if (err instanceof OpenAI.APIConnectionError) return new Error(OLLAMA_UNREACHABLE_ERROR);
  if (!(err instanceof OpenAI.APIError)) return err;
  if (isContextError(err)) return new LlmError(422, LOCAL_CONTEXT_ERROR);
  if (err.status === 404) return new Error(`Model "${model}" is not installed in Ollama.`);
  return new Error(`Local model request failed: ${err.message}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs fn, retrying up to MAX_RETRIES times with a growing delay on transient errors
export async function withRetries(
  fn,
  { retries = MAX_RETRIES, baseDelayMs = RETRY_BASE_MS, retryable = isTransient } = {}
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !retryable(err)) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
}

async function openaiChat({ model, system, user, maxOutputTokens }) {
  const openai = getOpenaiClient();
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
    throw readableOpenaiError(err, model);
  }

  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason || 'unknown reason';
    throw new Error(`The model response was incomplete (${reason}).`);
  }
  return response.output_text;
}

// Local calls always use LOCAL_MAX_OUTPUT_TOKENS, and a request that does not fit
// LOCAL_CONTEXT_TOKENS is not sent (callers split the text so that it fits)
async function localChat({ model, system, user }) {
  const { localMaxOutputTokens } = llmConfig();
  if (!fitsLocalContext(system, user)) throw new LlmError(422, LOCAL_CONTEXT_ERROR);

  const ollama = getLocalClient();
  let response;
  try {
    response = await withRetries(
      () =>
        ollama.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_tokens: localMaxOutputTokens,
        }),
      { retryable: (err) => !isContextError(err) && isTransient(err) }
    );
  } catch (err) {
    throw readableLocalError(err, model);
  }

  // Ollama also stops here when its own context (OLLAMA_CONTEXT_LENGTH) runs out
  const choice = response.choices?.[0];
  if (choice?.finish_reason === 'length') throw new LlmError(422, LOCAL_CONTEXT_ERROR);
  return choice?.message?.content;
}

// Sends a system instruction and a user message to the resolved provider and model;
// returns the text reply and the provider and model that produced it
export async function chat({ provider, model, system, user, maxOutputTokens }) {
  if (provider !== 'local' && provider !== 'openai') {
    throw new Error(`Unknown provider "${provider}".`);
  }
  const text =
    provider === 'local'
      ? await localChat({ model, system, user, maxOutputTokens })
      : await openaiChat({ model, system, user, maxOutputTokens });
  if (!text?.trim()) throw new Error('The model returned an empty response.');
  return { text, provider, model };
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
