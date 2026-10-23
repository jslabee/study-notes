// Points the OpenAI client at a fake host and answers its requests locally, so no tokens are used
const FAKE_URL = 'http://openai.test/v1';

export function installFakeOpenAI({ answer = 'Fake answer [1].' } = {}) {
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_MODEL = 'test-model';
  process.env.OPENAI_BASE_URL = FAKE_URL;

  const realFetch = globalThis.fetch;
  const fake = { requests: [], answer };

  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith(FAKE_URL)) return realFetch(url, options);
    const body = JSON.parse(options.body);
    fake.requests.push({ url: String(url), body });
    return Response.json({
      id: 'resp_test',
      object: 'response',
      created_at: 0,
      status: 'completed',
      model: body.model,
      incomplete_details: null,
      output: [
        {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: fake.answer, annotations: [] }],
        },
      ],
    });
  };
  fake.restore = () => {
    globalThis.fetch = realFetch;
  };
  return fake;
}
