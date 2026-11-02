// One-shot boot move of a store left at <PROJECTS_ROOT>/.code-live into
// CONDUCTOR_PLUGIN_DATA_DIR. This is the only code that names the legacy path.
// A refusal aborts boot rather than starting an empty store beside the legacy
// one. A refusal never moves or changes store data; it may leave an empty
// target removed, and empty parent dirs it created. The move is a single
// rename, so file and directory modes carry over and the key is never read.
// Delete this file and its call in server.js once no install keeps a legacy store.
import { promises as fs } from 'node:fs';
import path from 'node:path';

function refuse(legacy, target, detail, cause) {
  const e = new Error(`code-live: cannot move the store ${legacy} to ${target}: ${detail}`, cause ? { cause } : undefined);
  e.code = 'ESTOREMIGRATE';
  return e;
}

// Returns 'skipped' | 'absent' | 'same' | 'moved'; throws an ESTOREMIGRATE error on refusal.
export async function migrateLegacyStore({ env, dataDir, log = console, rename = fs.rename }) {
  if (!env.PROJECTS_ROOT) return 'skipped';
  const legacy = path.join(path.resolve(env.PROJECTS_ROOT), '.code-live');
  const target = dataDir;
  if (legacy === target) return 'same';
  const fix = 'fix its permissions, then restart code-live';

  let st;
  try {
    st = await fs.lstat(legacy);
  } catch (e) {
    if (e.code === 'ENOENT') return 'absent';
    throw refuse(legacy, target, `cannot inspect ${legacy}: ${e.message}; ${fix}`, e);
  }
  if (!st.isDirectory()) throw refuse(legacy, target, `${legacy} is not a directory; move or remove it, then restart code-live`);

  let tst = null;
  try {
    tst = await fs.lstat(target);
  } catch (e) {
    if (e.code !== 'ENOENT') throw refuse(legacy, target, `cannot inspect ${target}: ${e.message}; ${fix}`, e);
  }
  if (tst) {
    if (!tst.isDirectory()) throw refuse(legacy, target, `${target} exists and is not a directory; move or remove it, then restart code-live`);
    const notEmpty = refuse(legacy, target, `${target} is not empty, so nothing was moved. Keep one: delete ${legacy} to use ${target} as is, or delete ${target} to move ${legacy} on the next start`);
    let entries;
    try {
      entries = await fs.readdir(target);
    } catch (e) {
      throw refuse(legacy, target, `cannot inspect ${target}: ${e.message}; ${fix}`, e);
    }
    if (entries.length) throw notEmpty;
    try {
      await fs.rmdir(target);
    } catch (e) {
      if (e.code === 'ENOTEMPTY') throw notEmpty;
      throw refuse(legacy, target, `cannot replace the empty ${target}: ${e.message}; ${fix}`, e);
    }
  }

  const parent = path.dirname(target);
  try {
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw refuse(legacy, target, `cannot create ${parent}: ${e.message}; create it or fix its permissions, then restart code-live`, e);
  }

  try {
    await rename(legacy, target);
  } catch (e) {
    if (e.code === 'EXDEV') {
      throw refuse(legacy, target, `they are on different filesystems, so nothing was moved. With code-live stopped, run \`mv '${legacy}' '${target}'\` (keeps modes), then restart code-live`, e);
    }
    throw refuse(legacy, target, `${e.message}; nothing was moved. Move it yourself (\`mv\` keeps modes), then restart code-live`, e);
  }
  log.log(`code-live: moved the store from ${legacy} to ${target}`);
  return 'moved';
}
