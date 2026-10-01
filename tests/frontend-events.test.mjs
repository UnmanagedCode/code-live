// Pins: the page's event stream outlives a failed reconnect. A native
// EventSource gives up for good when its reconnect is answered with a non-2xx
// status (the host's 503 during a backend restart backoff), so the wrapper
// re-creates the source, keeps every registered listener, backs off between
// re-creations and carries the last real event id in `?lastEventId=`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventStream } from '../public/events.js';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

function fakeEventSourceClass() {
  const sources = [];
  class Fake {
    constructor(url) {
      this.url = url;
      this.readyState = CONNECTING;
      this.closed = false;
      this.listeners = {};
      sources.push(this);
    }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    close() { this.closed = true; this.readyState = CLOSED; }
    emit(type, ev = {}) { for (const fn of this.listeners[type] ?? []) fn({ type, ...ev }); }
    open() { this.readyState = OPEN; this.emit('open'); }
    // The browser's CLOSED error: no more native retries.
    fail() { this.readyState = CLOSED; this.emit('error'); }
  }
  return { Fake, sources };
}

// Records delays; `runNext` fires the oldest pending timer.
function manualTimers() {
  const delays = [];
  const pending = [];
  return {
    delays,
    pending,
    runNext: () => pending.shift().fn(),
    timers: {
      setTimeout: (fn, ms) => { delays.push(ms); const h = { fn }; pending.push(h); return h; },
      clearTimeout: (h) => { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
    },
  };
}

function setup(opts = {}) {
  const { Fake, sources } = fakeEventSourceClass();
  const clock = manualTimers();
  const stream = createEventStream({ url: 'api/events', EventSourceImpl: Fake, retryMs: 1000, maxRetryMs: 4000, timers: clock.timers, ...opts });
  return { stream, sources, clock };
}

test('listeners registered once fire on the source re-created after a CLOSED error', () => {
  // Pins: the drop-in contract of installAnnouncements: addEventListener is
  // called once, and keeps working across re-created sources.
  const { stream, sources, clock } = setup();
  const got = [];
  stream.addEventListener('announce', (ev) => got.push(ev.data));
  sources[0].open();
  sources[0].emit('announce', { data: 'first', lastEventId: 'b-1' });
  sources[0].fail();
  clock.runNext();
  assert.equal(sources.length, 2);
  sources[1].open();
  sources[1].emit('announce', { data: 'second', lastEventId: 'b-2' });
  assert.deepEqual(got, ['first', 'second']);
});

test('a listener added after the source exists is attached to it and to later ones', () => {
  // Pins: registration order does not matter (app.js installs listeners right after creating the stream).
  const { stream, sources, clock } = setup();
  const got = [];
  stream.addEventListener('host', (ev) => got.push(ev.data));
  sources[0].emit('host', { data: 'a' });
  sources[0].fail();
  clock.runNext();
  sources[1].emit('host', { data: 'b' });
  assert.deepEqual(got, ['a', 'b']);
});

test('an error while CONNECTING is left to the native retry', () => {
  // Pins: no second source and no timer while the browser is still retrying by itself.
  const { stream, sources, clock } = setup();
  stream.addEventListener('announce', () => {});
  sources[0].readyState = CONNECTING;
  sources[0].emit('error');
  assert.equal(sources.length, 1);
  assert.equal(clock.pending.length, 0);
});

test('re-creation delays double up to the cap and reset after open', () => {
  // Pins: repeated 503s are retried with backoff (1, 2, 4, 4 s), and a
  // successful open starts the sequence over.
  const { stream, sources, clock } = setup();
  stream.addEventListener('announce', () => {});
  for (let i = 0; i < 4; i++) {
    sources.at(-1).fail();
    clock.runNext();
  }
  assert.deepEqual(clock.delays, [1000, 2000, 4000, 4000]);
  sources.at(-1).open();
  sources.at(-1).fail();
  assert.deepEqual(clock.delays.slice(4), [1000]);
});

test('two CLOSED errors in a row schedule a single re-creation', () => {
  // Pins: a stray duplicate error never forks the stream into two sources.
  const { stream, sources, clock } = setup();
  stream.addEventListener('announce', () => {});
  sources[0].fail();
  sources[0].fail();
  assert.equal(clock.pending.length, 1);
  clock.runNext();
  assert.equal(sources.length, 2);
});

test('the re-created URL carries the last non-empty event id', () => {
  // Pins: the id travels as ?lastEventId= (EventSource cannot set a header);
  // id-less initial frames (empty lastEventId) never clear it; with no id
  // yet the URL is the bare one.
  const { stream, sources, clock } = setup();
  stream.addEventListener('host', () => {});
  stream.addEventListener('announce', () => {});
  assert.equal(sources[0].url, 'api/events');
  sources[0].emit('host', { data: '{}', lastEventId: '' });
  sources[0].fail();
  clock.runNext();
  assert.equal(sources[1].url, 'api/events', 'only id-less frames so far: no query');
  sources[1].emit('announce', { data: '{}', lastEventId: 'ab12-3' });
  sources[1].emit('host', { data: '{}', lastEventId: '' });
  sources[1].fail();
  clock.runNext();
  assert.equal(sources[2].url, 'api/events?lastEventId=ab12-3');
});

test('the id is URL-encoded', () => {
  const { stream, sources, clock } = setup();
  stream.addEventListener('announce', () => {});
  sources[0].emit('announce', { data: '{}', lastEventId: 'a b&c' });
  sources[0].fail();
  clock.runNext();
  assert.equal(sources[1].url, 'api/events?lastEventId=a%20b%26c');
});

test('close stops the source and cancels a pending re-creation', () => {
  // Pins: a closed stream never comes back.
  const { stream, sources, clock } = setup();
  stream.addEventListener('announce', () => {});
  sources[0].fail();
  stream.close();
  assert.equal(clock.pending.length, 0);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].closed, true);
});
