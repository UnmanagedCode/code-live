// Pins: migrateLegacyStore moves <PROJECTS_ROOT>/.code-live into the data dir
// with one rename (modes and inode carry over), creates missing parents at
// 0700, is idempotent, and refuses every unsafe case with an ESTOREMIGRATE
// error naming both paths, without moving, copying or leaking the key. Boot
// (start) aborts on a refusal, and core reads the moved store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { migrateLegacyStore } from '../src/migrateLegacyStore.js';
import { loadConfig } from '../src/config.js';
import { buildDeps, start } from '../server.js';
import { SENTINEL_KEY, tempDir, fixtureDist } from './helpers.mjs';

const FILES = {
  'secrets.json': JSON.stringify({ geminiApiKey: SENTINEL_KEY }),
  'state.json': JSON.stringify({ watched: { 'cond-a': { lastHandledTurnSeq: 3, lastHandledMsgId: 'm1', lastHandledAskId: null } } }),
  'preferences.json': JSON.stringify({ voice: null, customPrompt: 'hi' }),
};
const quiet = { log() {} };

async function fixture(t, { legacy = true } = {}) {
  const root = await tempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacyDir = path.join(root, '.code-live');
  const dataDir = path.join(root, '.code-conductor', 'plugins', 'data', 'code-live');
  if (legacy) {
    await fs.mkdir(legacyDir);
    await fs.chmod(legacyDir, 0o700);
    for (const [name, text] of Object.entries(FILES)) {
      await fs.writeFile(path.join(legacyDir, name), text);
      await fs.chmod(path.join(legacyDir, name), 0o600);
    }
  }
  return { root, legacyDir, dataDir, env: { PROJECTS_ROOT: root } };
}

const mode = async (p) => (await fs.stat(p)).mode & 0o777;
const exists = (p) => fs.lstat(p).then(() => true, () => false);

async function secretsUnder(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await secretsUnder(p));
    else if (e.name === 'secrets.json') out.push(p);
  }
  return out;
}

async function assertLegacyIntact(f) {
  for (const [name, text] of Object.entries(FILES)) {
    assert.equal(await fs.readFile(path.join(f.legacyDir, name), 'utf8'), text);
    assert.equal(await mode(path.join(f.legacyDir, name)), 0o600);
  }
  assert.equal(await mode(f.legacyDir), 0o700);
  assert.deepEqual(await secretsUnder(f.root), [path.join(f.legacyDir, 'secrets.json')]);
}

function assertRefusal(e, f, { has = [] } = {}) {
  assert.equal(e.code, 'ESTOREMIGRATE');
  assert.ok(e.message.includes(f.legacyDir), 'names the legacy path');
  assert.ok(e.message.includes(f.dataDir), 'names the target path');
  for (const s of has) assert.ok(e.message.includes(s), s);
  assert.ok(!e.message.includes(SENTINEL_KEY), 'never echoes the key');
  return true;
}

test('moves the store with one rename: contents, modes and inode carry over', async (t) => {
  const f = await fixture(t);
  const ino = (await fs.stat(f.legacyDir)).ino;
  assert.equal(await migrateLegacyStore({ env: f.env, dataDir: f.dataDir, log: quiet }), 'moved');
  assert.equal(await exists(f.legacyDir), false);
  for (const [name, text] of Object.entries(FILES)) assert.equal(await fs.readFile(path.join(f.dataDir, name), 'utf8'), text);
  assert.equal(await mode(path.join(f.dataDir, 'secrets.json')), 0o600);
  assert.equal(await mode(f.dataDir), 0o700);
  assert.equal((await fs.stat(f.dataDir)).ino, ino);
});

test('missing parents are created at 0700', async (t) => {
  const f = await fixture(t);
  await migrateLegacyStore({ env: f.env, dataDir: f.dataDir, log: quiet });
  const cc = path.join(f.root, '.code-conductor');
  for (const p of [cc, path.join(cc, 'plugins'), path.join(cc, 'plugins', 'data')]) assert.equal(await mode(p), 0o700, p);
});

