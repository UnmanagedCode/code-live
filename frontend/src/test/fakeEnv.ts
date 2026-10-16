// Browser fakes for createAppController in component tests: a routed fetch
// (no network), and inert EventSource / audio / microphone stubs. A test that
// needs a live session uses App.integration.test.tsx instead.
type Reply = { status: number; body: unknown };
type Route = (body: any) => Reply | Promise<Reply>;

export const MODELS = [{ id: 'gemini-3.8-live', label: 'Gemini 3.8 Live' }, { id: 'slow', label: 'Slow', hint: 'tool calls usually fail' }];
export const VOICES = [{ name: 'Puck', style: 'Upbeat' }, { name: 'Kore', style: 'Firm' }];

export function fakeEnv({ keySet = true, routes = {} }: { keySet?: boolean; routes?: Record<string, Route> } = {}) {
  let apiKey = keySet ? { set: true, tail: 'abcd' } : { set: false, tail: null };
  const table: Record<string, Route> = {
    'GET api/models': () => ({ status: 200, body: { models: MODELS } }),
    'GET api/settings': () => ({ status: 200, body: { apiKey, voice: null, customPrompt: '', customPromptMax: 4000 } }),
    'GET api/voices': () => ({ status: 200, body: { voices: VOICES } }),
    'PUT api/settings/api-key': (b) => { apiKey = { set: true, tail: String(b.apiKey).slice(-4) }; return { status: 200, body: { apiKey } }; },
    'DELETE api/settings/api-key': () => { apiKey = { set: false, tail: null }; return { status: 200, body: { apiKey } }; },
    ...routes,
  };
  const fetchImpl = (async (url: string, init: { method: string; body?: string }) => {
    const route = table[`${init.method} ${url}`];
    const { status, body } = route ? await route(init.body ? JSON.parse(init.body) : undefined) : { status: 404, body: { error: 'not found' } };
    return { ok: status < 300, status, json: async () => body };
  }) as unknown as typeof fetch;
  class EventSourceImpl { addEventListener() {} close() {} }
  return { fetchImpl, EventSourceImpl, WebSocketImpl: class {}, AudioContextImpl: class {}, AudioWorkletNodeImpl: class {}, mediaDevices: {} };
}
