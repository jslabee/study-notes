import OpenAI from 'openai';

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
// Rate limits back off longer (5, 10, 20 s) unless the response says when to retry; a wait
// longer than MAX_RETRY_DELAY_MS is not worth it, so the error is reported instead
const RATE_LIMIT_BASE_MS = 5000;
const MAX_RETRY_DELAY_MS = 60000;

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
    openaiMaxOutputTokens: positiveInt('OPENAI_MAX_OUTPUT_TOKENS', 16000),
    openaiReasoningEffort: process.env.OPENAI_REASONING_EFFORT?.trim() || '',
    // Time limits of one model call; local models can be slow, so theirs is separate and longer
    openaiTimeoutMs: positiveInt('OPENAI_TIMEOUT_MS', 300000),
    localChatTimeoutMs: positiveInt('LOCAL_CHAT_TIMEOUT_MS', 900000),
  };
}

// A model or embedding call that did not finish within its time limit; it is not retried,
// because the limit is already long and a retry would only multiply the wait
export class LlmTimeoutError extends LlmError {
  constructor(message) {
    super(504, message);
  }
}

const seconds = (ms) => Math.round(ms / 1000);
const openaiTimeoutMessage = (ms) =>
  `OpenAI did not respond within ${seconds(ms)} s. Try again later, or increase OPENAI_TIMEOUT_MS.`;
const localTimeoutMessage = (ms) =>
  `The local model did not respond within ${seconds(ms)} s. Use a smaller model, or increase LOCAL_CHAT_TIMEOUT_MS.`;
const embedTimeoutMessage = (ms) =>
  `The embedding service (Ollama) did not respond within ${seconds(ms)} s. Check that Ollama is running, or increase EMBED_TIMEOUT_MS.`;

const OUTPUT_TOKENS_CAP = 32000;
export const OUTPUT_TOO_LONG_ERROR =
  'The model response was too long. Try another style or model, or increase OPENAI_MAX_OUTPUT_TOKENS.';

export const LOCAL_OUTPUT_TOO_LONG_ERROR =
  "The local model's response was too long. Try another style or model, or increase LOCAL_MAX_OUTPUT_TOKENS.";

// The response did not fit the output limit (for OpenAI even after a retry with a higher
// limit); callers can split or shorten the input
export class OutputLimitError extends LlmError {
  constructor(message = OUTPUT_TOO_LONG_ERROR) {
    super(422, message);
  }
}

// The model answered with no text
export class EmptyResponseError extends Error {
  constructor() {
    super('The model returned an empty response.');
  }
}

export const LOCAL_CONTEXT_ERROR =
  "The material is too large for the local model's context. Use Auto or OpenAI, or increase LOCAL_CONTEXT_TOKENS and OLLAMA_CONTEXT_LENGTH.";
const CONTEXT_SAFETY_MARGIN = 0.1;

// Characters per token for the estimate: 3 at first (conservative), lowered when Ollama reports
// that a prompt had more tokens than that; it is never raised again
const INITIAL_CHARS_PER_TOKEN = 3;
let charsPerToken = INITIAL_CHARS_PER_TOKEN;

export const tokenRatio = () => charsPerToken;

// Starts again from 3 characters per token (used by tests)
export function resetTokenRatio() {
  charsPerToken = INITIAL_CHARS_PER_TOKEN;
}

// Keeps the most conservative ratio seen: chars sent / prompt tokens reported by Ollama. Only
// prompts of at least 1/16 of the context count: in short ones the chat template's own tokens
// would make the ratio far too low
function updateTokenRatio(chars, promptTokens, contextTokens) {
  if (!(chars > 0) || !(promptTokens >= contextTokens / 16)) return;
  charsPerToken = Math.min(charsPerToken, chars / promptTokens);
}

export const estimateTokens = (text) => Math.ceil(text.length / charsPerToken);

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

// Node's fetch waits at most 300 s for the response headers; the SDK then reports a timeout that
// mentions them. Ollama sends the headers of a streamed reply with its first chunk.
const NODE_HEADERS_TIMEOUT_MS = 300000;
const waitedForHeaders = (err) => /response headers/i.test(err.message);

// Rate limits, connection problems and server errors are worth retrying; timeouts are not (see
// LlmTimeoutError)
function isTransient(err) {
  if (err instanceof OpenAI.APIConnectionTimeoutError) return false;
  if (err instanceof OpenAI.APIConnectionError) return true;
  if (!(err instanceof OpenAI.APIError)) return false;
  if (err.status === 429) return err.code !== 'insufficient_quota';
  return err.status === 408 || err.status === 409 || err.status >= 500;
}

