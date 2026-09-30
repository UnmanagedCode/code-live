// Shared test harness: a real code-live server wired to fake Gemini/host
// servers and a fresh temp PROJECTS_ROOT.
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildDeps, createServer } from '../server.js';

export const SENTINEL_KEY = 'fake-gemini-key-SENTINEL-0123456789abcdef';

export async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'code-live-test-'));
}

// Polls `fn` until it returns a truthy value (short, bounded waits only).
export async function waitFor(fn, { timeoutMs = 2000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Starts the app. `startLink` connects to the fake host's /ws and waits for
// the first open; `projectsRoot` reuses an existing root (restart tests).
export async function startApp({ gemini, host, projectsRoot, now, link = {}, startLink = true, reconcileOnStart = true } = {}) {
  const root = projectsRoot ?? await tempDir();
  const config = loadConfig({
    PROJECTS_ROOT: root,
    CONDUCTOR_URL: host ? host.url : 'http://127.0.0.1:9',
    CODE_LIVE_GEMINI_BASE: gemini ? gemini.base : 'http://127.0.0.1:9',
  });
  const deps = await buildDeps(config, { now, link: { baseDelayMs: 5, maxDelayMs: 40, ackTimeoutMs: 300, ...link } });
  const server = createServer(deps);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  if (startLink) {
    const opened = new Promise((r) => deps.link.once('open', r));
    deps.link.start();
    if (host) await opened;
  }
  if (reconcileOnStart) await deps.announcer.reconcile();
  return {
    url,
    deps,
    config,
    root,
    async stop({ keepRoot = false } = {}) {
      deps.link.stop();
      deps.sse.closeAll();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      if (!keepRoot) await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export async function req(url, { method = 'GET', body, headers = {}, raw } = {}) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined && raw === undefined ? { 'content-type': 'application/json', ...headers } : headers,
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, headers: res.headers, text, json };
}

export const callTool = (app, name, args) => req(`${app.url}/api/tools/call`, { method: 'POST', body: { name, args } }).then((r) => r.json);

// Minimal SSE client over node:http, parsing `id`/`event`/`data` frames.
export function sseClient(url, { lastEventId } = {}) {
  const events = [];
  const waiters = [];
  let request;
  let raw = '';
  const ready = new Promise((resolve, reject) => {
    request = http.get(url, { headers: lastEventId !== undefined ? { 'last-event-id': String(lastEventId) } : {} }, (res) => {
      resolve(res);
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = { id: undefined, event: 'message', data: '' };
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) continue;
            const [k, ...rest] = line.split(': ');
            const v = rest.join(': ');
            if (k === 'id') ev.id = v;
            else if (k === 'event') ev.event = v;
            else if (k === 'data') ev.data = JSON.parse(v);
          }
          events.push(ev);
          for (let w = waiters.length - 1; w >= 0; w--) {
            if (waiters[w].match(ev)) { waiters[w].resolve(ev); waiters.splice(w, 1); }
          }
        }
      });
    });
    request.on('error', reject);
  });
  return {
    events,
    ready,
    raw: () => raw,
    next(event, pred = () => true, { timeoutMs = 2000 } = {}) {
      const match = (ev) => ev.event === event && pred(ev.data);
      const seen = events.find((ev) => match(ev) && !ev._used);
      if (seen) { seen._used = true; return Promise.resolve(seen); }
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no SSE ${event} within ${timeoutMs}ms`)), timeoutMs);
        waiters.push({ match, resolve: (ev) => { clearTimeout(t); ev._used = true; resolve(ev); } });
      });
    },
    close() { request.destroy(); },
  };
}

export const CONDUCTOR_A = { id: 'cond-a', project: '.conduct', sessionId: 's-a', status: 'idle', displayStatus: 'idle', activeAgentTasks: 0, awaitingWake: false, title: 'Alpha plan', firstPrompt: 'plan alpha', lastResponseAt: 1, createdAt: 1 };
export const CONDUCTOR_B = { id: 'cond-b', project: '.conduct', sessionId: 's-b', status: 'turn', title: '', firstPrompt: 'Build the beta release pipeline and report back on everything that happened', lastResponseAt: 2, createdAt: 2 };
export const WORKER = { id: 'worker-1', project: 'code-live', sessionId: 's-w', status: 'idle', title: 'Alpha plan', firstPrompt: 'do work', lastResponseAt: 3, createdAt: 3 };
