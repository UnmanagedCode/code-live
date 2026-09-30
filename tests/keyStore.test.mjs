// Pins: the key file lives at <PROJECTS_ROOT>/.code-live/secrets.json, is
// 0600, is written atomically, never echoes an invalid key, and a corrupt
// store fails loudly; state.json round-trips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createKeyStore } from '../src/keyStore.js';
import { createStateStore } from '../src/stateStore.js';
import { SENTINEL_KEY, tempDir } from './helpers.mjs';

async function setup() {
  const root = await tempDir();
  const config = loadConfig({ PROJECTS_ROOT: root, CONDUCTOR_URL: 'http://127.0.0.1:1/' });
  return { root, config, store: createKeyStore({ dir: config.dataDir }) };
}

test('set/get/status/clear round-trip at the env-derived path with mode 0600', async (t) => {
  const { root, store } = await setup();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.deepEqual(await store.status(), { set: false, tail: null });
  assert.equal(await store.get(), null);

  await store.set(`  ${SENTINEL_KEY}\n`);
  const file = path.join(root, '.code-live', 'secrets.json');
  assert.equal(store.file, file);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { geminiApiKey: SENTINEL_KEY });
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['secrets.json'], 'no temp file left behind');
  assert.equal(await store.get(), SENTINEL_KEY);
  assert.deepEqual(await store.status(), { set: true, tail: 'cdef' });

  await store.clear();
  assert.deepEqual(await store.status(), { set: false, tail: null });
  await store.clear(); // clearing an absent key is fine
});

test('overwriting keeps mode 0600 even if the file was loosened', async (t) => {
  const { root, store } = await setup();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await store.set(SENTINEL_KEY);
  await fs.chmod(store.file, 0o644);
  await store.set(SENTINEL_KEY + 'X');
  assert.equal((await fs.stat(store.file)).mode & 0o777, 0o600);
});

test('invalid keys are rejected without echoing the value', async (t) => {
  const { root, store } = await setup();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const bad of ['short-SENTINEL', 'has space SENTINEL-0123456789abcdef', 'x'.repeat(513), 42, null]) {
    await assert.rejects(store.set(bad), (e) => {
      assert.equal(e.code, 'INVALID_KEY');
      if (typeof bad === 'string') assert.ok(!e.message.includes(bad.slice(0, 12)), 'message must not echo input');
      return true;
    });
  }
  assert.equal(await store.get(), null);
});

test('a corrupt secrets.json fails loudly', async (t) => {
  const { root, config, store } = await setup();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(store.file, '{not json');
  await assert.rejects(store.get(), { code: 'STORE_CORRUPT' });
  await fs.writeFile(store.file, JSON.stringify({ other: 1 }));
  await assert.rejects(store.status(), { code: 'STORE_CORRUPT' });
});

test('loadConfig requires the host-provided env', () => {
  assert.throws(() => loadConfig({ CONDUCTOR_URL: 'http://x' }), /PROJECTS_ROOT/);
  assert.throws(() => loadConfig({ PROJECTS_ROOT: '/tmp' }), /CONDUCTOR_URL/);
  const c = loadConfig({ PROJECTS_ROOT: '/r', CONDUCTOR_URL: 'http://127.0.0.1:8/', PORT: '1234' });
  assert.equal(c.port, 1234);
  assert.equal(c.dataDir, path.join('/r', '.code-live'));
  assert.equal(c.hostWsUrl, 'ws://127.0.0.1:8/ws');
  assert.equal(c.geminiWsUrl, 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained');
});

test('stateStore round-trips, persists 0600 and rejects corrupt state', async (t) => {
  const { root, config } = await setup();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const s1 = createStateStore({ dir: config.dataDir });
  assert.deepEqual(await s1.load(), { activeTargetId: null, lastHandledTurnSeq: -1, lastHandledMsgId: null });
  await Promise.all([s1.update({ activeTargetId: 'a' }), s1.update({ lastHandledTurnSeq: 7 })]);
  assert.equal((await fs.stat(s1.file)).mode & 0o777, 0o600);
  const s2 = createStateStore({ dir: config.dataDir });
  assert.deepEqual(await s2.load(), { activeTargetId: 'a', lastHandledTurnSeq: 7, lastHandledMsgId: null });
  // A state.json written before lastHandledMsgId existed still loads; the id round-trips; a non-string id is corrupt.
  await fs.writeFile(s1.file, JSON.stringify({ activeTargetId: 'a', lastHandledTurnSeq: 7 }));
  assert.deepEqual(await createStateStore({ dir: config.dataDir }).load(), { activeTargetId: 'a', lastHandledTurnSeq: 7, lastHandledMsgId: null });
  await s2.update({ lastHandledMsgId: 'msg_1' });
  assert.equal((await createStateStore({ dir: config.dataDir }).load()).lastHandledMsgId, 'msg_1');
  await fs.writeFile(s1.file, JSON.stringify({ activeTargetId: 'a', lastHandledTurnSeq: 7, lastHandledMsgId: 5 }));
  await assert.rejects(createStateStore({ dir: config.dataDir }).load(), { code: 'STORE_CORRUPT' });
  await fs.writeFile(s1.file, JSON.stringify({ activeTargetId: 3, lastHandledTurnSeq: 'x' }));
  await assert.rejects(s2.load(), { code: 'STORE_CORRUPT' });
});

test('interleaved stateStore updates leave the file at the last update', async (t) => {
  const { root, config } = await setup();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createStateStore({ dir: config.dataDir });
  await store.load();
  const updates = [];
  for (let i = 0; i < 50; i++) updates.push(store.update(i % 2 ? { lastHandledTurnSeq: i } : { activeTargetId: `c-${i}` }));
  await Promise.all(updates);
  assert.deepEqual(JSON.parse(await fs.readFile(store.file, 'utf8')), { activeTargetId: 'c-48', lastHandledTurnSeq: 49, lastHandledMsgId: null });
  assert.deepEqual(store.get(), { activeTargetId: 'c-48', lastHandledTurnSeq: 49, lastHandledMsgId: null });
  assert.deepEqual((await fs.readdir(config.dataDir)).sort(), ['state.json'], 'no temp files left');
});

test('stateStore writes land in update order even when writes finish out of order', async (t) => {
  const { root, config } = await setup();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // Each write completes only when released; the driver releases whatever is
  // pending newest-first, so any overlap between writes would let an older
  // snapshot land last.
  let disk = null;
  const pending = [];
  const write = (_file, data) => new Promise((resolve) => pending.push(() => { disk = data; resolve(); }));
  const store = createStateStore({ dir: config.dataDir, write });
  const updates = [];
  for (let i = 0; i < 20; i++) updates.push(store.update({ lastHandledTurnSeq: i }));
  let done = false;
  const all = Promise.all(updates).then(() => { done = true; });
  let maxInFlight = 0;
  while (!done) {
    await new Promise((r) => setImmediate(r));
    maxInFlight = Math.max(maxInFlight, pending.length);
    while (pending.length) pending.pop()();
  }
  await all;
  assert.equal(maxInFlight, 1, 'one write in flight at a time');
  assert.deepEqual(JSON.parse(disk), { activeTargetId: null, lastHandledTurnSeq: 19, lastHandledMsgId: null });
});