function readableOpenaiError(err, model, timeoutMs) {
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    // Node's fetch gives up waiting for the response headers after 300 s, even with a longer limit
    const waited = waitedForHeaders(err) ? Math.min(timeoutMs, NODE_HEADERS_TIMEOUT_MS) : timeoutMs;
    return new LlmTimeoutError(openaiTimeoutMessage(waited));
  }
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

// Errors saying that the request does not fit the model's context, as Ollama (and OpenAI-style
// servers) word them, e.g. "the input length exceeds the context length", "prompt too long;
// exceeded max context length", "context_length_exceeded"; other errors that mention tokens
// (e.g. "invalid token") are not context errors
const CONTEXT_ERROR =
  /context[ _](length|window|size)|context_length_exceeded|exceeds? (the )?(max(imum)? )?context|prompt (is )?too long|too many tokens/i;
export const isContextError = (err) => err instanceof OpenAI.APIError && CONTEXT_ERROR.test(err.message);

// A streamed reply that stopped without a finish reason (the connection was closed); retried
const LOCAL_REPLY_ENDED_ERROR = "The local model's reply ended before it was complete.";
const LOCAL_FIRST_CHUNK_TIMEOUT_ERROR =
  'The local model did not start answering within 300 s (the limit of Node.js). Use a smaller model or a smaller LOCAL_PART_CHARS.';

