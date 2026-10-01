// code-live backend entry: builds the collaborators and serves the API and the
// frontend. Feature logic lives in src/.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './src/config.js';
import { createKeyStore } from './src/keyStore.js';
import { createStateStore } from './src/stateStore.js';
import { createGemini } from './src/gemini.js';
import { createCcApi } from './src/ccApi.js';
import { createCcLink } from './src/ccLink.js';
import { createHostMcp } from './src/hostMcp.js';
import { createAnnouncer } from './src/announcer.js';
import { createConductorService } from './src/conductor.js';
import { createSseHub } from './src/sse.js';
import { securityHeaders, sendJson, readJsonBody, loadStaticFiles, sendStatic } from './src/http.js';
import { ROUTES } from './src/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const STATUS_BY_CODE = {
  INVALID_KEY: 400, INVALID_ARGS: 400, UNKNOWN_MODEL: 400, NO_API_KEY: 409,
  GEMINI_ERROR: 502, HOST_UNAVAILABLE: 502, HOST_HTTP_ERROR: 502, STORE_CORRUPT: 500,
};

// `opts` injects test seams: fetch, WebSocket, clock and link timings.
export async function buildDeps(config, opts = {}) {
  const keyStore = createKeyStore({ dir: config.dataDir });
  const state = createStateStore({ dir: config.dataDir });
  await state.load();
  const headers = securityHeaders(config.geminiWsUrl);
  const sse = createSseHub({ headers, ...(opts.sse ?? {}) });
  const publish = (event, data) => sse.publish(event, data);
  const api = createCcApi({ baseUrl: config.conductorUrl, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  const link = createCcLink({ url: config.hostWsUrl, ...(opts.link ?? {}) });
  const hostMcp = createHostMcp({ baseUrl: config.conductorUrl, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  const announcer = createAnnouncer({ api, link, state, publish, hostMcp });
  const service = createConductorService({ api, link, announcer, hostMcp });
  const gemini = createGemini({ base: config.geminiBase, wsUrl: config.geminiWsUrl, keyStore, ...(opts.now ? { now: opts.now } : {}) });
  link.on('open', () => publish('host', { connected: true }));
  link.on('close', () => publish('host', { connected: false }));
  return { config, headers, keyStore, state, sse, api, hostMcp, link, announcer, service, gemini, staticFiles: await loadStaticFiles(PUBLIC_DIR) };
}

export function createServer(deps) {
  const { headers } = deps;
  const table = new Map(ROUTES.map((r) => [`${r.method} ${r.path}`, r]));
  return http.createServer(async (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      // e.g. `//`, which URL parses as a host-less authority.
      return sendJson(res, 400, { error: 'malformed request target', code: 'BAD_REQUEST' }, headers);
    }
    try {
      const route = table.get(`${req.method} ${pathname}`);
      if (route) {
        const body = route.json ? await readJsonBody(req) : undefined;
        if (route.json && (body === null || typeof body !== 'object' || Array.isArray(body))) {
          return sendJson(res, 400, { error: 'request body must be a JSON object', code: 'INVALID_JSON' }, headers);
        }
        const out = await route.handler({ req, res, body, deps });
        if (out) sendJson(res, out.status ?? 200, out.body, headers);
        return;
      }
      const entry = req.method === 'GET' || req.method === 'HEAD' ? deps.staticFiles.get(pathname) : undefined;
      if (entry) return await sendStatic(res, entry, headers);
      sendJson(res, 404, { error: 'not found', code: 'NOT_FOUND' }, headers);
    } catch (e) {
      const status = e.status ?? STATUS_BY_CODE[e.code];
      if (!status) console.error('code-live: request failed:', req.method, pathname, e);
      if (res.headersSent) { res.end(); return; }
      sendJson(res, status ?? 500, status ? { error: e.message, code: e.code } : { error: 'internal error', code: 'INTERNAL_ERROR' }, headers);
    }
  });
}

// listen with retry-on-EADDRINUSE: a just-restarted backend may find the old
// listening socket lingering for a moment.
function listenWithRetry(server, port, host, { tries = 40, delayMs = 100 } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const onErr = (e) => {
        server.off('listening', onOk);
        if (e.code === 'EADDRINUSE' && left > 0) setTimeout(() => attempt(left - 1), delayMs);
        else reject(e);
      };
      const onOk = () => { server.off('error', onErr); resolve(); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(port, host);
    };
    attempt(tries);
  });
}

export async function start(env = process.env) {
  const config = loadConfig(env);
  const deps = await buildDeps(config);
  const server = createServer(deps);
  deps.link.start();
  deps.announcer.reconcileLogged();
  await listenWithRetry(server, config.port, config.host);
  console.log(`code-live listening on http://${config.host}:${server.address().port}`);
  process.once('SIGTERM', () => {
    deps.link.stop();
    deps.sse.closeAll();
    server.close(() => process.exit(0));
  });
  return { server, deps };
}

// Direct-run guard: only auto-start when invoked as `node server.js`.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch((e) => { console.error(e.message ?? e); process.exit(1); });
}
