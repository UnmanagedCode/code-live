// Fake code-conductor host: the REST routes code-live calls and the /ws hub
// (prompt → ack, turn_notification broadcasts).
import http from 'node:http';
import { WebSocketServer } from 'ws';

export async function startFakeHost({ instances = [], events = {}, port = 0 } = {}) {
  const state = { instances: instances.map((i) => ({ ...i })), events: {} };
  const seqs = {};
  const requests = [];
  const prompts = [];
  const promptHooks = [];
  let ackMode = 'ok';
  let created = 0;

  function addEvent(id, ev) {
    const list = (state.events[id] ??= []);
    seqs[id] = (seqs[id] ?? 0) + 1;
    const withSeq = { ...ev, _seq: seqs[id] };
    list.push(withSeq);
    return withSeq;
  }
  for (const [id, list] of Object.entries(events)) for (const ev of list) addEvent(id, ev);

  function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, url: req.url, body });
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/api/instances') return json(res, 200, state.instances);
    if (req.method === 'POST' && url.pathname === '/api/projects/.conduct/ensure') return json(res, 200, { ok: true, path: '/fake/.conduct', created: false });
    if (req.method === 'POST' && url.pathname === '/api/instances') {
      const inst = { id: `new-conductor-${++created}`, project: '.conduct', sessionId: null, status: 'spawning', title: null, firstPrompt: null, lastResponseAt: null, createdAt: Date.now() };
      state.instances.push(inst);
      return json(res, 201, inst);
    }
    const m = url.pathname.match(/^\/api\/instances\/([^/]+)\/events$/);
    if (req.method === 'GET' && m) {
      const id = decodeURIComponent(m[1]);
      if (!state.instances.some((i) => i.id === id)) return json(res, 404, { error: 'unknown instance' });
      const limit = Number(url.searchParams.get('limit')) || 500;
      const all = state.events[id] ?? [];
      const evs = all.slice(-limit);
      return json(res, 200, { id, events: evs, hasMore: all.length > evs.length, nextBefore: null, trimmedBefore: 0, lastSeq: seqs[id] ?? 0 });
    }
    json(res, 404, { error: 'not found' });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.t !== 'prompt') return;
        prompts.push(msg);
        for (const hook of promptHooks) hook(msg);
        if (ackMode === 'silent') return;
        const known = state.instances.some((i) => i.id === msg.id);
        const ok = ackMode === 'ok' && known;
        ws.send(JSON.stringify({ t: 'ack', reqId: msg.reqId, ok, ...(ok ? {} : { error: known ? 'not running' : 'unknown instance' }) }));
      });
    });
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    state,
    requests,
    prompts,
    addEvent,
    setAckMode(mode) { ackMode = mode; },
    onPrompt(hook) { promptHooks.push(hook); },
    broadcast(frame) { for (const c of wss.clients) c.send(JSON.stringify(frame)); },
    clientCount: () => wss.clients.size,
    dropConnections() { for (const c of wss.clients) c.terminate(); },
    // Appends a finished turn (reply + turn_end) and returns the turn_end.
    finishTurn(id, text, { notify = true } = {}) {
      addEvent(id, { kind: 'assistant_message', msgId: `m${(seqs[id] ?? 0) + 1}`, message: { content: [{ type: 'text', text }] } });
      const end = addEvent(id, { kind: 'turn_end', isError: false, stopReason: 'end_turn' });
      if (notify) this.broadcast({ t: 'turn_notification', id, project: '.conduct', isError: false, stopReason: 'end_turn', cost: 0.01 });
      return end;
    },
    async close() {
      for (const c of wss.clients) c.terminate();
      await new Promise((r) => server.close(r));
    },
  };
}
