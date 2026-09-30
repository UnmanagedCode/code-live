// Fake code-conductor host: the REST routes code-live calls, the /ws hub
// (prompt → ack, turn_notification and instances broadcasts) and the bare
// `POST /mcp` tools/call endpoint, shaped as cc's MCP server replies.
import http from 'node:http';
import { WebSocketServer } from 'ws';

const asText = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
// Envelope helpers for setMcp handlers.
export const mcpOk = asText;
export const mcpSoft = (code, reason, extra = {}) => asText({ ok: false, code, reason, ...extra });
export const mcpThrown = (prose, extra = {}) => ({ content: [{ type: 'text', text: prose }, { type: 'text', text: JSON.stringify({ error: prose, ...extra }) }], isError: true });

function proseOf(ev) {
  const blocks = Array.isArray(ev.message?.content) ? ev.message.content : [];
  const text = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  return text.trim() === '' ? '' : text;
}

function renderQuestions(questions) {
  const lines = ['--- questions ---'];
  questions.forEach((q, i) => {
    lines.push(`${i + 1}. ${q.question} (multiSelect: ${!!q.multiSelect})${q.header ? ` · header: ${q.header}` : ''}`);
    for (const o of q.options ?? []) lines.push(`   - ${o.label}${o.description ? `: ${o.description}` : ''}`);
  });
  return lines.join('\n');
}

// The text-bearing assistant messages of an event ring, like cc's
// reconstructMessages: a user_question / plan_request attaches to the
// assistant message before it, and `turn` counts the turn_ends before it.
function reconstruct(events) {
  const messages = [];
  let turn = 0;
  let last = null;
  for (const ev of events) {
    if (ev.kind === 'assistant_message') {
      last = { msgId: ev.msgId ?? `m${ev._seq}`, text: proseOf(ev), turn };
      messages.push(last);
    } else if (ev.kind === 'user_question' && last) last.questions = ev.questions;
    else if (ev.kind === 'plan_request' && last) { last.plan = ev.plan ?? null; last.planPath = ev.planPath ?? null; last.hasPlan = true; }
    else if (ev.kind === 'turn_end') turn++;
  }
  return messages.filter((m) => m.text || m.questions || m.hasPlan);
}

function renderBody(m) {
  const parts = [];
  if (m.text) parts.push(m.text);
  if (m.hasPlan) parts.push(`${m.planPath ? `--- plan · saved to ${m.planPath} ---` : '--- plan ---'}${m.plan ? `\n${m.plan}` : ''}`);
  if (m.questions) parts.push(renderQuestions(m.questions));
  return parts.join('\n');
}

// cc's default get_recent_messages selection: the last message, bonded back to
// its own turn's plan/questions message; an explicit count is literal.
function selectMessages(all, count) {
  if (count !== undefined) return all.slice(-count);
  const last = all.at(-1);
  if (!last) return [];
  if (last.questions || last.hasPlan) return [last];
  const from = all.findIndex((m) => m.turn === last.turn && (m.questions || m.hasPlan));
  return from >= 0 ? all.slice(from) : [last];
}

export async function startFakeHost({ instances = [], events = {}, port = 0 } = {}) {
  const state = { instances: instances.map((i) => ({ ...i })), events: {} };
  const seqs = {};
  const requests = [];
  const prompts = [];
  const promptHooks = [];
  const mcpCalls = [];
  const mcpHandlers = {};
  let ackMode = 'ok';
  let created = 0;

  // The default get_recent_messages: derived from the instance's event ring.
  function recentMessages({ sessionId, count }) {
    const inst = state.instances.find((i) => i.sessionId === sessionId);
    if (!inst) return mcpSoft('SESSION_NOT_LIVE', `no live session ${sessionId}`);
    const msgs = selectMessages(reconstruct(state.events[inst.id] ?? []), count);
    const meta = {
      sessionId,
      messages: msgs.map((m, index) => ({
        index, msgId: m.msgId, hasToolUse: false, textChars: m.text.length, textTruncated: false,
        ...(m.hasPlan ? { hasPlan: true } : {}),
        ...(m.planPath ? { planPath: m.planPath } : {}),
        ...(m.questions ? { questionCount: m.questions.length } : {}),
      })),
      source: 'ring', omittedToolOnly: 0, retained: { firstSeq: 0, lastSeq: seqs[inst.id] ?? -1, trimmed: false },
    };
    const bodies = msgs.map((m, i) => (msgs.length > 1 ? `--- message ${i + 1}/${msgs.length} · ${m.msgId} · ${m.text.length} chars ---\n` : '') + renderBody(m));
    return { content: [{ type: 'text', text: JSON.stringify(meta) }, ...bodies.map((text) => ({ type: 'text', text }))] };
  }

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
    if (req.method === 'POST' && url.pathname === '/mcp') {
      if (body?.jsonrpc !== '2.0' || body.method !== 'tools/call' || typeof body.params?.name !== 'string' || body.id === undefined) {
        return json(res, 200, { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32600, message: 'invalid request' } });
      }
      const { name, arguments: args } = body.params;
      mcpCalls.push({ name, arguments: args, url: req.url, id: body.id });
      const handler = mcpHandlers[name] ?? (name === 'get_recent_messages' ? recentMessages : null);
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
    mcpCalls,
    addEvent,
    // Installs a tools/call handler: (args) => envelope (mcpOk / mcpSoft / mcpThrown).
    setMcp(name, fn) { mcpHandlers[name] = fn; },
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
    // Patches an instance row, e.g. { awaitingUser: 'question', awaitingUserSource: 'tool' }.
    setRow(id, patch) { Object.assign(state.instances.find((i) => i.id === id), patch); },
    // Appends a turn that ends on AskUserQuestion (`questions`) or ExitPlanMode
    // (`plan`, `planPath`), sets the row's awaiting-user fields as the host
    // does, and notifies. A suppressed turn (notify:false) sends only the
    // `instances` frame, as the host does for a conductor waiting on a worker.
    // `frames:false` sends no /ws frame at all. `row` overrides the awaiting-user fields (e.g. null/'text' for an
    // auto-approved plan or a prose-only ask).
    finishAsk(id, { kind, questions, plan = null, planPath = null, prose = 'Before I continue:', notify = true, frames = true, row: rowPatch = { awaitingUser: kind, awaitingUserSource: 'tool' } }) {
      addEvent(id, { kind: 'assistant_message', msgId: `m${(seqs[id] ?? 0) + 1}`, message: { content: [{ type: 'text', text: prose }] } });
      if (kind === 'question') addEvent(id, { kind: 'user_question', toolUseId: `tu${seqs[id]}`, questions });
      else addEvent(id, { kind: 'plan_request', toolUseId: `tu${seqs[id]}`, plan, planPath });
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
