// Detects finished turns on the active conductor and publishes them as SSE
// `announce` events. Idempotent by the turn_end's _seq together with the turn's
// last assistant msgId: every trigger (a turn_notification, a host /ws
// reconnect, backend startup, an instances frame showing a pending question or
// plan) runs the same serialized reconcile over the REST events route, so a
// duplicate or missed notification never double-announces or drops a turn, and
// a host that replays its history under fresh _seq numbers stays silent.
//
// A pending question or plan is announced once, keyed by its tool_use id, even
// when later turns have already ended: the instance row says whether an ask is
// pending, and its content comes from the ask's own turn.
//
// The announced text comes from the host's get_recent_messages (through
// hostMcp) when it ends on the announced turn; otherwise the turn's last
// assistant text from /events is used and the reason logged.
import {
  assistantText, askId, askTurnEnd, hasSeq, isConductor, lastAssistantMsgId, latestAskEvent, newestTurnEnd,
  renderPlan, renderQuestions, summarize, toolAsk, truncateBody, MAX_TEXT,
} from './hostEvents.js';
import { pairMessages } from './hostMcp.js';

const NO_TEXT = '(turn finished with no text reply)';

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
  // The ask state the last completed reconcile settled, so an unchanged state
  // is not probed again; `done` is false while the ask's turn is still running.
  let probed = { key: null, done: false };
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

  // get_recent_messages when it ends on this turn, else null (logged). It
  // returns the session's newest messages, so a later turn that has already
  // spoken makes it the wrong source for this one.
  async function recentFor(row, msgId) {
    if (!row.sessionId) {
      console.error('code-live: the conductor has no host session id yet, announcing the /events text');
      return null;
    }
    let messages;
    try {
      messages = pairMessages(await hostMcp.recentMessages(row.sessionId));
    } catch (e) {
      console.error('code-live: get_recent_messages failed, announcing the /events text:', e.message);
      return null;
    }
    if (msgId !== null && messages.at(-1)?.msgId !== msgId) {
      console.error('code-live: get_recent_messages does not end on the announced turn (a later turn has spoken), announcing the /events text');
      return null;
    }
    return messages;
  }

  // The text and ask of one announcement. `pending` is the unannounced ask
  // that ended this turn; its content is added from its own event unless the
  // host's messages already carry it.
  async function compose({ row, events, turnEnd, msgId, pending, useMcp }) {
    const messages = useMcp ? await recentFor(row, msgId) : null;
    let text = messages ? messages.map((m) => m.text).filter(Boolean).join('\n') : eventsText(events, turnEnd);
    if (!pending) return { text, ask: null };
    const add = (section) => { text = [text, section].filter(Boolean).join('\n'); };
    if (pending.kind === 'question') {
      const carried = messages?.findLast((m) => m.questionCount);
      if (!carried) add(renderQuestions(pending.ev.questions));
      return { text, ask: { kind: 'question', count: carried ? carried.questionCount : pending.ev.questions.length } };
    }
    const carried = messages?.findLast((m) => m.hasPlan);
    if (!carried) add(renderPlan(pending.ev));
    return { text, ask: { kind: 'plan', planPath: (carried ? carried.planPath : pending.ev.planPath) ?? null } };
  }

  function emit(id, row, turnEnd, { text, ask }) {
    const fitted = text ? truncateBody(text, MAX_TEXT) : null;
    publish('announce', {
      sessionId: id,
      title: summarize(row).title,
      text: fitted ? fitted.text : NO_TEXT,
      turnSeq: turnEnd._seq,
      isError: !!turnEnd.isError,
      ask: ask && fitted?.cut ? { ...ask, truncated: true } : ask,
    });
  }

  // `askOnly` announces only a pending ask (with its turn, when that is the
  // newest) and otherwise leaves state untouched.
  async function doReconcile({ askOnly = false, row: known } = {}) {
    const st = state.get();
    const id = st.activeTargetId;
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
    const handled = typeof data?.lastSeq === 'number' && data.lastSeq < st.lastHandledTurnSeq ? -1 : st.lastHandledTurnSeq;
    const turnEnd = newestTurnEnd(events, handled);

    // The row says whether an ask is pending; the ask's own events say what it is.
    const kind = toolAsk(row);
    const askEv = kind ? latestAskEvent(events, kind) : null;
    const askEnd = askEv ? askTurnEnd(events, askEv) : null;
    const pending = askEv && askEnd && askId(askEv) !== st.lastHandledAskId ? { kind, ev: askEv, end: askEnd, id: askId(askEv) } : null;

    let msgId = null;
    let announceTurn = false;
    if (turnEnd) {
      msgId = lastAssistantMsgId(events, turnEnd._seq);
      if (msgId !== null && msgId === st.lastHandledMsgId) {
        // The turn already announced, replayed under a new _seq.
        await state.update({ lastHandledTurnSeq: turnEnd._seq });
      } else {
        announceTurn = !askOnly || (!!pending && pending.end._seq === turnEnd._seq);
      }
    }
    const combined = announceTurn && !!pending && pending.end._seq === turnEnd._seq;

    // An ask that an older turn ended (or a replayed one) is announced by itself,
    // before the later turn.
    if (pending && !combined) {
      const content = await compose({ row, events, turnEnd: pending.end, msgId: null, pending, useMcp: false });
      await state.update({ lastHandledAskId: pending.id });
      emit(id, row, pending.end, content);
    }
    if (announceTurn) {
      const content = await compose({ row, events, turnEnd, msgId, pending: combined ? pending : null, useMcp: true });
      await state.update({ lastHandledTurnSeq: turnEnd._seq, lastHandledMsgId: msgId, ...(combined ? { lastHandledAskId: pending.id } : {}) });
      emit(id, row, turnEnd, content);
    }
    // Settled unless the ask's own turn is still running.
    probed = { key: askKey(row), done: !kind || !askEv || !!askEnd };
  }

  const announcer = {
    reconcile: () => serialize(doReconcile),

    // Reconciles for a pending question or plan the host may not have sent a
    // turn_notification for. Coalesced, and skipped once the row's ask state
    // has been settled by a completed reconcile.
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
        if (key === null || (probed.done && key === probed.key)) return;
        await doReconcile({ askOnly: true, row });
      });
    },

    // Makes `id` the active target with every turn it has already finished
    // marked handled. Pass `seq` when it is known (-1 for a fresh session);
    // otherwise it is read from the events route, and a failure propagates.
    baseline: (id, seq) => serialize(async () => {
      let handled = seq;
      let msgId = null;
      let ask = null;
      if (handled === undefined) {
        const data = await api.getEvents(id);
        const events = Array.isArray(data?.events) ? data.events : [];
        const newest = newestTurnEnd(events, -Infinity);
        handled = newest ? newest._seq : -1;
        if (newest) msgId = lastAssistantMsgId(events, newest._seq);
        // A question or plan the session already ended on is not news either.
        const asks = ['question', 'plan'].map((k) => latestAskEvent(events, k)).filter((ev) => ev && askTurnEnd(events, ev));
        if (asks.length) ask = askId(asks.reduce((a, b) => (b._seq > a._seq ? b : a)));
      }
      probed = { key: null, done: false };
      await state.update({ activeTargetId: id, lastHandledTurnSeq: handled, lastHandledMsgId: msgId, lastHandledAskId: ask });
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
