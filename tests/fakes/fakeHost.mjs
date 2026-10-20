// Fake code-conductor host: the REST routes code-live calls (the events route
// pages like the host's: trailing, `before` and `after` windows), the /ws hub
// (prompt → ack, turn_notification and instances broadcasts) and the bare
// `POST /mcp` tools/call endpoint for the write tools, shaped as cc's MCP
// server replies.
import http from 'node:http';
import { WebSocketServer } from 'ws';

const asText = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
// Envelope helpers for setMcp handlers.
export const mcpOk = asText;
export const mcpSoft = (code, reason, extra = {}) => asText({ ok: false, code, reason, ...extra });
export const mcpThrown = (prose, extra = {}) => ({ content: [{ type: 'text', text: prose }, { type: 'text', text: JSON.stringify({ error: prose, ...extra }) }], isError: true });

// The host's page cap, and the page it serves when no limit is given.
const LIMIT_MAX = 500;
const LIMIT_DEFAULT = 200;

// Events as the host serves them from disk (below the ring): replayed deltas,
// no assistant_message and no message_start.
const isArchiveKind = (ev) => ev.kind !== 'assistant_message' && ev.kind !== 'message_start';

// One page of an event list like the host's pageInstanceEvents: no cursor is the
// trailing page; `before` the events right before that seq; `after` the first
// events after it (exclusive). `nextBefore` is the first served seq. Exact
// windows: the host's snap to a quiescent index is not modelled.
function pageEvents(all, { before, after, limit, archiveBelow }) {
  const max = Math.min(Math.max(limit || LIMIT_DEFAULT, 1), LIMIT_MAX);
  const lastSeq = all.at(-1)?._seq ?? 0;
  let served;
  let hasMore;
  if (before == null && after == null) before = lastSeq + 1;
  if (before != null) {
    const older = all.filter((ev) => ev._seq < before);
    served = older.slice(-max);
    hasMore = older.length > served.length;
  } else {
    const newer = all.filter((ev) => ev._seq > after);
    served = newer.slice(0, max);
    hasMore = newer.length > served.length;
  }
  if (archiveBelow != null) {
    const out = [];
    for (const ev of served) {
      if (ev._seq < archiveBelow && !isArchiveKind(ev)) continue;
      // The seam between disk and ring: a seq-less gap marker, as the host serves.
      if (ev._seq >= archiveBelow && out.length && out.at(-1)._seq < archiveBelow) out.push({ kind: 'history_gap' });
      out.push(ev);
    }
    served = out;
  }
  const first = served.find((ev) => typeof ev._seq === 'number');
  return { events: served, hasMore, nextBefore: first ? first._seq : null, trimmedBefore: 0, lastSeq };
}

