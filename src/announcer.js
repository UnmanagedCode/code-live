// Detects finished turns on the active conductor and publishes them as SSE
// `announce` events. Idempotent by the turn_end's _seq: every trigger (a
// turn_notification, a host /ws reconnect, backend startup) runs the same
// serialized reconcile over the REST events route, so a duplicate or missed
// notification never double-announces or drops a turn.
import { assistantText, hasSeq, isConductor, summarize, truncate, MAX_TEXT } from './hostEvents.js';

const NO_TEXT = '(turn finished with no text reply)';

function newestTurnEnd(events, afterSeq) {
  let found = null;
  for (const ev of events) {
    if (ev.kind === 'turn_end' && hasSeq(ev) && ev._seq > afterSeq && (!found || ev._seq > found._seq)) found = ev;
  }
  return found;
}

export function createAnnouncer({ api, link, state, publish }) {
  let chain = Promise.resolve();
  // Target switches and reconciles share one queue, so a reconcile for the old
  // target can never write its seq over a fresh baseline.
  function serialize(fn) {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  }

  async function dropTarget() {
    await state.update({ activeTargetId: null });
    publish('target', null);
  }

  async function doReconcile() {
    const { activeTargetId: id, lastHandledTurnSeq } = state.get();
    if (!id) return;
    let row;
    try {
      row = (await api.listInstances()).find((i) => i.id === id);
    } catch (e) {
      console.error('code-live: reconcile failed:', e.message);
      return;
    }
    // Only a live conductor is ever announced; a persisted id that is gone or
    // names a worker is cleared.
    if (!isConductor(row)) { await dropTarget(); return; }
    let data;
    try {
      data = await api.getEvents(id);
    } catch (e) {
      if (e.code === 'SESSION_GONE') { await dropTarget(); return; }
      console.error('code-live: reconcile failed:', e.message);
      return;
    }
    const events = Array.isArray(data?.events) ? data.events : [];
    const turnEnd = newestTurnEnd(events, lastHandledTurnSeq);
    if (!turnEnd) return;
    await state.update({ lastHandledTurnSeq: turnEnd._seq });
    let text = '';
    for (const ev of events) {
      if (hasSeq(ev) && ev._seq < turnEnd._seq) {
        const t = assistantText(ev);
        if (t) text = t;
      }
    }
    publish('announce', {
      sessionId: id,
      title: summarize(row).title,
      text: text ? truncate(text, MAX_TEXT) : NO_TEXT,
      turnSeq: turnEnd._seq,
      isError: !!turnEnd.isError,
    });
  }

  const announcer = {
    reconcile: () => serialize(doReconcile),

    // Makes `id` the active target with every turn it has already finished
    // marked handled. Pass `seq` when it is known (-1 for a fresh session);
    // otherwise it is read from the events route, and a failure propagates.
    baseline: (id, seq) => serialize(async () => {
      let handled = seq;
      if (handled === undefined) {
        const data = await api.getEvents(id);
        const newest = newestTurnEnd(Array.isArray(data?.events) ? data.events : [], -Infinity);
        handled = newest ? newest._seq : -1;
      }
      await state.update({ activeTargetId: id, lastHandledTurnSeq: handled });
    }),

    clear: () => serialize(() => state.update({ activeTargetId: null })),
  };

  if (link) {
    link.on('turn_notification', (frame) => {
      if (frame.id && frame.id === state.get().activeTargetId) announcer.reconcile();
    });
    link.on('open', () => { announcer.reconcile(); });
  }

  return announcer;
}