function readableLocalError(err, model, timeoutMs) {
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new LlmTimeoutError(waitedForHeaders(err) ? LOCAL_FIRST_CHUNK_TIMEOUT_ERROR : localTimeoutMessage(timeoutMs));
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new Error(err.message === LOCAL_REPLY_ENDED_ERROR ? err.message : OLLAMA_UNREACHABLE_ERROR);
  }
  if (!(err instanceof OpenAI.APIError)) return err;
  if (isContextError(err)) return new LlmError(422, LOCAL_CONTEXT_ERROR);
  if (err.status === 404) return new Error(`Model "${model}" is not installed in Ollama.`);
  return new Error(`Local model request failed: ${err.message}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Base delays of withRetries; tests shorten them with setRetryDelays
const DEFAULT_RETRY_DELAYS = { baseMs: RETRY_BASE_MS, rateLimitMs: RATE_LIMIT_BASE_MS };
let retryDelays = { ...DEFAULT_RETRY_DELAYS };

// Sets the base delays ({ baseMs, rateLimitMs }); without an argument restores the defaults (used
// by tests)
export function setRetryDelays(delays = DEFAULT_RETRY_DELAYS) {
  retryDelays = { ...DEFAULT_RETRY_DELAYS, ...delays };
}

function header(headers, name) {
  if (!headers) return null;
  return typeof headers.get === 'function' ? headers.get(name) : (headers[name] ?? null);
}

// The wait a response asks for: retry-after-ms (milliseconds) or retry-after (seconds or an HTTP
// date); null when there is none
export function retryAfterMs(headers) {
  const ms = Number.parseFloat(header(headers, 'retry-after-ms'));
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const value = header(headers, 'retry-after');
  if (value === null || value === undefined || value === '') return null;
  const secondsValue = Number(value);
  if (Number.isFinite(secondsValue) && secondsValue >= 0) return secondsValue * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

// The delay before retry number attempt + 1, or null when waiting is not worth it. A rate limit
// (429) waits as long as Retry-After asks, otherwise rateLimitDelayMs doubled per attempt; other
// errors wait baseDelayMs doubled per attempt.
export function retryDelayMs(
  err,
  attempt,
  { baseDelayMs = retryDelays.baseMs, rateLimitDelayMs = retryDelays.rateLimitMs } = {}
) {
  if (err?.status !== 429) return baseDelayMs * 2 ** attempt;
  const delay = retryAfterMs(err.headers) ?? rateLimitDelayMs * 2 ** attempt;
  return delay <= MAX_RETRY_DELAY_MS ? delay : null;
}

// Runs fn, retrying up to MAX_RETRIES times with a growing delay on transient errors
export async function withRetries(
  fn,
  { retries = MAX_RETRIES, baseDelayMs, rateLimitDelayMs, retryable = isTransient } = {}
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !retryable(err)) throw err;
      const delay = retryDelayMs(err, attempt, { baseDelayMs, rateLimitDelayMs });
      if (delay === null) throw err;
      await sleep(delay);
    }
  }
}

// Token usage of every call goes to the server console, to help diagnose limits
function logUsage(provider, model, { input, output, reasoning }, note = '') {
  const parts = [`input ${input ?? '?'}`, `output ${output ?? '?'}`];
  if (reasoning !== undefined) parts.push(`reasoning ${reasoning}`);
  console.log(`[llm] ${provider} ${model}: ${parts.join(', ')} tokens${note ? ` (${note})` : ''}`);
}

async function openaiRequest(openai, { model, system, user, maxOutputTokens, reasoningEffort, timeoutMs }) {
  let response;
  try {
    response = await withRetries(() =>
      openai.responses.create(
        {
          model,
          instructions: system,
          input: user,
          max_output_tokens: maxOutputTokens,
          ...(reasoningEffort && { reasoning: { effort: reasoningEffort } }),
        },
        { timeout: timeoutMs }
      )
    );
  } catch (err) {
    throw readableOpenaiError(err, model, timeoutMs);
  }

  const usage = response.usage;
  const cutOff =
    response.status === 'incomplete' &&
    response.incomplete_details?.reason === 'max_output_tokens';
  logUsage(
    'openai',
    model,
    {
      input: usage?.input_tokens,
      output: usage?.output_tokens,
      reasoning: usage?.output_tokens_details?.reasoning_tokens,
    },
    `limit ${maxOutputTokens}${cutOff ? ', incomplete' : ''}`
  );
  return { response, cutOff };
}

// OpenAI calls use OPENAI_MAX_OUTPUT_TOKENS (and OPENAI_REASONING_EFFORT when set). A response cut
// off by the output limit is retried once with double the limit (at most 32000); if it is still
// cut off, OutputLimitError is thrown, so truncated text is never returned
async function openaiChat({ model, system, user }) {
  const openai = getOpenaiClient();
  const { openaiMaxOutputTokens, openaiReasoningEffort, openaiTimeoutMs } = llmConfig();
  const request = { model, system, user, reasoningEffort: openaiReasoningEffort, timeoutMs: openaiTimeoutMs };

  let { response, cutOff } = await openaiRequest(openai, {
    ...request,
    maxOutputTokens: openaiMaxOutputTokens,
  });
  const higherLimit = Math.min(openaiMaxOutputTokens * 2, OUTPUT_TOKENS_CAP);
  if (cutOff && higherLimit > openaiMaxOutputTokens) {
    ({ response, cutOff } = await openaiRequest(openai, { ...request, maxOutputTokens: higherLimit }));
  }
  if (cutOff) throw new OutputLimitError();

  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason || 'unknown reason';
    throw new Error(`The model response was incomplete (${reason}).`);
  }
  return response.output_text;
}

// Local calls always use LOCAL_MAX_OUTPUT_TOKENS, and a request that does not fit
// LOCAL_CONTEXT_TOKENS is not sent (callers split the text so that it fits). Every call logs the
// estimated and reported prompt tokens, so the estimate can be compared with the real count.
async function localChat({ model, system, user, purpose }) {
  const { localMaxOutputTokens, localContextTokens, localChatTimeoutMs } = llmConfig();
  const estimated = estimateTokens(system) + estimateTokens(user);
  const fits = fitsLocalContext(system, user);
  const logCall = (fields) =>
    console.log(
      `[llm] local ${model}${purpose ? ` ${purpose}` : ''}: ` +
        `estimated input ${estimated} tokens (${charsPerToken.toFixed(2)} chars/token), ${fields}, ` +
        `max output ${localMaxOutputTokens}, LOCAL_CONTEXT_TOKENS ${localContextTokens}`
    );
  if (!fits) {
    logCall('not sent');
    throw new LlmError(422, LOCAL_CONTEXT_ERROR);
  }

  const ollama = getLocalClient();
  const request = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: localMaxOutputTokens,
  };
  let reply;
  try {
    reply = await withRetries(() => streamLocalChat(ollama, request, localChatTimeoutMs), {
      retryable: (err) => !isContextError(err) && isTransient(err),
    });
  } catch (err) {
    throw readableLocalError(err, model, localChatTimeoutMs);
  }

  const promptTokens = reply.usage?.prompt_tokens;
  const outputTokens = reply.usage?.completion_tokens;
  logCall(
    `reported prompt ${promptTokens ?? '?'}, output ${outputTokens ?? '?'} tokens, ` +
      `finish ${reply.finishReason}`
  );
  updateTokenRatio(system.length + user.length, promptTokens, localContextTokens);

  // "length" means the reply was cut off: by the output limit when it used all of it,
  // otherwise because Ollama's own context (OLLAMA_CONTEXT_LENGTH) ran out
  if (reply.finishReason === 'length') {
    if (outputTokens === undefined || outputTokens >= localMaxOutputTokens) {
      throw new OutputLimitError(LOCAL_OUTPUT_TOO_LONG_ERROR);
    }
    throw new LlmError(422, LOCAL_CONTEXT_ERROR);
  }
  return reply.content;
}

// One local chat request with the reply streamed: Ollama sends the response headers of a reply
// that is not streamed only when the whole reply is written, and Node's fetch stops waiting for
// headers after 300 s, so a slower reply could never arrive. timeoutMs (LOCAL_CHAT_TIMEOUT_MS)
// covers the whole call, until the last chunk. Returns { content, finishReason, usage }.
async function streamLocalChat(ollama, request, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  let content = '';
  let finishReason = null;
  let usage = null;
  try {
    const stream = await ollama.chat.completions.create(
      { ...request, stream: true, stream_options: { include_usage: true } },
      { signal, timeout: timeoutMs }
    );
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) content += choice.delta.content;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }
  } catch (err) {
    if (signal.aborted) throw new OpenAI.APIConnectionTimeoutError();
    throw err;
  }
  // An abort while the reply is streamed ends the stream without an error
  if (signal.aborted) throw new OpenAI.APIConnectionTimeoutError();
  if (!finishReason) {
    throw new OpenAI.APIConnectionError({ message: LOCAL_REPLY_ENDED_ERROR });
  }
  return { content, finishReason, usage };
}

// Sends a system instruction and a user message to the resolved provider and model;
// returns the text reply and the provider and model that produced it. purpose (e.g. "merge of
// 4 notes") only goes into the log.
export async function chat({ provider, model, system, user, maxOutputTokens, purpose }) {
  if (provider !== 'local' && provider !== 'openai') {
    throw new Error(`Unknown provider "${provider}".`);
  }
  const text =
    provider === 'local'
      ? await localChat({ model, system, user, purpose })
      : await openaiChat({ model, system, user, maxOutputTokens });
  if (!text?.trim()) throw new EmptyResponseError();
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
  return {
    url: url.replace(/\/+$/, ''),
    model,
    dim,
    timeoutMs: positiveInt('EMBED_TIMEOUT_MS', 60000),
  };
}

// A failed embedding request; transient ones (no connection, a server error from Ollama) are
// retried
class EmbedRequestError extends Error {
  constructor(message, transient) {
    super(message);
    this.transient = transient;
  }
}

const isTimeout = (err) => err?.name === 'TimeoutError';

// One embedding request for a batch of texts; returns the embeddings from Ollama's reply
async function embedBatch({ url, model, timeoutMs }, batch) {
  // The time limit covers the whole request, including reading the reply
  const signal = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(`${url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: batch }),
      signal,
    });
  } catch (err) {
    if (isTimeout(err)) throw new LlmTimeoutError(embedTimeoutMessage(timeoutMs));
    throw new EmbedRequestError(EMBEDDING_UNREACHABLE_ERROR, true);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new EmbedRequestError(
      `Embedding request failed: ${body?.error || `status ${res.status}`}.`,
      res.status >= 500
    );
  }

  try {
    return (await res.json()).embeddings;
  } catch (err) {
    if (isTimeout(err) || signal.aborted) throw new LlmTimeoutError(embedTimeoutMessage(timeoutMs));
    throw new Error('The embedding service returned an unexpected response.');
  }
}

// Scales a vector to length 1
export function normalize(vector) {
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!length) throw new Error('The embedding model returned a zero vector.');
  return Float32Array.from(vector, (value) => value / length);
}

// Returns one normalized Float32Array per text, using Ollama with at most 32 texts per call.
// Each call has the time limit EMBED_TIMEOUT_MS; a call that fails because Ollama cannot be
// reached or answers with a server error is retried up to three times with a growing delay.
export async function embed(texts) {
  const config = embeddingConfig();
  const { dim } = config;
  const vectors = [];

  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const embeddings = await withRetries(() => embedBatch(config, batch), {
      retryable: (err) => err instanceof EmbedRequestError && err.transient,
    });
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
