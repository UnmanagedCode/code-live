// Pins: every paged read of the events route is bounded and stops as asked:
// backward reads follow nextBefore until enough, complete or the page bound;
// forward reads follow the last seq until done, an empty or short page, or the
// page bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBack, readForward, EVENTS_PAGE, MAX_EVENT_PAGES, MAX_MESSAGE_PAGES } from '../src/eventPages.js';

// An api whose events route holds `total` events numbered 1..total, paged like the host.
function fakeApi(total) {
  const calls = [];
  return {
    calls,
    async getEvents(_id, { limit, before, after }) {
      calls.push({ limit, before, after });
      const all = Array.from({ length: total }, (_, i) => ({ kind: 'tool_use', _seq: i + 1 }));
      if (after !== undefined) return { events: all.filter((e) => e._seq > after).slice(0, limit), hasMore: false };
      const older = all.filter((e) => before === undefined || e._seq < before);
      const events = older.slice(-limit);
      return { events, hasMore: older.length > events.length, nextBefore: events[0]?._seq ?? null };
    },
  };
}

// Invariant: a backward read starts at the trailing page, follows nextBefore, joins pages oldest first, and reports
// complete only when the host has nothing older.
test('readBack follows nextBefore to the oldest events and reports complete', async () => {
  const api = fakeApi(EVENTS_PAGE * 2 + 10);
  const { events, complete } = await readBack(api, 'c');
  assert.equal(complete, true);
  assert.deepEqual(events.map((e) => e._seq), Array.from({ length: events.length }, (_, i) => i + 1));
  assert.equal(events.length, EVENTS_PAGE * 2 + 10);
  assert.deepEqual(api.calls.map((c) => c.before), [undefined, EVENTS_PAGE * 2 + 10 - EVENTS_PAGE + 1, 11]);
});

// Invariant: a backward read stops as soon as `enough` holds, and says it is not complete.
test('readBack stops once enough holds', async () => {
  const api = fakeApi(EVENTS_PAGE * 4);
  const { events, complete } = await readBack(api, 'c', { enough: (evs) => evs.length >= EVENTS_PAGE + 1 });
  assert.equal(complete, false);
  assert.equal(api.calls.length, 2);
  assert.equal(events.length, EVENTS_PAGE * 2);
});

// Invariant: no read makes more than its page bound of requests, however much history there is, and a forward read
// stopped by the bound says it neither finished nor ran out of stream.
test('both reads are bounded by their page bound', async () => {
  const back = fakeApi(EVENTS_PAGE * (MAX_EVENT_PAGES + 5));
  assert.equal((await readBack(back, 'c')).complete, false);
  assert.equal(back.calls.length, MAX_EVENT_PAGES);
  const forward = fakeApi(EVENTS_PAGE * (MAX_EVENT_PAGES + 5));
  const read = await readForward(forward, 'c', { after: 0, done: () => false });
  assert.equal(forward.calls.length, MAX_EVENT_PAGES);
  assert.equal(read.events.length, EVENTS_PAGE * MAX_EVENT_PAGES);
  assert.deepEqual([read.done, read.ended], [false, false]);
  const wide = fakeApi(EVENTS_PAGE * (MAX_MESSAGE_PAGES + 5));
  await readBack(wide, 'c', { maxPages: MAX_MESSAGE_PAGES });
  assert.equal(wide.calls.length, MAX_MESSAGE_PAGES);
});

// Invariant: a backward cursor that does not move ends the read instead of repeating one page.
test('readBack stops when the host\'s nextBefore does not move', async () => {
  const stuck = { calls: 0, async getEvents() { this.calls++; return { events: [{ _seq: 5 }], hasMore: true, nextBefore: 5 }; } };
  const { complete } = await readBack(stuck, 'c', { before: 5 });
  assert.equal(complete, false);
  assert.equal(stuck.calls, 1);
});

// Invariant: a forward read continues after the last seq, ends at a short page without another request and reports
// the stream ran out; one that `done` stopped reports done.
test('readForward continues after the last seq and reports why it stopped', async () => {
  const api = fakeApi(EVENTS_PAGE + 20);
  const read = await readForward(api, 'c', { after: 0, done: () => false });
  assert.equal(read.events.length, EVENTS_PAGE + 20);
  assert.deepEqual([read.done, read.ended], [false, true]);
  assert.deepEqual(api.calls.map((c) => c.after), [0, EVENTS_PAGE]);
  const stopped = await readForward(fakeApi(EVENTS_PAGE * 3), 'c', { after: 0, done: (evs) => evs.length >= EVENTS_PAGE });
  assert.deepEqual([stopped.done, stopped.ended], [true, false]);
});
