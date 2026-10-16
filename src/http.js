// Request/response helpers: security headers on every response, JSON bodies,
// and the built UI (frontend/dist) served from a fixed allowlist.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_BODY = 64 * 1024;

const MIME = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
};
// A servable file name: Vite's hashed `index-<base64url>.js` and the files
// copied from frontend/public/. One dot only, so no `.map` and no decoy names.
export const SERVED_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*\.(html|js|css)$/;
// The dist directories that are served: the root and Vite's assets/.
const SERVED_DIRS = ['', 'assets'];

export function securityHeaders(geminiWsUrl) {
  const geminiOrigin = new URL(geminiWsUrl).origin;
  return {
    'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self' ${geminiOrigin}; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  };
}

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res, status, body, headers) {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

export function sendText(res, status, text, headers) {
  res.writeHead(status, { ...headers, 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

export async function readJsonBody(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'request body must be application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'BODY_TOO_LARGE', 'request body exceeds 64 KB');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  try { return JSON.parse(raw); }
  catch { throw new HttpError(400, 'INVALID_JSON', 'request body is not valid JSON'); }
}

// Maps each servable URL path to a file in `dir`, built once from readdir so
// no request path is ever joined onto the filesystem. `built` is false when
// `dir` has no index.html (the UI was never built); nothing is served then.
export async function loadStaticFiles(dir) {
  const files = new Map();
  for (const sub of SERVED_DIRS) {
    let entries;
    try {
      entries = await fs.readdir(path.join(dir, sub), { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue;
      throw e;
    }
    for (const entry of entries) {
      const m = SERVED_NAME.exec(entry.name);
      if (!m || !entry.isFile()) continue;
      files.set(`/${sub ? `${sub}/` : ''}${entry.name}`, { file: path.join(dir, sub, entry.name), type: MIME[m[1]] });
    }
  }
  const index = files.get('/index.html');
  if (!index) return { files: new Map(), built: false };
  files.set('/', index);
  return { files, built: true };
}

export async function sendStatic(res, entry, headers) {
  const data = await fs.readFile(entry.file);
  res.writeHead(200, { ...headers, 'content-type': entry.type, 'content-length': data.length });
  res.end(data);
}
