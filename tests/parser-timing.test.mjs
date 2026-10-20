// Pins: every parser of untrusted input (request bodies and targets, model and
// conductor output, host bodies, upstream errors, and the page's announcement
// and Live message handling) stays linear on its worst input shape. Each case is
// timed at doubling sizes (best of 3): the largest size must finish within
// LIMIT_MS, and once the time is measurable, a doubling must not come near the
// fourfold growth of a quadratic. Also pins that the linear rewrites of
// dropParenthetical and truncateBody's newline strip give the old regexes'
// output on generated inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJsonBody } from '../src/http.js';
import { createSseHub } from '../src/sse.js';
import { createPrefsStore } from '../src/prefsStore.js';
import { createKeyStore } from '../src/keyStore.js';
import { callTool } from '../src/tools.js';
import { resolveAnswers, dropParenthetical } from '../src/answerMapping.js';
import { createConductorService } from '../src/conductor.js';
import { textParts, truncateBody, truncate, renderQuestions, renderPlan, assistantText, summarize, MAX_TEXT } from '../src/hostEvents.js';
import { assembleMessages, bondedSelection, messageBody, parseMessageKey } from '../src/eventMessages.js';
import { createGemini } from '../src/gemini.js';
import { installAnnouncements } from '../frontend/src/lib/announcements.js';
import { createTranscriptStore } from '../frontend/src/lib/transcriptStore.js';
import { createLiveSession } from '../frontend/src/lib/liveSession.js';
import { tempDir, SENTINEL_KEY } from './helpers.mjs';

const SIZES = [10_000, 20_000, 40_000, 80_000];
// assembleMessages allocates an object per message, so past about 40k events garbage collection adds a cost that grows
// with the heap; these sizes stay where the per-event cost is flat, and a quadratic still shows at them.
const EVENT_SIZES = [5_000, 10_000, 20_000, 40_000];
const BODY_SIZES = [8_192, 16_384, 32_768, 65_536]; // readJsonBody refuses more than 64 KB
// textParts is under a millisecond at SIZES, so a quadratic scan only shows at plan-sized inputs.
const PART_SIZES = [1_000_000, 2_000_000, 4_000_000];
const LIMIT_MS = 250;
const MEASURABLE_MS = 5;
const MAX_RATIO = 3; // a quadratic grows about 4x per doubling

async function best(fn, input) {
  let min = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    await fn(input);
    min = Math.min(min, performance.now() - t);
  }
  return min;
}

async function assertLinear(name, make, run, sizes = SIZES) {
  const times = [];
  for (const n of sizes) times.push(await best(run, make(n)));
  const shown = times.map((t, i) => `${sizes[i]}: ${t.toFixed(1)} ms`).join(', ');
  assert.ok(times.at(-1) < LIMIT_MS, `${name}: ${shown}`);
  const [t40, t80] = times.slice(-2);
  if (t40 >= MEASURABLE_MS) assert.ok(t80 / t40 < MAX_RATIO, `${name} grows superlinearly: ${shown}`);
}

const bodyReq = (raw) => ({ headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield Buffer.from(raw); } });
function flatObject(n) {
  const parts = [];
  for (let len = 2; ; ) {
    const part = `"k${String(parts.length).padStart(6, '0')}":1`;
    if (len + part.length + 1 > n) break;
    parts.push(part);
    len += part.length + 1;
  }
  return `{${parts.join(',')}}`;
}

test('request bodies: flat objects and deep nesting up to the size cap', async () => {
  await assertLinear('readJsonBody flat', flatObject, (raw) => readJsonBody(bodyReq(raw)), BODY_SIZES);
  await assertLinear('readJsonBody nested', (n) => '['.repeat(n / 2) + ']'.repeat(n / 2), (raw) => readJsonBody(bodyReq(raw)), BODY_SIZES);
  await assertLinear('readJsonBody unclosed', (n) => '['.repeat(n), (raw) => readJsonBody(bodyReq(raw)).catch(() => {}), BODY_SIZES);
});

test('request targets and the SSE lastEventId', async () => {
  await assertLinear('URL pathname', (n) => '/' + '%2e%2E/'.repeat(n / 7), (u) => new URL(u, 'http://localhost').pathname);
  const hub = createSseHub({ timers: { setInterval: () => ({}), clearInterval: () => {} } });
  const res = { writeHead() {}, write() {}, end() {} };
  for (const [name, make] of [['hex run', (n) => 'a'.repeat(n) + '-x'], ['digit run', (n) => 'a-' + '1'.repeat(n) + 'x']]) {
    await assertLinear(`lastEventId ${name}`, make, (id) => hub.handle({ headers: { 'last-event-id': id }, url: '/api/events', on() {} }, res));
  }
  hub.closeAll();
});

