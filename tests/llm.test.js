import { test, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeOllama } from './helpers/fake-ollama.js';
import { installFakeOpenAI } from './helpers/fake-openai.js';

// Ollama and OpenAI are faked, so no model is called
const fake = installFakeOllama();
const fakeOpenAI = installFakeOpenAI({ answer: 'OpenAI answer.' });
const llm = await import('../server/llm.js');

const GEMMA = { name: 'gemma3:4b', size: 3300000000, capabilities: ['completion', 'vision'] };
const QWEN = { name: 'qwen3:8b', size: 5200000000, capabilities: ['completion', 'tools'] };
const BGE = { name: 'bge-m3:latest', size: 1200000000, capabilities: ['embedding'] };
const NOMIC = { name: 'nomic-embed-text:latest', size: 270000000, capabilities: ['embedding'] };
// Older Ollama versions do not report capabilities
const OLD = { name: 'llama2:latest', size: 3800000000 };

const SHORT = 500;
const LONG = 5000;

beforeEach(() => {
  fake.models = [GEMMA, QWEN, BGE];
  fake.unreachable = false;
  fake.calls.length = 0;
  process.env.LOCAL_LLM_MODEL = 'gemma3:4b';
  process.env.LOCAL_MAX_CHARS = '1000';
  process.env.OPENAI_MODEL = 'gpt-5-mini';
  process.env.OPENAI_MODELS = 'gpt-5-mini,gpt-5';
  process.env.ALLOW_EXTERNAL = 'true';
  delete process.env.DEFAULT_PROVIDER;
  llm.clearLocalModelCache();
});

after(() => {
  fakeOpenAI.restore();
  fake.restore();
});

async function rejectsWith(promise, status, pattern) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.status, status);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

test('the local list leaves out the embedding model and models without "completion"', async () => {
  fake.models = [GEMMA, BGE, NOMIC, QWEN, OLD];
  const local = await llm.listLocalModels();
  assert.deepEqual(local, {
    reachable: true,
    models: [
      { name: 'gemma3:4b', size: 3300000000 },
      { name: 'qwen3:8b', size: 5200000000 },
      { name: 'llama2:latest', size: 3800000000 },
    ],
  });
});

test('without a capabilities field only EMBED_MODEL is left out', async () => {
  fake.models = [{ name: 'bge-m3:latest' }, { name: 'nomic-embed-text:latest' }, OLD];
  const names = (await llm.listLocalModels()).models.map((m) => m.name);
  assert.deepEqual(names, ['nomic-embed-text:latest', 'llama2:latest']);
});

test('unreachable Ollama gives an empty, unreachable list', async () => {
  fake.unreachable = true;
  assert.deepEqual(await llm.listLocalModels(), { reachable: false, models: [] });
});

test('the local list is cached for 30 seconds and refresh bypasses the cache', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1000000 });
  try {
    const tagCalls = () => fake.calls.filter((c) => c.url.endsWith('/api/tags')).length;
    assert.equal((await llm.listLocalModels()).models.length, 2);

    fake.models = [GEMMA];
    mock.timers.tick(29000);
    assert.equal((await llm.listLocalModels()).models.length, 2);
    assert.equal(tagCalls(), 1);

    assert.equal((await llm.listLocalModels({ refresh: true })).models.length, 1);
    assert.equal(tagCalls(), 2);

    fake.models = [GEMMA, QWEN];
    mock.timers.tick(30001);
    assert.equal((await llm.listLocalModels()).models.length, 2);
    assert.equal(tagCalls(), 3);
  } finally {
    mock.timers.reset();
  }
});

test('auto uses the local model for a short text', async () => {
  assert.deepEqual(await llm.resolveLlm({ provider: 'auto', textLength: SHORT }), {
    provider: 'local',
    model: 'gemma3:4b',
  });
});

test('auto uses OpenAI for a text longer than LOCAL_MAX_CHARS', async () => {
  assert.deepEqual(await llm.resolveLlm({ provider: 'auto', textLength: LONG }), {
    provider: 'openai',
    model: 'gpt-5-mini',
  });
});

