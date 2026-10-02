// User preferences at <dataDir>/preferences.json: the Gemini voice (null is the
// model's default) and the custom instructions appended to the system prompt.
// get() reads the file on every call, and every token mint calls it, so a saved
// change applies from the next mint.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomicFile.js';
import { isVoice } from './voices.js';

export const CUSTOM_PROMPT_MAX = 4000;

const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/;

const corrupt = () => Object.assign(new Error('preferences.json is malformed'), { code: 'STORE_CORRUPT' });
const invalidPrompt = (message) => Object.assign(new Error(message), { code: 'INVALID_PROMPT' });

// Normalizes line endings and trims, then enforces the bound and the character
// set. Returns the text to store; throws INVALID_PROMPT.
function checkPrompt(text) {
  if (typeof text !== 'string') throw invalidPrompt('customPrompt must be a string');
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (normalized.length > CUSTOM_PROMPT_MAX) throw invalidPrompt(`custom instructions must be at most ${CUSTOM_PROMPT_MAX} characters`);
  if (CONTROL_RE.test(normalized)) throw invalidPrompt('custom instructions may not contain control characters');
  return normalized;
}

// `write` is injectable so tests can make write completion order observable.
export function createPrefsStore({ dir, write = writeFileAtomic }) {
  const file = path.join(dir, 'preferences.json');
  let writing = Promise.resolve(); // serializes read-merge-write so concurrent setters both land

  // One read tells an absent file (defaults) from a present one: a file holding the
  // JSON literal null is corrupt, which readJson's null return cannot distinguish.
  async function get() {
    let raw;
    try { raw = await fs.readFile(file, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') return { voice: null, customPrompt: '' };
      throw e;
    }
    let data;
    try { data = JSON.parse(raw); } catch { throw corrupt(); }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw corrupt();
    const voice = data.voice ?? null;
    if (voice !== null && !isVoice(voice)) throw corrupt();
    let customPrompt = data.customPrompt ?? '';
    try { customPrompt = checkPrompt(customPrompt); } catch { throw corrupt(); }
    return { voice, customPrompt };
  }

  function merge(patch) {
    const run = writing.catch(() => {}).then(async () => {
      const next = { ...await get(), ...patch };
      await write(file, JSON.stringify(next));
      return next;
    });
    writing = run;
    return run;
  }

  return {
    file,
    get,
    async setVoice(voice) {
      if (voice !== null && !isVoice(voice)) {
        throw Object.assign(new Error("voice must be one of the prebuilt voices, or null for the model's default"), { code: 'UNKNOWN_VOICE' });
      }
      return merge({ voice });
    },
    async setCustomPrompt(text) {
      return merge({ customPrompt: checkPrompt(text) });
    },
  };
}
