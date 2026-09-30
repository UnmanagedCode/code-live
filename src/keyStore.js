// The Gemini API key, stored at <dataDir>/secrets.json with mode 0600. get()
// is the only accessor that returns the key; everything user-facing uses
// status(), which exposes only the last four characters.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic, readJson } from './atomicFile.js';

const KEY_RE = /^[\x21-\x7e]+$/;

function corrupt() {
  return Object.assign(new Error('secrets.json is malformed'), { code: 'STORE_CORRUPT' });
}

export function createKeyStore({ dir }) {
  const file = path.join(dir, 'secrets.json');

  async function get() {
    const data = await readJson(file);
    if (data === null) return null;
    if (typeof data !== 'object' || typeof data.geminiApiKey !== 'string' || !data.geminiApiKey) throw corrupt();
    return data.geminiApiKey;
  }

  return {
    file,
    get,
    async status() {
      const key = await get();
      return { set: key !== null, tail: key === null ? null : key.slice(-4) };
    },
    async set(key) {
      const k = typeof key === 'string' ? key.trim() : '';
      if (k.length < 20 || k.length > 512 || !KEY_RE.test(k)) {
        // Never echo the submitted value.
        throw Object.assign(new Error('API key must be 20–512 printable non-space characters'), { code: 'INVALID_KEY' });
      }
      await writeFileAtomic(file, JSON.stringify({ geminiApiKey: k }));
    },
    async clear() {
      try { await fs.unlink(file); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    },
  };
}