test('an existing parent keeps its mode', async (t) => {
  const f = await fixture(t);
  const plugins = path.join(f.root, '.code-conductor', 'plugins');
  await fs.mkdir(plugins, { recursive: true });
  await fs.chmod(plugins, 0o755);
  await migrateLegacyStore({ env: f.env, dataDir: f.dataDir, log: quiet });
  assert.equal(await mode(plugins), 0o755);
});

test('a second run is a no-op that reports absent', async (t) => {
  const f = await fixture(t);
  await migrateLegacyStore({ env: f.env, dataDir: f.dataDir, log: quiet });
  assert.equal(await migrateLegacyStore({ env: f.env, dataDir: f.dataDir, log: quiet }), 'absent');
  assert.equal(await fs.readFile(path.join(f.dataDir, 'secrets.json'), 'utf8'), FILES['secrets.json']);
});

test('no legacy dir: absent, and neither target nor parent is created', async (t) => {
  const f = await fixture(t, { legacy: false });
  assert.equal(await migrateLegacyStore({ env: f.env, dataDir: f.dataDir, log: quiet }), 'absent');
  assert.equal(await exists(path.dirname(f.dataDir)), false);
  assert.equal(await exists(f.dataDir), false);
});

test('no PROJECTS_ROOT (unset or empty): skipped, nothing touched', async (t) => {
  const f = await fixture(t);
  for (const env of [{}, { PROJECTS_ROOT: '' }]) {
    assert.equal(await migrateLegacyStore({ env, dataDir: f.dataDir, log: quiet }), 'skipped');
  }
  assert.equal(await exists(path.join(f.root, '.code-conductor')), false);
  await assertLegacyIntact(f);
});

test('data dir equal to the legacy path: same, untouched', async (t) => {
  const f = await fixture(t);
  assert.equal(await migrateLegacyStore({ env: f.env, dataDir: f.legacyDir, log: quiet }), 'same');
  await assertLegacyIntact(f);
});

test('an empty target dir is replaced by the legacy store', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.dataDir, { recursive: true });
  // Fails when the destination exists at call time, so only an earlier rmdir lets the move succeed.
  const rename = async (from, to) => {
    if (await exists(to)) throw Object.assign(new Error('destination exists'), { code: 'EEXIST' });
    return fs.rename(from, to);
  };
  assert.equal(await migrateLegacyStore({ env: f.env, dataDir: f.dataDir, log: quiet, rename }), 'moved');
  assert.equal(await mode(path.join(f.dataDir, 'secrets.json')), 0o600);
  assert.equal(await mode(f.dataDir), 0o700);
  assert.equal(await exists(f.legacyDir), false);
});

test('a non-empty target is refused and nothing moves or copies', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.dataDir, { recursive: true });
  await fs.writeFile(path.join(f.dataDir, 'state.json'), '{"watched":{}}');
  await assert.rejects(migrateLegacyStore({ env: f.env, dataDir: f.dataDir, log: quiet }), (e) => assertRefusal(e, f, { has: ['delete'] }));
  await assertLegacyIntact(f);
  assert.deepEqual(await fs.readdir(f.dataDir), ['state.json']);
});

test('a file or symlink at the target is refused', async (t) => {
  for (const kind of ['file', 'symlink']) {
    const f = await fixture(t);
    await fs.mkdir(path.dirname(f.dataDir), { recursive: true });
    if (kind === 'file') await fs.writeFile(f.dataDir, 'x');
    else { await fs.mkdir(path.join(f.root, 'elsewhere')); await fs.symlink(path.join(f.root, 'elsewhere'), f.dataDir); }
    await assert.rejects(migrateLegacyStore({ env: f.env, dataDir: f.dataDir, log: quiet }), (e) => assertRefusal(e, f, { has: ['not a directory'] }), kind);
    await assertLegacyIntact(f);
    assert.equal((await fs.lstat(f.dataDir)).isSymbolicLink(), kind === 'symlink');
  }
});

test('a file or symlink as the legacy path is refused and nothing is created', async (t) => {
  for (const kind of ['file', 'symlink']) {
    const f = await fixture(t, { legacy: false });
    if (kind === 'file') await fs.writeFile(f.legacyDir, 'x');
    else { await fs.mkdir(path.join(f.root, 'elsewhere')); await fs.symlink(path.join(f.root, 'elsewhere'), f.legacyDir); }
    await assert.rejects(migrateLegacyStore({ env: f.env, dataDir: f.dataDir, log: quiet }), (e) => assertRefusal(e, f, { has: ['not a directory'] }), kind);
    assert.equal(await exists(path.join(f.root, '.code-conductor')), false);
  }
});

