// Mints single-use Gemini Live ephemeral tokens. This is the only module that
// reads the API key; every error it surfaces has the key scrubbed out.
import { getModel } from './models.js';
import { buildSetup } from './liveSetup.js';

const HANDLE_RE = /^[A-Za-z0-9_-]{1,256}$/;
const EXPIRE_MS = 30 * 60 * 1000;
const NEW_SESSION_MS = 60 * 1000;

function err(code, status, message) {
  return Object.assign(new Error(message), { code, status });
}

// RFC3339 without fractional seconds, as the auth_tokens endpoint expects.
function iso(t) {
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const MIN_LEAK = 8;

// Redacts every run of MIN_LEAK or more characters copied from the key, so an
// upstream message echoing the key, or part of it, cannot pass through.
function scrub(text, key) {
  const str = String(text);
  if (!key) return str;
  let out = '';
  let i = 0;
  while (i < str.length) {
    let len = 0;
    while (i + len < str.length && key.includes(str.slice(i, i + len + 1))) len++;
    if (len >= MIN_LEAK) { out += '[redacted]'; i += len; }
    else { out += str[i]; i++; }
  }
  return out;
}

export function createGemini({ base, wsUrl, keyStore, now = () => Date.now(), fetchImpl = fetch }) {
  return {
    async mintToken({ modelId, resumeHandle } = {}) {
      if (typeof modelId !== 'string' || !getModel(modelId)) throw err('UNKNOWN_MODEL', 400, `unknown model: ${String(modelId)}`);
      if (resumeHandle !== undefined && resumeHandle !== null && (typeof resumeHandle !== 'string' || !HANDLE_RE.test(resumeHandle))) {
        throw err('INVALID_ARGS', 400, 'resumeHandle is malformed');
      }
      const key = await keyStore.get();
      if (!key) throw err('NO_API_KEY', 409, 'No Gemini API key is set; add one in Settings');

      const t = now();
      const expireTime = iso(t + EXPIRE_MS);
      const body = {
        uses: 1,
        expireTime,
        newSessionExpireTime: iso(t + NEW_SESSION_MS),
        bidiGenerateContentSetup: buildSetup(modelId, resumeHandle || undefined),
      };
      let res, data;
      try {
        res = await fetchImpl(`${base}/v1beta/auth_tokens`, {
          method: 'POST',
          headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        });
        data = await res.json().catch(() => null);
      } catch (e) {
        throw err('GEMINI_ERROR', 502, scrub(`Gemini token mint failed: ${e?.message ?? e}`, key));
      }
      if (!res.ok) {
        const upstream = data?.error?.message ?? res.statusText ?? 'no message';
        throw err('GEMINI_ERROR', 502, scrub(`Gemini token mint failed (${res.status}): ${upstream}`, key));
      }
      if (typeof data?.name !== 'string' || !data.name) throw err('GEMINI_ERROR', 502, 'Gemini token mint returned no token');
      return { token: data.name, wsUrl, model: modelId, expireTime };
    },
  };
}
