// Pins: the host /ws link reconnects with capped exponential backoff that
// resets after a successful open, pairs acks to prompts by reqId in any order,
// and never leaves a prompt hanging when the socket is down or drops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createCcLink } from '../src/ccLink.js';
import { waitFor } from './helpers.mjs';

const ACK_MS = 60000;

// A /ws server the test drives directly. Reusing `port` restarts it in place.
async function startWs(port = 0) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const received = [];
  const sockets = [];
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (d) => received.push(JSON.parse(d.toString())));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    port: server.address().port,
    received,
    send: (obj) => { for (const s of wss.clients) s.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); },
    drop: () => { for (const s of wss.clients) s.terminate(); },
    close: async () => { for (const s of wss.clients) s.terminate(); await new Promise((r) => server.close(r)); },
  };
}

// Records reconnect delays and runs them after 1 ms; ack timers run for real.
function recordingTimers() {
  const delays = [];
  return {
    delays,
    timers: {
      setTimeout: (fn, ms) => {
        if (ms === ACK_MS) { const t = setTimeout(fn, ms); t.unref(); return t; }
        delays.push(ms);
        return setTimeout(fn, 1);
      },
      clearTimeout: (t) => clearTimeout(t),
    },
  };
}

function makeLink(port, extra = {}) {
  return createCcLink({ url: `ws://127.0.0.1:${port}/ws`, baseDelayMs: 10, maxDelayMs: 50, ackTimeoutMs: ACK_MS, ...extra });
}

test('first open reports reconnect:false; later opens reconnect:true', async (t) => {
  const srv = await startWs();
  const link = makeLink(srv.port, { baseDelayMs: 1 });
  t.after(async () => { link.stop(); await srv.close(); });
  const opens = [];
  link.on('open', (e) => opens.push(e.reconnect));
  let closes = 0;
  link.on('close', () => closes++);
  link.start();
  await waitFor(() => opens.length === 1);
  srv.drop();
  await waitFor(() => opens.length === 2);
  assert.deepEqual(opens, [false, true]);
  assert.equal(closes, 1);
});

test('backoff doubles to the cap and resets after a successful open', async (t) => {
  const first = await startWs();
  const port = first.port;
  await first.close();
  const { delays, timers } = recordingTimers();
  const link = makeLink(port, { timers });
  let srv;
  t.after(async () => { link.stop(); await srv?.close(); });
  const opens = [];
  link.on('open', (e) => opens.push(e));
  let closes = 0;
  link.on('close', () => closes++);
  link.start();
  await waitFor(() => delays.length >= 5, { what: 'five failed attempts' });
  assert.deepEqual(delays.slice(0, 5), [10, 20, 40, 50, 50]);
  assert.equal(closes, 0, 'attempts that never opened emit no close');

  srv = await startWs(port);
  await waitFor(() => opens.length === 1, { what: 'open after restart' });
  assert.equal(link.isOpen(), true);
  delays.length = 0;
  srv.drop();
  await waitFor(() => opens.length === 2, { what: 'reopen after drop' });
  assert.equal(delays[0], 10, 'attempt counter reset after success');
  assert.equal(closes, 1, 'only the opened socket emitted close');
});

test('acks pair to prompts by reqId, in any order', async (t) => {
  const srv = await startWs();
  const link = makeLink(srv.port);
  t.after(async () => { link.stop(); await srv.close(); });
  link.start();
  await waitFor(() => link.isOpen());
  const p1 = link.prompt('inst-1', 'first');
  const p2 = link.prompt('inst-2', 'second');
  await waitFor(() => srv.received.length === 2);
  const [f1, f2] = srv.received;
  assert.deepEqual({ ...f1, reqId: undefined }, { t: 'prompt', id: 'inst-1', text: 'first', reqId: undefined });
  assert.notEqual(f1.reqId, f2.reqId);
  srv.send('not json');
  srv.send({ t: 'ack', reqId: 'someone-else', ok: false });
  srv.send({ t: 'hello' });
  srv.send({ t: 'ack', reqId: f2.reqId, ok: false, error: 'not running' });
  srv.send({ t: 'ack', reqId: f1.reqId, ok: true });
  await assert.rejects(p2, (e) => e.code === 'HOST_REFUSED' && /not running/.test(e.message));
  await p1;
});

test('turn_notification frames are re-emitted', async (t) => {
  const srv = await startWs();
  const link = makeLink(srv.port);
  t.after(async () => { link.stop(); await srv.close(); });
  const seen = [];
  link.on('turn_notification', (f) => seen.push(f));
  link.start();
  await waitFor(() => link.isOpen());
  srv.send({ t: 'turn_notification', id: 'c1', project: '.conduct', isError: false });
  await waitFor(() => seen.length === 1);
  assert.equal(seen[0].id, 'c1');
});

test('pending prompts reject HOST_DISCONNECTED on drop; closed rejects at once', async (t) => {
  const srv = await startWs();
  const link = makeLink(srv.port, { baseDelayMs: 1000, maxDelayMs: 1000 });
  t.after(async () => { link.stop(); await srv.close(); });
  await assert.rejects(link.prompt('x', 'y'), { code: 'HOST_UNAVAILABLE' });
  link.start();
  await waitFor(() => link.isOpen());
  const p = link.prompt('inst-1', 'hello');
  await waitFor(() => srv.received.length === 1);
  srv.drop();
  await assert.rejects(p, { code: 'HOST_DISCONNECTED' });
  assert.equal(link.isOpen(), false);
  await assert.rejects(link.prompt('x', 'y'), { code: 'HOST_UNAVAILABLE' });
});

test('an unanswered prompt rejects ACK_TIMEOUT', async (t) => {
  const srv = await startWs();
  const link = makeLink(srv.port, { ackTimeoutMs: 20 });
  t.after(async () => { link.stop(); await srv.close(); });
  link.start();
  await waitFor(() => link.isOpen());
  await assert.rejects(link.prompt('inst-1', 'hello'), { code: 'ACK_TIMEOUT' });
});
