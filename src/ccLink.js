// Persistent client for the host's /ws hub: sends prompt frames paired to
// their acks by reqId, and re-emits turn_notification broadcasts. Reconnects
// with capped exponential backoff; the host has no replay, so consumers
// reconcile over REST on every 'open'.
import { EventEmitter } from 'node:events';

function linkError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function createCcLink({
  url,
  WebSocketImpl = globalThis.WebSocket,
  baseDelayMs = 500,
  maxDelayMs = 10000,
  ackTimeoutMs = 10000,
  timers = { setTimeout, clearTimeout },
}) {
  const link = new EventEmitter();
  const pending = new Map(); // reqId -> {resolve, reject, timer}
  let ws = null;
  let stopped = true;
  let attempt = 0;
  let everOpened = false;
  let reconnectTimer = null;
  let counter = 0;

  function rejectAll(code, message) {
    for (const [reqId, p] of pending) {
      timers.clearTimeout(p.timer);
      pending.delete(reqId);
      p.reject(linkError(code, message));
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
    attempt++;
    reconnectTimer = timers.setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  function onFrame(raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')); }
    catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'ack') {
      const p = pending.get(msg.reqId);
      if (!p) return;
      pending.delete(msg.reqId);
      timers.clearTimeout(p.timer);
      if (msg.ok) p.resolve();
      else p.reject(linkError('HOST_REFUSED', `code-conductor refused the prompt: ${msg.error ?? 'no reason given'}`));
    } else if (msg.t === 'turn_notification') {
      link.emit('turn_notification', msg);
    }
  }

  function connect() {
    if (stopped) return;
    let sock;
    try { sock = new WebSocketImpl(url); }
    catch (e) { console.error('code-live: host /ws connect failed:', e?.message ?? e); scheduleReconnect(); return; }
    ws = sock;
    let closed = false;
    let opened = false;
    sock.addEventListener('open', () => {
      if (ws !== sock) return;
      opened = true;
      attempt = 0;
      const reconnect = everOpened;
      everOpened = true;
      link.emit('open', { reconnect });
    });
    sock.addEventListener('message', (ev) => { if (ws === sock) onFrame(ev.data); });
    const onDown = () => {
      if (closed || ws !== sock) return;
      closed = true;
      ws = null;
      rejectAll('HOST_DISCONNECTED', 'the connection to code-conductor dropped before the prompt was acknowledged');
      if (opened) link.emit('close');
      scheduleReconnect();
    };
    sock.addEventListener('close', onDown);
    sock.addEventListener('error', onDown);
  }

  link.start = () => {
    if (!stopped) return;
    stopped = false;
    connect();
  };

  link.stop = () => {
    stopped = true;
    if (reconnectTimer) { timers.clearTimeout(reconnectTimer); reconnectTimer = null; }
    const sock = ws;
    ws = null;
    rejectAll('HOST_DISCONNECTED', 'code-live is shutting down');
    if (sock) { try { sock.close(); } catch { /* already closed */ } }
  };

  link.isOpen = () => !!ws && ws.readyState === 1;

  link.prompt = (id, text) => {
    if (!link.isOpen()) return Promise.reject(linkError('HOST_UNAVAILABLE', 'code-live is not connected to code-conductor right now'));
    const reqId = `code-live-${++counter}`;
    return new Promise((resolve, reject) => {
      const timer = timers.setTimeout(() => {
        pending.delete(reqId);
        reject(linkError('ACK_TIMEOUT', 'code-conductor did not acknowledge the prompt in time'));
      }, ackTimeoutMs);
      pending.set(reqId, { resolve, reject, timer });
      try { ws.send(JSON.stringify({ t: 'prompt', id, text, reqId })); }
      catch (e) {
        pending.delete(reqId);
        timers.clearTimeout(timer);
        reject(linkError('HOST_UNAVAILABLE', `sending to code-conductor failed: ${e?.message ?? e}`));
      }
    });
  };

  return link;
}