test('stored settings: custom prompt normalization and the key check', async (t) => {
  const dir = await tempDir();
  t.after(() => import('node:fs').then(({ promises }) => promises.rm(dir, { recursive: true, force: true })));
  const prefs = createPrefsStore({ dir });
  const keys = createKeyStore({ dir });
  await assertLinear('setCustomPrompt CR run', (n) => '\r'.repeat(n) + 'x', (s) => prefs.setCustomPrompt(s).catch(() => {}));
  await assertLinear('setCustomPrompt space run', (n) => ' '.repeat(n) + '\u0001', (s) => prefs.setCustomPrompt(s).catch(() => {}));
  await assertLinear('key set', (n) => ' '.repeat(n) + '!'.repeat(n), (s) => keys.set(s).catch(() => {}));
});

test('tool arguments from the model', async () => {
  const service = { answer: async () => ({ ok: true }), reject: async () => ({ ok: true }), read: async () => ({ ok: true }) };
  await assertLinear('answer_conductor_question args', (n) => ({ session: ' '.repeat(n) + 'x', answers: Array.from({ length: n / 10 }, () => ({ choices: ['1', 2], text: ' ', note: ' ' })) }),
    (args) => callTool('answer_conductor_question', args, service));
  await assertLinear('reject_conductor_plan feedback', (n) => ({ session: 'c', feedback: ' '.repeat(n) + 'x' + ' '.repeat(n) }), (args) => callTool('reject_conductor_plan', args, service));
});

test('answer mapping: spoken choices against conductor-written option labels', async () => {
  const question = (labels) => [{ options: labels.map((label) => ({ label })) }];
  const shapes = {
    'whitespace run before no group': (n) => [question([' '.repeat(n) + 'x', 'y']), [{ choices: ['zz'] }]],
    'open-paren run': (n) => [question(['('.repeat(n) + ')', 'y']), [{ choices: ['zz'] }]],
    'close-paren run': (n) => [question([')'.repeat(n), 'y']), [{ choices: ['zz'] }]],
    'group after a long label': (n) => [question(['a '.repeat(n / 2) + '(b)', 'y']), [{ choices: ['a'] }]],
    'punctuation run': (n) => [question(['!'.repeat(n), 'y']), [{ choices: ['!'.repeat(n)] }]],
    'ordinal-like choice': (n) => [question(['x', 'y']), [{ choices: [' '.repeat(n) + 'option' + ' '.repeat(n) + 'x'] }]],
  };
  for (const [name, make] of Object.entries(shapes)) await assertLinear(`resolveAnswers ${name}`, make, ([q, spoken]) => resolveAnswers(q, spoken));
});

test('conductor lookup by a model-named session against host titles', async () => {
  const make = (n) => {
    const rows = [{ id: 'c1', project: '.conduct', title: 'a'.repeat(n) + 'b' }, { id: 'c2', project: '.conduct', title: '', firstPrompt: 'p'.repeat(n) }];
    return { rows, session: 'A'.repeat(n) };
  };
  await assertLinear('resolve', make, async ({ rows, session }) => {
    const service = createConductorService({ api: { listInstances: async () => rows }, link: {}, announcer: {}, hostMcp: {} });
    await callTool('read_conductor_messages', { session }, service);
  });
});

test('host events: reply truncation, rendering and text extraction', async () => {
  const fence = '--- questions ---';
  const shapes = {
    'newline run before the fence': (n) => '\n'.repeat(n) + 'a\n' + fence + '\n1. q',
    'many fences': (n) => `${fence}\n`.repeat(n / 18),
    'prose, no fence': (n) => 'x'.repeat(n),
    'section over max': (n) => `p\n${fence}\n` + `   - ${'o'.repeat(200)}\n`.repeat(n / 205),
    'fence-like lines': (n) => `--- questions --\n`.repeat(n / 17) + fence,
  };
  for (const [name, make] of Object.entries(shapes)) await assertLinear(`truncateBody ${name}`, make, (s) => truncateBody(s, MAX_TEXT));
  const partShapes = {
    'one long line': (n) => 'x'.repeat(n),
    'all newlines': (n) => '\n'.repeat(n),
    'newline every ~100 chars': (n) => `${'x'.repeat(99)}\n`.repeat(n / 100),
  };
  for (const [name, make] of Object.entries(partShapes)) await assertLinear(`textParts ${name}`, make, (s) => textParts(s), PART_SIZES);
  await assertLinear('truncate', (n) => 'x'.repeat(n), (s) => truncate(s, MAX_TEXT));
  await assertLinear('renderQuestions', (n) => Array.from({ length: n / 20 }, (_, i) => ({ question: `q${i}`, header: 'h', options: [{ label: 'l', description: 'd' }] })), renderQuestions);
  await assertLinear('renderPlan', (n) => ({ planPath: 'p'.repeat(n), plan: 'x\n'.repeat(n) }), renderPlan);
  await assertLinear('assistantText', (n) => ({ kind: 'assistant_message', message: { content: Array.from({ length: n / 10 }, () => ({ type: 'text', text: '   \n    ' })) } }), assistantText);
  await assertLinear('summarize', (n) => ({ id: 'c', title: '', firstPrompt: 'x'.repeat(n) }), summarize);
});