test('auto uses OpenAI when Ollama is unreachable', async () => {
  fake.unreachable = true;
  assert.deepEqual(await llm.resolveLlm({ provider: 'auto', textLength: SHORT }), {
    provider: 'openai',
    model: 'gpt-5-mini',
  });
});

test('auto uses OpenAI when the default local model is not installed', async () => {
  process.env.LOCAL_LLM_MODEL = 'llama3.2:3b';
  assert.deepEqual(await llm.resolveLlm({ provider: 'auto', textLength: SHORT }), {
    provider: 'openai',
    model: 'gpt-5-mini',
  });
});

test('auto with a given local model uses it for a short text', async () => {
  assert.deepEqual(await llm.resolveLlm({ provider: 'auto', model: 'qwen3:8b', textLength: SHORT }), {
    provider: 'local',
    model: 'qwen3:8b',
  });
});

test('without a provider DEFAULT_PROVIDER is used', async () => {
  assert.equal((await llm.resolveLlm({ textLength: SHORT })).provider, 'local');
  process.env.DEFAULT_PROVIDER = 'openai';
  assert.equal((await llm.resolveLlm({ textLength: SHORT })).provider, 'openai');
});

test('local never falls back to OpenAI', async () => {
  assert.deepEqual(await llm.resolveLlm({ provider: 'local', textLength: LONG }), {
    provider: 'local',
    model: 'gemma3:4b',
  });

  fake.unreachable = true;
  llm.clearLocalModelCache();
  await rejectsWith(llm.resolveLlm({ provider: 'local', textLength: SHORT }), 503, /not reachable/);
  fake.unreachable = false;
  llm.clearLocalModelCache();

  process.env.LOCAL_LLM_MODEL = 'llama3.2:3b';
  await rejectsWith(
    llm.resolveLlm({ provider: 'local', textLength: SHORT }),
    503,
    /"llama3\.2:3b" is not installed/
  );
});

test('a local model name without a tag matches the ":latest" model', async () => {
  fake.models = [OLD];
  process.env.LOCAL_LLM_MODEL = 'llama2';
  assert.deepEqual(await llm.resolveLlm({ provider: 'local' }), {
    provider: 'local',
    model: 'llama2:latest',
  });
});

test('with ALLOW_EXTERNAL=false openai is refused and auto uses only the local model', async () => {
  process.env.ALLOW_EXTERNAL = 'false';
  await rejectsWith(llm.resolveLlm({ provider: 'openai' }), 403, /disabled/);
  process.env.DEFAULT_PROVIDER = 'openai';
  await rejectsWith(llm.resolveLlm({}), 403, /disabled/);

  assert.deepEqual(await llm.resolveLlm({ provider: 'auto', textLength: SHORT }), {
    provider: 'local',
    model: 'gemma3:4b',
  });
  await rejectsWith(llm.resolveLlm({ provider: 'auto', textLength: LONG }), 422, /LOCAL_MAX_CHARS/);

  fake.unreachable = true;
  llm.clearLocalModelCache();
  await rejectsWith(llm.resolveLlm({ provider: 'auto', textLength: SHORT }), 503, /not reachable/);
});

test('a model outside the allowed list is rejected with 400', async () => {
  await rejectsWith(llm.resolveLlm({ provider: 'openai', model: 'gpt-4o' }), 400, /"gpt-4o"/);
  await rejectsWith(llm.resolveLlm({ provider: 'local', model: 'llama3.2:3b' }), 400);
  // Embedding models are not chat models
  await rejectsWith(llm.resolveLlm({ provider: 'local', model: 'bge-m3' }), 400);
  await rejectsWith(llm.resolveLlm({ provider: 'auto', model: 'unknown', textLength: LONG }), 400);
  await rejectsWith(llm.resolveLlm({ provider: 'other' }), 400);

  assert.deepEqual(await llm.resolveLlm({ provider: 'openai', model: 'gpt-5' }), {
    provider: 'openai',
    model: 'gpt-5',
  });
});

