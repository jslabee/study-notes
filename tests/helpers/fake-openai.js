// Points the OpenAI client at a fake host and answers its requests locally, so no tokens are used
const FAKE_URL = 'http://openai.test/v1';

export function installFakeOpenAI({ answer = 'Fake answer [1].' } = {}) {
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_MODEL = 'test-model';
  process.env.OPENAI_BASE_URL = FAKE_URL;

  const realFetch = globalThis.fetch;
  // cutOff(body) returns true to answer with a response cut off by max_output_tokens
  const fake = { requests: [], answer, cutOff: null };

  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith(FAKE_URL)) return realFetch(url, options);
    const body = JSON.parse(options.body);
    fake.requests.push({ url: String(url), body });
    // wait: a promise that holds every answer until it resolves
    await fake.wait;
    const cutOff = Boolean(fake.cutOff?.(body));
    const text = cutOff ? `${fake.answer} (truncated` : fake.answer;
    return Response.json({
      id: 'resp_test',
      object: 'response',
      created_at: 0,
      status: cutOff ? 'incomplete' : 'completed',
      model: body.model,
      incomplete_details: cutOff ? { reason: 'max_output_tokens' } : null,
      output: [
        {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          status: cutOff ? 'incomplete' : 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      ],
      usage: {
        input_tokens: Math.ceil(String(body.input).length / 4),
        output_tokens: cutOff ? body.max_output_tokens : 10,
        output_tokens_details: { reasoning_tokens: cutOff ? body.max_output_tokens - 5 : 4 },
        total_tokens: 0,
      },
    });
  };
  fake.restore = () => {
    globalThis.fetch = realFetch;
  };
  return fake;
}