export async function startFakeHost({ instances = [], events = {}, port = 0 } = {}) {
  // `eventsGone` ids stay listed but their events route answers 404.
  const state = { instances: instances.map((i) => ({ ...i })), events: {}, eventsGone: new Set() };
  const seqs = {};
  const requests = [];
  const prompts = [];
  const promptHooks = [];
  const mcpCalls = [];
  const mcpHandlers = {};
  const archiveBelow = new Map();
  let toolUses = 0;
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

  // Appends one streamed text message (none for an empty `text`) and returns its
  // msgId.
  function streamMessage(id, text) {
    const msgId = `m${(seqs[id] ?? 0) + 1}`;
    addEvent(id, { kind: 'message_start', msgId });
    if (text) {
      addEvent(id, { kind: 'text_delta', msgId, blockIdx: 0, text });
      addEvent(id, { kind: 'text_end', msgId, blockIdx: 0 });
      addEvent(id, { kind: 'assistant_message', msgId, blockIdx: 0, message: { content: [{ type: 'text', text }] } });
    }
    return msgId;
  }

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
    if (req.method === 'POST' && url.pathname === '/mcp') {
      if (body?.jsonrpc !== '2.0' || body.method !== 'tools/call' || typeof body.params?.name !== 'string' || body.id === undefined) {
        return json(res, 200, { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32600, message: 'invalid request' } });
      }
      const { name, arguments: args } = body.params;
      mcpCalls.push({ name, arguments: args, url: req.url, id: body.id });
      const handler = mcpHandlers[name] ?? null;
      if (!handler) return json(res, 200, { jsonrpc: '2.0', id: body.id, result: mcpThrown(`unknown tool: ${name}`) });
      const result = await handler(args ?? {});
      return json(res, 200, { jsonrpc: '2.0', id: body.id, result });
    }
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
      if (!state.instances.some((i) => i.id === id) || state.eventsGone.has(id)) return json(res, 404, { error: 'unknown instance' });
      const num = (key) => (url.searchParams.has(key) ? Number(url.searchParams.get(key)) : null);
      const page = pageEvents(state.events[id] ?? [], { before: num('before'), after: num('after'), limit: num('limit'), archiveBelow: archiveBelow.get(id) });
      return json(res, 200, { id, ...page });
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
    mcpCalls,
    addEvent,
    // Installs a tools/call handler: (args) => envelope (mcpOk / mcpSoft / mcpThrown).
    setMcp(name, fn) { mcpHandlers[name] = fn; },
    setAckMode(mode) { ackMode = mode; },
    onPrompt(hook) { promptHooks.push(hook); },
    broadcast(frame) { for (const c of wss.clients) c.send(JSON.stringify(frame)); },
    clientCount: () => wss.clients.size,
    dropConnections() { for (const c of wss.clients) c.terminate(); },
    // Appends a finished turn (reply + turn_end) and returns the turn_end. The
    // reply is a message as the live host streams it: message_start, one
    // text_delta and text_end, and the reconciled assistant_message envelope,
    // all under one msgId (`m<seq of its first event>`).
    finishTurn(id, text, { notify = true } = {}) {
      streamMessage(id, text);
      const end = addEvent(id, { kind: 'turn_end', isError: false, stopReason: 'end_turn' });
      if (notify) this.broadcast({ t: 'turn_notification', id, project: '.conduct', isError: false, stopReason: 'end_turn', cost: 0.01 });
      return end;
    },
    // Patches an instance row, e.g. { awaitingUser: 'question', awaitingUserSource: 'tool' }.
    setRow(id, patch) { Object.assign(state.instances.find((i) => i.id === id), patch); },
    // Appends a turn that ends on AskUserQuestion (`questions`) or ExitPlanMode
    // (`plan`, `planPath`), sets the row's awaiting-user fields as the host
    // does, and notifies. A suppressed turn (notify:false) sends only the
    // `instances` frame, as the host does for a conductor waiting on a worker.
    // `frames:false` sends no /ws frame at all. `autoApproved` marks the plan_request event as the host auto-approved it. `row` overrides the awaiting-user fields (e.g. null/'text' for an
    // auto-approved plan or a prose-only ask).
    finishAsk(id, { kind, questions, plan = null, planPath = null, autoApproved = false, inputPlan = true, prose = 'Before I continue:', notify = true, frames = true, row: rowPatch = { awaitingUser: kind, awaitingUserSource: 'tool' } }) {
      const msgId = streamMessage(id, prose);
      const toolUseId = `tu${++toolUses}`;
      const isPlan = kind !== 'question';
      const input = isPlan ? (inputPlan && plan ? { plan } : {}) : { questions };
      const name = isPlan ? 'ExitPlanMode' : 'AskUserQuestion';
      addEvent(id, { kind: 'tool_use', msgId, blockIdx: 1, toolUseId, name, input });
      addEvent(id, { kind: 'assistant_message', msgId, blockIdx: 1, message: { content: [{ type: 'tool_use', id: toolUseId, name, input }] } });
      if (isPlan) addEvent(id, { kind: 'plan_request', toolUseId, plan, planPath, ...(autoApproved ? { autoApproved: true } : {}) });
      else addEvent(id, { kind: 'user_question', toolUseId, questions });
      const end = addEvent(id, { kind: 'turn_end', isError: false, stopReason: 'end_turn' });
      const row = state.instances.find((i) => i.id === id);
      Object.assign(row, rowPatch);
      row.lastResponseAt = (row.lastResponseAt ?? 0) + 1;
      if (frames) {
        if (notify) this.broadcast({ t: 'turn_notification', id, project: '.conduct', isError: false, stopReason: 'end_turn', cost: 0.01 });
        this.broadcast({ t: 'instances', instances: state.instances });
      }
      return end;
    },
    // Serves the events of `id` below `seq` as the host serves them from disk:
    // replayed deltas only (no assistant_message, no message_start), with a
    // history_gap marker at the seam.
    archiveBelow(id, seq) { archiveBelow.set(id, seq); },
    // Replays an instance's history into a fresh ring, as rewind, prune and
    // respawn do: `drop` filters events out, the rest are renumbered from 1.
    resetRing(id, { drop = () => false } = {}) {
      const kept = (state.events[id] ?? []).filter((ev) => !drop(ev));
      state.events[id] = kept.map((ev, i) => ({ ...ev, _seq: i + 1 }));
      seqs[id] = kept.length;
    },
    async close() {
      for (const c of wss.clients) c.terminate();
      await new Promise((r) => server.close(r));
    },
  };
}