test('with an empty OPENAI_MODELS only OPENAI_MODEL is offered', () => {
  process.env.OPENAI_MODELS = '';
  assert.deepEqual(llm.openaiModels(), ['gpt-5-mini']);
  process.env.OPENAI_MODELS = ' gpt-5 , gpt-5-nano ';
  assert.deepEqual(llm.openaiModels(), ['gpt-5-mini', 'gpt-5', 'gpt-5-nano']);
});

test('local chat goes to the OpenAI-compatible Ollama endpoint', async () => {
  fake.chatRequests.length = 0;
  const reply = await llm.chat({
    provider: 'local',
    model: 'gemma3:4b',
    system: 'System.',
    user: 'Question?',
    maxOutputTokens: 4000,
  });
  assert.deepEqual(reply, { text: 'Local answer [1].', provider: 'local', model: 'gemma3:4b' });
  // Local calls use LOCAL_MAX_OUTPUT_TOKENS (default 2048), not the caller's limit; the reply is
  // streamed with the token usage at the end
  assert.deepEqual(fake.chatRequests, [
    {
      model: 'gemma3:4b',
      messages: [
        { role: 'system', content: 'System.' },
        { role: 'user', content: 'Question?' },
      ],
      max_tokens: 2048,
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
});

const LOCAL_CONTEXT = /too large for the local model's context.*LOCAL_CONTEXT_TOKENS and OLLAMA_CONTEXT_LENGTH/;

function withLocalTokens(context, output, fn) {
  return async () => {
    if (context) process.env.LOCAL_CONTEXT_TOKENS = String(context);
    if (output) process.env.LOCAL_MAX_OUTPUT_TOKENS = String(output);
    fake.chatRequests.length = 0;
    llm.resetTokenRatio();
    try {
      await fn();
    } finally {
      delete process.env.LOCAL_CONTEXT_TOKENS;
      delete process.env.LOCAL_MAX_OUTPUT_TOKENS;
      delete fake.chatError;
      delete fake.finishReason;
      delete fake.charsPerToken;
      delete fake.outputTokens;
      llm.resetTokenRatio();
    }
  };
}

test('the local context defaults to 16384 tokens with 2048 output tokens', withLocalTokens(null, null, () => {
  const config = llm.llmConfig();
  assert.equal(config.localContextTokens, 16384);
  assert.equal(config.localMaxOutputTokens, 2048);
  // Conservative estimate: three characters per token
  assert.equal(llm.tokenRatio(), 3);
  assert.equal(llm.estimateTokens('a'.repeat(300)), 100);
  assert.equal(llm.estimateTokens('abcde'), 2);
}));

test(
  'a request fits when input + output tokens + 10% fit into LOCAL_CONTEXT_TOKENS',
  withLocalTokens(11000, 1000, () => {
    // (input + 1000) * 1.1 <= 11000 allows about 9000 input tokens (27,000 characters)
    assert.ok(llm.fitsLocalContext('a'.repeat(3000), 'b'.repeat(23700)));
    assert.ok(!llm.fitsLocalContext('a'.repeat(3000), 'b'.repeat(24300)));
  })
);

test(
  'the ratio follows the prompt tokens reported by Ollama and keeps the most conservative value',
  withLocalTokens(null, null, async () => {
    const send = (chars) =>
      llm.chat({ provider: 'local', model: 'gemma3:4b', system: 'S', user: 'x'.repeat(chars - 1) });

    // 6000 characters reported as 3000 tokens: 2 characters per token
    fake.charsPerToken = 2;
    await send(6000);
    assert.equal(llm.tokenRatio(), 2);
    assert.equal(llm.estimateTokens('a'.repeat(300)), 150);

    // A less conservative count later does not raise it again
    fake.charsPerToken = 5;
    await send(6000);
    assert.equal(llm.tokenRatio(), 2);

    // Short prompts are mostly chat template tokens and do not count
    fake.charsPerToken = 0.5;
    await send(100);
    assert.equal(llm.tokenRatio(), 2);
  })
);

test(
  'every local call logs the estimated and reported tokens, its purpose and LOCAL_CONTEXT_TOKENS',
  withLocalTokens(null, null, async (t) => {
    const log = mock.method(console, 'log', () => {});
    try {
      fake.charsPerToken = 4;
      await llm.chat({
        provider: 'local',
        model: 'gemma3:4b',
        system: 'S',
        user: 'x'.repeat(5999),
        purpose: 'merge of 4 notes',
      });
    } finally {
      log.mock.restore();
    }
    assert.deepEqual(log.mock.calls.map((c) => c.arguments[0]), [
      '[llm] local gemma3:4b merge of 4 notes: estimated input 2001 tokens (3.00 chars/token), ' +
        'reported prompt 1500, output 5 tokens, finish stop, max output 2048, LOCAL_CONTEXT_TOKENS 16384',
    ]);
  })
);

test(
  'LOCAL_MAX_OUTPUT_TOKENS sets max_tokens for local calls',
  withLocalTokens(65536, 8192, async () => {
    await llm.chat({ provider: 'local', model: 'gemma3:4b', system: 'S', user: 'U', maxOutputTokens: 4000 });
    assert.equal(fake.chatRequests[0].max_tokens, 8192);
  })
);

test(
  'a local request that does not fit the context is not sent',
  withLocalTokens(4096, 1024, async () => {
    await rejectsWith(
      llm.chat({ provider: 'local', model: 'gemma3:4b', system: 'S', user: 'x'.repeat(12000) }),
      422,
      LOCAL_CONTEXT
    );
    assert.equal(fake.chatRequests.length, 0);
  })
);

test(
  'a context error from Ollama gives the local context message and is not retried',
  withLocalTokens(null, null, async () => {
    fake.chatError = { status: 500, message: 'the input length exceeds the context length' };
    await rejectsWith(
      llm.chat({ provider: 'local', model: 'gemma3:4b', system: 'S', user: 'U' }),
      422,
      LOCAL_CONTEXT
    );
    assert.equal(fake.chatRequests.length, 1);
  })
);

test(
  'a reply that used all LOCAL_MAX_OUTPUT_TOKENS is an output limit error, not a context error',
  withLocalTokens(null, null, async () => {
    fake.finishReason = 'length';
    fake.outputTokens = 2048;
    await assert.rejects(
      llm.chat({ provider: 'local', model: 'gemma3:4b', system: 'S', user: 'U' }),
      (err) => {
        assert.ok(err instanceof llm.OutputLimitError);
        assert.equal(err.message, llm.LOCAL_OUTPUT_TOO_LONG_ERROR);
        return true;
      }
    );
  })
);

test(
  'a reply cut off before the output limit means Ollama ran out of context',
  withLocalTokens(null, null, async () => {
    fake.finishReason = 'length';
    fake.outputTokens = 700;
    await rejectsWith(
      llm.chat({ provider: 'local', model: 'gemma3:4b', system: 'S', user: 'U' }),
      422,
      LOCAL_CONTEXT
    );
  })
);

test('OpenAI chat returns the provider and model used', async () => {
  fakeOpenAI.requests.length = 0;
  const reply = await llm.chat({ provider: 'openai', model: 'gpt-5', system: 'S', user: 'U' });
  assert.deepEqual(reply, { text: 'OpenAI answer.', provider: 'openai', model: 'gpt-5' });
  assert.equal(fakeOpenAI.requests[0].body.model, 'gpt-5');
});

test('getLlmModels reports defaults, availability and models', async () => {
  process.env.ALLOW_EXTERNAL = 'false';
  assert.deepEqual(await llm.getLlmModels(), {
    default: { provider: 'auto', localModel: 'gemma3:4b', openaiModel: 'gpt-5-mini' },
    allowExternal: false,
    local: {
      reachable: true,
      models: [
        { name: 'gemma3:4b', size: 3300000000 },
        { name: 'qwen3:8b', size: 5200000000 },
      ],
    },
    openai: { configured: true, models: ['gpt-5-mini', 'gpt-5'] },
  });
});