test('events: message assembly, selection, body rendering and key parsing', async () => {
  const text = (msgId, t, extra = {}) => ({ kind: 'assistant_message', msgId, message: { content: [{ type: 'text', text: t }] }, ...extra });
  const seq = (events) => events.map((ev, i) => ({ ...ev, _seq: i + 1 }));
  const shapes = {
    'one message of many tiny deltas': (n) => seq(Array.from({ length: n }, () => ({ kind: 'text_delta', msgId: 'm', blockIdx: 0, text: 'ab' }))),
    'many one-delta messages': (n) => seq(Array.from({ length: n }, (_, i) => ({ kind: 'text_delta', msgId: `m${i}`, blockIdx: 0, text: 'ab' }))),
    'many turns of one message': (n) => seq(Array.from({ length: n }, (_, i) => (i % 2 ? { kind: 'turn_end' } : text(`m${i}`, 'x')))),
    'one huge envelope text': (n) => seq([text('m', 'x'.repeat(n * 10))]),
    'many text blocks in one envelope': (n) => seq([{ kind: 'assistant_message', msgId: 'm', message: { content: Array.from({ length: n }, () => ({ type: 'text', text: 'ab' })) } }]),
    'plan_requests that match no tool_use': (n) => seq([text('m', 'x'), ...Array.from({ length: n }, (_, i) => ({ kind: 'plan_request', toolUseId: `none${i}`, plan: 'p' }))]),
    'narration blocks': (n) => seq(Array.from({ length: n }, (_, i) => ({ kind: 'thinking_delta', msgId: 'm', blockIdx: i, narration: true, text: ' step ' }))),
  };
  const run = (events) => {
    const messages = assembleMessages(events);
    return truncateBody(bondedSelection(messages).map(messageBody).join('\n'), MAX_TEXT);
  };
  for (const [name, make] of Object.entries(shapes)) await assertLinear(`assembleMessages ${name}`, make, run, EVENT_SIZES);
  const keys = {
    'digits only': (n) => '1'.repeat(n),
    'digits then dash': (n) => `${'1'.repeat(14)}-${'m'.repeat(n)}`,
    'dashes only': (n) => '-'.repeat(n),
  };
  for (const [name, make] of Object.entries(keys)) await assertLinear(`parseMessageKey ${name}`, make, parseMessageKey);
});

test('upstream Gemini error bodies: key scrubbing', async () => {
  const near = SENTINEL_KEY.slice(0, 7); // one short of a redacted run, the costliest step
  for (const [name, make] of [['near-key runs', (n) => (near + '#').repeat(n / 8)], ['key copies', (n) => SENTINEL_KEY.repeat(n / SENTINEL_KEY.length)], ['plain', (n) => 'z'.repeat(n)]]) {
    await assertLinear(`scrub ${name}`, make, async (message) => {
      const gemini = createGemini({
        base: 'http://gemini.test', wsUrl: 'wss://gemini.test', keyStore: { get: async () => SENTINEL_KEY }, prefsStore: { get: async () => ({ voice: null, customPrompt: '' }) },
        fetchImpl: async () => ({ ok: false, status: 400, statusText: 'Bad', json: async () => ({ error: { message } }) }),
      });
      await gemini.mintToken({ modelId: 'gemini-3.8-live' }).catch((e) => assert.equal(e.code, 'GEMINI_ERROR'));
    });
  }
});