test('an uninspectable legacy path is refused, never reported absent', async (t) => {
  const root = await tempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const notDir = path.join(root, 'file');
  await fs.writeFile(notDir, 'x');
  const f = { legacyDir: path.join(notDir, '.code-live'), dataDir: path.join(root, 'data', 'code-live') };
  await assert.rejects(migrateLegacyStore({ env: { PROJECTS_ROOT: notDir }, dataDir: f.dataDir, log: quiet }), (e) => assertRefusal(e, f, { has: ['cannot inspect'] }));
  assert.equal(await exists(path.join(root, 'data')), false);
});

test('an uninspectable target is refused and the legacy store is untouched', async (t) => {
  const f = await fixture(t);
  const notDir = path.join(f.root, 'file');
  await fs.writeFile(notDir, 'x');
  f.dataDir = path.join(notDir, 'code-live');
  await assert.rejects(migrateLegacyStore({ env: f.env, dataDir: f.dataDir, log: quiet }), (e) => assertRefusal(e, f, { has: ['cannot inspect'] }));
  await assertLegacyIntact(f);
});

test('EXDEV is refused with an mv hint and the legacy store is intact', async (t) => {
  const f = await fixture(t);
  const rename = async () => { throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }); };
  await assert.rejects(migrateLegacyStore({ env: f.env, dataDir: f.dataDir, log: quiet, rename }), (e) => {
    assert.equal(e.cause.code, 'EXDEV');
    return assertRefusal(e, f, { has: ["mv '"] });
  });
  await assertLegacyIntact(f);
  assert.equal(await exists(path.join(f.dataDir, 'secrets.json')), false);
});

test('any other rename error is refused and the legacy store is intact', async (t) => {
  const f = await fixture(t);
  const rename = async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); };
  await assert.rejects(migrateLegacyStore({ env: f.env, dataDir: f.dataDir, log: quiet, rename }), (e) => assertRefusal(e, f, { has: ['permission denied'] }));
  await assertLegacyIntact(f);
});

test('start() aborts on a refusal before listening, leaving both dirs unchanged', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.dataDir, { recursive: true });
  // A corrupt state.json makes buildDeps fail with STORE_CORRUPT, so only a migration that runs first yields ESTOREMIGRATE.
  await fs.writeFile(path.join(f.dataDir, 'state.json'), '{not json');
  const env = { ...f.env, CONDUCTOR_PLUGIN_DATA_DIR: f.dataDir, CONDUCTOR_URL: 'http://127.0.0.1:9', PORT: '0' };
  await assert.rejects(start(env), (e) => assertRefusal(e, f));
  await assertLegacyIntact(f);
  assert.deepEqual(await fs.readdir(f.dataDir), ['state.json']);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), '{not json');
});

test('start() validates config before migrating', async (t) => {
  const f = await fixture(t);
  const env = { ...f.env, CONDUCTOR_PLUGIN_DATA_DIR: 'relative/code-live', CONDUCTOR_URL: 'http://127.0.0.1:9' };
  await assert.rejects(start(env), /absolute/);
  await assertLegacyIntact(f);
});

test('core reads the moved store and nothing reads the legacy path', async (t) => {
  const f = await fixture(t);
  const dist = await fixtureDist();
  t.after(() => fs.rm(dist, { recursive: true, force: true }));
  const env = { ...f.env, CONDUCTOR_PLUGIN_DATA_DIR: f.dataDir, CONDUCTOR_URL: 'http://127.0.0.1:9' };
  const config = loadConfig(env);
  await migrateLegacyStore({ env, dataDir: config.dataDir, log: quiet });
  const deps = await buildDeps(config, { distDir: dist });
  assert.deepEqual(await deps.keyStore.status(), { set: true, tail: SENTINEL_KEY.slice(-4) });
  assert.deepEqual(Object.keys(deps.state.get().watched), ['cond-a']);
  assert.equal(deps.keyStore.file, path.join(f.dataDir, 'secrets.json'));
});
