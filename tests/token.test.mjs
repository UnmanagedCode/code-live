// Pins: POST /api/token mints a single-use ephemeral token whose locked setup
// matches each pinned model's verified requirements, with the key sent only
// in the x-goog-api-key header and upstream errors scrubbed of it. The saved
// voice and custom instructions are folded into that setup at every mint
// (resumes included), and with neither set the setup is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS } from '../src/models.js';
import { DECLARATIONS } from '../src/tools.js';
import { SYSTEM_PROMPT, CUSTOM_PROMPT_HEADER, composeSystemPrompt } from '../src/liveSetup.js';
import { startFakeGemini, LIVE_PATH } from './fakes/fakeGemini.mjs';
import { startApp, req, SENTINEL_KEY } from './helpers.mjs';
import { promises as fs } from 'node:fs';

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
      { id: 'gemini-3.8-live-extended-thinking', label: 'Gemini 3.8 Live Extended Thinking', hint: 'tool calls usually fail' },
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

const baselineGenerationConfig = (model) => (model.thinkingLevel
  ? { responseModalities: ['AUDIO'], thinkingConfig: { thinkingLevel: model.thinkingLevel } }
  : { responseModalities: ['AUDIO'] });
const setupOf = (gemini) => gemini.requests.at(-1).body.bidiGenerateContentSetup;

test('composeSystemPrompt returns the built-in prompt unchanged for no custom text', () => {
  for (const none of ['', null, undefined]) assert.equal(composeSystemPrompt(none), SYSTEM_PROMPT);
});

test('cleared preferences leave the setup identical to the unset baseline', async (t) => {
  const { gemini, app } = await setup(t);
  await mint(app, { model: 'gemini-3.8-live' });
  const baseline = setupOf(gemini);
  await app.deps.prefs.setVoice('Puck');
  await app.deps.prefs.setCustomPrompt('Be brief.');
  await app.deps.prefs.setVoice(null);
  await app.deps.prefs.setCustomPrompt('');
  await mint(app, { model: 'gemini-3.8-live' });
  assert.deepEqual(setupOf(gemini), baseline);
  assert.ok(!('speechConfig' in setupOf(gemini).generationConfig));
});

for (const model of MODELS) {
  test(`a saved voice adds speechConfig to the ${model.id} generationConfig and nothing else`, async (t) => {
    const { gemini, app } = await setup(t);
    await app.deps.prefs.setVoice('Puck');
    assert.equal((await mint(app, { model: model.id })).status, 200);
    assert.deepEqual(setupOf(gemini).generationConfig, {
      ...baselineGenerationConfig(model),
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
    });
    assert.deepEqual(setupOf(gemini).systemInstruction, { parts: [{ text: SYSTEM_PROMPT }] });
  });
}

test('saved custom instructions follow the built-in prompt under the header', async (t) => {
  const { gemini, app } = await setup(t);
  await app.deps.prefs.setCustomPrompt('Keep every reply to one short sentence.');
  await mint(app, { model: 'gemini-3.8-live' });
  const text = setupOf(gemini).systemInstruction.parts[0].text;
  assert.equal(text, composeSystemPrompt('Keep every reply to one short sentence.'));
  assert.ok(text.startsWith(`${SYSTEM_PROMPT}\n\n${CUSTOM_PROMPT_HEADER}\n`));
  assert.ok(text.endsWith('Keep every reply to one short sentence.'));
  assert.ok(!('speechConfig' in setupOf(gemini).generationConfig));
});

test('a resume mint carries the saved voice and instructions', async (t) => {
  const { gemini, app } = await setup(t);
  await app.deps.prefs.setVoice('Kore');
  await app.deps.prefs.setCustomPrompt('Be brief.');
  await mint(app, { model: 'gemini-3.8-live', resumeHandle: 'Handle_abc-123' });
  const sent = setupOf(gemini);
  assert.deepEqual(sent.sessionResumption, { handle: 'Handle_abc-123' });
  assert.equal(sent.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  assert.equal(sent.systemInstruction.parts[0].text, composeSystemPrompt('Be brief.'));
});

test('a corrupt preferences.json fails the mint with 500 STORE_CORRUPT and sends nothing to Gemini', async (t) => {
  const { gemini, app } = await setup(t);
  await app.deps.prefs.setVoice('Kore');
  await fs.writeFile(app.deps.prefs.file, '{"voice":"Nope"}');
  const r = await mint(app, { model: 'gemini-3.8-live' });
  assert.equal(r.status, 500);
  assert.equal(r.json.code, 'STORE_CORRUPT');
  assert.equal(gemini.requests.length, 0);
});

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
