// Detects finished turns on the active conductor and publishes them as SSE
// `announce` events. Idempotent by the turn_end's _seq together with the turn's
// last assistant msgId: every trigger (a turn_notification, a host /ws
// reconnect, backend startup, an instances frame showing a pending question or
// plan) runs the same serialized reconcile over the REST events route, so a
// duplicate or missed notification never double-announces or drops a turn, and
// a host that replays its history under fresh _seq numbers stays silent.
//
// The announced text comes from the host's get_recent_messages (through
// hostMcp), which carries the turn's plan and questions; when that read fails
// the last assistant text from /events is used instead and the failure logged.
import { assistantText, hasSeq, isConductor, lastAssistantMsgId, summarize, toolAsk, truncateBody, MAX_TEXT } from './hostEvents.js';
import { pairMessages } from './hostMcp.js';

const NO_TEXT = '(turn finished with no text reply)';

function newestTurnEnd(events, afterSeq) {
  let found = null;
  for (const ev of events) {
    if (ev.kind === 'turn_end' && hasSeq(ev) && ev._seq > afterSeq && (!found || ev._seq > found._seq)) found = ev;
  }
  return found;
}

function eventsText(events, turnEnd) {
  let text = '';
  for (const ev of events) {
    if (hasSeq(ev) && ev._seq < turnEnd._seq) {
      const t = assistantText(ev);
      if (t) text = t;
    }
  }
  return text;
}

// Identifies one pending ask on a row, so an unchanged ask is probed once.
function askKey(row) {
  return toolAsk(row) ? `${row.awaitingUser}:${row.lastResponseAt ?? ''}` : null;
}

export function createAnnouncer({ api, link, state, publish, hostMcp }) {
  let chain = Promise.resolve();
  let askQueued = false;
  let probedAsk = null;
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

  // The announced text and the pending ask it carries (null when none).
  // get_recent_messages returns the session's newest messages, so when a later
  // turn has already spoken (its last msgId is not this turn's) the turn's own
  // text is read from /events instead.
  async function readContent(row, events, turnEnd, msgId) {
    if (row.sessionId) {
      try {
        const messages = pairMessages(await hostMcp.recentMessages(row.sessionId));
        if (msgId !== null && messages.at(-1)?.msgId !== msgId) return { text: eventsText(events, turnEnd), ask: null };
        const tool = toolAsk(row);
        const question = messages.findLast((m) => m.questionCount);
        const plan = messages.findLast((m) => m.hasPlan);
        let ask = null;
        if (tool === 'question' && question) ask = { kind: 'question', count: question.questionCount };
        else if (tool === 'plan' && plan) ask = { kind: 'plan', planPath: plan.planPath ?? null };
        return { text: messages.map((m) => m.text).filter(Boolean).join('\n'), ask };
      } catch (e) {
        console.error('code-live: get_recent_messages failed, announcing the /events text:', e.message);
      }
    } else {
      console.error('code-live: the conductor has no host session id yet, announcing the /events text');
    }
    return { text: eventsText(events, turnEnd), ask: null };
  }

  // `askOnly` announces a turn only when it ends on a pending question or plan
  // and otherwise leaves all state untouched.
  async function doReconcile({ askOnly = false, row: known } = {}) {
    const { activeTargetId: id, lastHandledTurnSeq, lastHandledMsgId } = state.get();
    if (!id) return;
    let row = known;
    if (!row) {
      try {
        row = (await api.listInstances()).find((i) => i.id === id);
      } catch (e) {
        console.error('code-live: reconcile failed:', e.message);
        return;
      }
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
    // A ring that ends before the last handled turn was reset by the host
    // (rewind, prune, respawn) and is numbered afresh.
    const handled = typeof data?.lastSeq === 'number' && data.lastSeq < lastHandledTurnSeq ? -1 : lastHandledTurnSeq;
    const turnEnd = newestTurnEnd(events, handled);
    if (!turnEnd) return;
    const msgId = lastAssistantMsgId(events, turnEnd._seq);
    if (msgId !== null && msgId === lastHandledMsgId) {
      // The turn already announced, replayed under a new _seq.
      await state.update({ lastHandledTurnSeq: turnEnd._seq });
      probedAsk = askKey(row);
      return;
    }
    const { text, ask } = await readContent(row, events, turnEnd, msgId);
    if (askOnly && !ask) return;
    await state.update({ lastHandledTurnSeq: turnEnd._seq, lastHandledMsgId: msgId });
    probedAsk = askKey(row);
    publish('announce', {
      sessionId: id,
      title: summarize(row).title,
      text: text ? truncateBody(text, MAX_TEXT) : NO_TEXT,
      turnSeq: turnEnd._seq,
      isError: !!turnEnd.isError,
      ask,
    });
  }

  const announcer = {
    reconcile: () => serialize(doReconcile),

    // Reconciles for a pending question or plan the host may not have sent a
    // turn_notification for. Coalesced, and skipped unless the row's ask
    // changed since the last turn it announced or replayed.
    reconcileAsk() {
      if (askQueued) return chain;
      askQueued = true;
      return serialize(async () => {
        askQueued = false;
        const id = state.get().activeTargetId;
        if (!id) return;
        let row;
        try {
          row = (await api.listInstances()).find((i) => i.id === id);
        } catch (e) {
          console.error('code-live: reconcile failed:', e.message);
          return;
        }
        const key = askKey(row);
        if (key === null || key === probedAsk) return;
        await doReconcile({ askOnly: true, row });
      });
    },

    // Makes `id` the active target with every turn it has already finished
    // marked handled. Pass `seq` when it is known (-1 for a fresh session);
    // otherwise it is read from the events route, and a failure propagates.
    baseline: (id, seq) => serialize(async () => {
      let handled = seq;
      let msgId = null;
      if (handled === undefined) {
        const data = await api.getEvents(id);
        const events = Array.isArray(data?.events) ? data.events : [];
        const newest = newestTurnEnd(events, -Infinity);
        handled = newest ? newest._seq : -1;
        if (newest) msgId = lastAssistantMsgId(events, newest._seq);
      }
      probedAsk = null;
      await state.update({ activeTargetId: id, lastHandledTurnSeq: handled, lastHandledMsgId: msgId });
    }),

    clear: () => serialize(() => state.update({ activeTargetId: null })),
  };

  if (link) {
    link.on('turn_notification', (frame) => {
      if (frame.id && frame.id === state.get().activeTargetId) announcer.reconcile();
    });
    link.on('instances', () => {
      announcer.reconcileAsk().catch((e) => console.error('code-live: reconcile failed:', e.message));
    });
    link.on('open', () => { announcer.reconcile(); });
  }

  return announcer;
}
