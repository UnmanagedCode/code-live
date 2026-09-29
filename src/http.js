// Request/response helpers: security headers on every response, JSON bodies,
// and static files from public/ served from a fixed allowlist.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_BODY = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function securityHeaders(geminiWsUrl) {
  const geminiOrigin = new URL(geminiWsUrl).origin;
  return {
    'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' ${geminiOrigin}; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
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
// no request path is ever joined onto the filesystem.
export async function loadStaticFiles(dir) {
  const files = new Map();
  for (const name of await fs.readdir(dir)) {
    const ext = path.extname(name);
    if (!MIME[ext]) continue;
    files.set('/' + name, { file: path.join(dir, name), type: MIME[ext] });
  }
  const index = files.get('/index.html');
  if (index) files.set('/', index);
  return files;
}

export async function sendStatic(res, entry, headers) {
  const data = await fs.readFile(entry.file);
  res.writeHead(200, { ...headers, 'content-type': entry.type, 'content-length': data.length });
  res.end(data);
}