test('page: announcement sanitising and Live message decoding', async () => {
  const listeners = {};
  const eventSource = { addEventListener: (name, fn) => { listeners[name] = fn; } };
  const sent = [];
  installAnnouncements({ eventSource, transcript: createTranscriptStore(), session: { state: 'live', sendText: (s) => sent.push(s.length) }, hostIndicator: { set() {} } });
  const announce = (a) => listeners.announce({ data: JSON.stringify(a) });
  const shapes = {
    'separator run': (n) => ' '.repeat(n),
    'space run before a non-marker': (n) => ' '.repeat(n) + 'x',
    'spaced marker words': (n) => 'CONDUCTOR' + ' '.repeat(n) + 'X',
    'invisible run': (n) => '​'.repeat(n) + 'CONDUCTOR UPDATE',
    'combining run': (n) => 'C' + '́'.repeat(n),
    'many marker lines': (n) => 'AWAITING ANSWER\n'.repeat(n / 16),
    'CRLF run': (n) => '\r\n'.repeat(n / 2),
  };
  for (const [name, make] of Object.entries(shapes)) {
    await assertLinear(`announce ${name}`, (n) => ({ sessionId: make(n), title: make(n), text: make(n), ask: { kind: 'plan', planPath: make(n) } }), announce);
  }

  class Socket {
    static last;
    readyState = 1;
    listeners = {};
    constructor() { Socket.last = this; queueMicrotask(() => this.emit('open', {})); }
    addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
    emit(t, ev) { for (const fn of this.listeners[t] ?? []) fn(ev); }
    send(d) { if (JSON.parse(d).setup) queueMicrotask(() => this.emit('message', { data: '{"setupComplete":{}}' })); }
    close() {}
  }
  const session = createLiveSession({ api: { mintToken: async () => ({ token: 't', wsUrl: 'wss://x' }), callTool: async () => ({}) }, WebSocketImpl: Socket, onEvent() {} });
  await session.connect('m');
  assert.equal(session.state, 'live');
  const enc = new TextEncoder();
  for (const [name, make] of [
    ['long transcription', (n) => enc.encode(JSON.stringify({ serverContent: { outputTranscription: { text: 'x'.repeat(n) } } })).buffer],
    ['many audio parts', (n) => JSON.stringify({ serverContent: { modelTurn: { parts: Array.from({ length: n / 40 }, () => ({ inlineData: { mimeType: 'audio/pcm', data: 'AAAA' } })) } } })],
    ['deep nesting', (n) => '['.repeat(n / 2) + ']'.repeat(n / 2)],
    ['malformed', (n) => '{"a":"' + 'x'.repeat(n)],
  ]) await assertLinear(`Live message ${name}`, make, (data) => Socket.last.emit('message', { data }));
  session.disconnect();
});

// A deterministic generator (mulberry32) for the equivalence checks.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randomString = (next, alphabet, max) => Array.from({ length: Math.floor(next() * (max + 1)) }, () => alphabet[Math.floor(next() * alphabet.length)]).join('');

test('dropParenthetical gives the old regex output on generated labels', () => {
  const old = (s) => s.replace(/\s*\([^()]*\)\s*$/, '');
  const next = rng(1);
  const alphabet = [' ', '\t', '\n', ' ', ' ', '﻿', '(', ')', 'a', 'b'];
  let changed = 0;
  for (let i = 0; i < 20_000; i++) {
    const s = randomString(next, alphabet, 12);
    assert.equal(dropParenthetical(s), old(s), JSON.stringify(s));
    if (old(s) !== s) changed++;
  }
  assert.ok(changed > 1000, `the generator exercises the stripping branch (${changed})`);
  for (const s of ['Yes (recommended)', 'Yes  (x) ', '(only)', 'a (b) (c)', 'a ((b))', 'a (b', 'a b)', '()', ')', '', ' ']) assert.equal(dropParenthetical(s), old(s), JSON.stringify(s));
});

test("truncateBody's prose head gives the old regex output on generated replies", () => {
  // The branch the rewrite touches: the questions section fits, and the prose
  // before it loses its trailing newlines and is cut to the room left.
  const fence = '--- questions ---';
  const oldFitted = (text, max) => {
    const at = text.lastIndexOf(`\n${fence}`) + 1;
    const section = text.slice(at);
    const room = max - section.length - 1;
    const head = text.slice(0, at).replace(/\n+$/, '');
    return (room >= 2 && head ? `${truncate(head, room)}\n` : '') + section;
  };
  const next = rng(2);
  let kept = 0;
  for (let i = 0; i < 20_000; i++) {
    const prose = randomString(next, ['\n', 'a', ' '], 30);
    const text = `${prose}\n${fence}\n1. q`;
    const section = `${fence}\n1. q`;
    const max = section.length + 1 + Math.floor(next() * (prose.length + 1));
    if (text.length <= max) continue;
    const out = truncateBody(text, max);
    assert.deepEqual(out, { text: oldFitted(text, max), cut: false, dropped: false }, JSON.stringify([text, max]));
    if (out.text !== section) kept++;
  }
  assert.ok(kept > 1000, `the generator keeps some prose (${kept})`);
});
