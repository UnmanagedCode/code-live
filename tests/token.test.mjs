// Pins: POST /api/token mints a single-use ephemeral token whose locked setup
// matches each pinned model's verified requirements, with the key sent only
// in the x-goog-api-key header and upstream errors scrubbed of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS } from '../src/models.js';
import { DECLARATIONS } from '../src/tools.js';
import { SYSTEM_PROMPT } from '../src/liveSetup.js';
import { startFakeGemini, LIVE_PATH } from './fakes/fakeGemini.mjs';
import { startApp, req, SENTINEL_KEY } from './helpers.mjs';

const NOW = Date.UTC(2030, 0, 2, 3, 4, 5, 678);

async function setup(t, { key = true } = {}) {
  const gemini = await startFakeGemini();
  const app = await startApp({ gemini, now: () => NOW, startLink: false });
  t.after(async () => { await app.stop(); await gemini.close(); });
  if (key) await app.deps.keyStore.set(SENTINEL_KEY);
  return { gemini, app };
}

const mint = (app, body) => req(`${app.url}/api/token`, { method: 'POST', body });

test('the catalog is exactly the three pinned models', () => {
  assert.deepEqual(MODELS.map((m) => m.id), ['gemini-3.8-live', 'gemini-3.8-live-extended-thinking', 'gemini-3.1-flash-live-preview']);
});

test('GET /api/models lists id, label and any hint', async (t) => {
  const { app } = await setup(t, { key: false });
  const r = await req(`${app.url}/api/models`);
  assert.deepEqual(r.json, {
    models: [
      { id: 'gemini-3.8-live', label: 'Gemini 3.8 Live' },
      { id: 'gemini-3.8-live-extended-thinking', label: 'Gemini 3.8 Live Extended Thinking', hint: 'tool calls unreliable' },
      { id: 'gemini-3.1-flash-live-preview', label: 'Gemini 3.1 Flash Live Preview' },
    ],
  });
});

for (const model of MODELS) {
  test(`mint for ${model.id} sends the verified setup`, async (t) => {
    const { gemini, app } = await setup(t);
    const r = await mint(app, { model: model.id });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {
      token: 'auth_tokens/fake-1',
      wsUrl: gemini.base.replace('http', 'ws') + LIVE_PATH,
      model: model.id,
      expireTime: '2030-01-02T03:34:05Z',
    });

    assert.equal(gemini.requests.length, 1);
    const sent = gemini.requests[0];
    assert.equal(sent.url, '/v1beta/auth_tokens');
    assert.equal(sent.headers['x-goog-api-key'], SENTINEL_KEY);
    assert.ok(!sent.url.includes(SENTINEL_KEY));
    assert.ok(!JSON.stringify(sent.body).includes(SENTINEL_KEY));
    assert.equal(sent.body.uses, 1);
    assert.equal(sent.body.expireTime, '2030-01-02T03:34:05Z');
    assert.equal(sent.body.newSessionExpireTime, '2030-01-02T03:05:05Z');

    const minted = sent.body.bidiGenerateContentSetup;
    const ext = model.id === 'gemini-3.8-live-extended-thinking';
    assert.deepEqual(minted, {
      model: `models/${model.id}`,
      generationConfig: ext ? { responseModalities: ['AUDIO'], thinkingConfig: { thinkingLevel: 'low' } } : { responseModalities: ['AUDIO'] },
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      tools: [{ functionDeclarations: DECLARATIONS.map((d) => (ext ? { ...d, behavior: 'NON_BLOCKING' } : d)) }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      sessionResumption: {},
      contextWindowCompression: { slidingWindow: {} },
    });
    for (const fn of minted.tools[0].functionDeclarations) assert.equal(fn.parameters.type, 'OBJECT');
  });
}

test('a resume handle lands in sessionResumption.handle', async (t) => {
  const { gemini, app } = await setup(t);
  const r = await mint(app, { model: 'gemini-3.8-live', resumeHandle: 'Handle_abc-123' });
  assert.equal(r.status, 200);
  assert.deepEqual(gemini.requests[0].body.bidiGenerateContentSetup.sessionResumption, { handle: 'Handle_abc-123' });
});

test('mint error codes', async (t) => {
  const { gemini, app } = await setup(t);
  let r = await mint(app, { model: 'gemini-2.0-flash' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'UNKNOWN_MODEL');
  r = await mint(app, { model: 'gemini-3.8-live', resumeHandle: 'bad handle!' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'INVALID_ARGS');
  assert.equal(gemini.requests.length, 0, 'nothing reaches Gemini for invalid input');
  await app.deps.keyStore.clear();
  r = await mint(app, { model: 'gemini-3.8-live' });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'NO_API_KEY');
});

test('an upstream failure is a scrubbed 502', async (t) => {
  const { gemini, app } = await setup(t);
  gemini.setMintFailure({ status: 400, body: { error: { code: 400, message: `API key not valid: ${SENTINEL_KEY}`, status: 'INVALID_ARGUMENT' } } });
  const r = await mint(app, { model: 'gemini-3.8-live' });
  assert.equal(r.status, 502);
  assert.equal(r.json.code, 'GEMINI_ERROR');
  assert.equal(r.json.error, 'Gemini token mint failed (400): API key not valid: [redacted]');
});

test('an unreachable Gemini is a 502 GEMINI_ERROR', async (t) => {
  const gemini = await startFakeGemini();
  const app = await startApp({ gemini, startLink: false });
  t.after(() => app.stop());
  await app.deps.keyStore.set(SENTINEL_KEY);
  await gemini.close();
  const r = await mint(app, { model: 'gemini-3.8-live' });
  assert.equal(r.status, 502);
  assert.equal(r.json.code, 'GEMINI_ERROR');
  assert.ok(!r.text.includes(SENTINEL_KEY));
});
