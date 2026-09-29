// Fake Gemini API: the auth_tokens mint endpoint and the Live WebSocket.
// Server frames go out as binary JSON, like the real API.
import http from 'node:http';
import { WebSocketServer } from 'ws';

export const LIVE_PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

export async function startFakeGemini() {
  const requests = [];
  const sessions = [];
  const issued = new Set();
  const sessionWaiters = [];
  let mintFailure = null;
  let connectMode = 'ok';
  let n = 0;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.method === 'POST' && req.url === '/v1beta/auth_tokens') {
      if (mintFailure) {
        res.writeHead(mintFailure.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(mintFailure.body));
        return;
      }
      const name = `auth_tokens/fake-${++n}`;
      issued.add(name);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== LIVE_PATH) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const token = url.searchParams.get('access_token');
      if (!issued.has(token) || connectMode === 'reject') { ws.close(1008, 'invalid token'); return; }
      issued.delete(token); // single use
      const messages = [];
      const waiters = [];
      const session = {
        token,
        messages,
        send: (obj) => ws.send(Buffer.from(JSON.stringify(obj)), { binary: true }),
        close: (code = 1000, reason) => ws.close(code, reason),
        // Resolves with the next (or an already received, unconsumed) client
        // message matching `predicate`.
        next(predicate = () => true) {
          const hit = messages.find((m) => !m._taken && predicate(m));
          if (hit) { hit._taken = true; return Promise.resolve(hit); }
          return new Promise((resolve) => waiters.push({ predicate, resolve }));
        },
        closed: new Promise((resolve) => ws.on('close', (code) => resolve(code))),
      };
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
        Object.defineProperty(msg, '_taken', { value: false, writable: true, enumerable: false });
        messages.push(msg);
        if (msg.setup && connectMode !== 'silent') session.send({ setupComplete: {} });
        const i = waiters.findIndex((w) => w.predicate(msg));
        if (i >= 0) { msg._taken = true; waiters.splice(i, 1)[0].resolve(msg); }
      });
      sessions.push(session);
      for (const w of sessionWaiters.splice(0)) w();
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    requests,
    sessions,
    setMintFailure(f) { mintFailure = f; },
    // 'ok' | 'reject' (close before setupComplete) | 'silent' (never send setupComplete)
    setConnectMode(m) { connectMode = m; },
    async session(i) {
      while (sessions.length <= i) await new Promise((r) => sessionWaiters.push(r));
      return sessions[i];
    },
    async close() {
      for (const c of wss.clients) c.terminate();
      await new Promise((r) => server.close(r));
    },
  };
}
