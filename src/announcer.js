// Detects finished turns on the announced conductors (the ones this backend
// has acted on, see `watch`) and publishes them as SSE `announce` events.
// Idempotent by the turn_end's _seq together with the turn's last assistant
// msgId: every trigger (a turn_notification, a host /ws reconnect, backend
// startup, an instances frame showing a pending question or plan) runs the same
// serialized reconcile over the REST events route, so a duplicate or missed
// notification never double-announces or drops a turn, and a host that replays
// its history under fresh _seq numbers stays silent. Each conductor keeps its
// own cursor; a conductor leaves the set only when a reconcile finds it gone
// from the host's list, no longer a conductor, or its events route 404ing.
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

const logFailure = (e) => console.error('code-live: reconcile failed:', e?.message ?? e);

// Identifies one pending ask on a row, so an unchanged ask is probed once.
function askKey(row) {
  return toolAsk(row) ? `${row.awaitingUser}:${row.lastResponseAt ?? ''}` : null;
}

export function createAnnouncer({ api, link, state, publish, hostMcp }) {
  let chain = Promise.resolve();
  let askQueued = false;
  // Per conductor, the ask state the last completed reconcile settled, so an
  // unchanged state is not probed again; `done` is false while the ask's turn
  // is still running.
  const probed = new Map();
  // Watches, prunes and reconciles for every conductor share one queue, so a
  // reconcile can never write its seq over a fresh baseline and turns that
  // finish together are announced one after the other.
  function serialize(fn) {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  }

  const watchedIds = () => Object.keys(state.get().watched);
  const cursorOf = (id) => {
    const { watched } = state.get();
    return Object.hasOwn(watched, id) ? watched[id] : null;
  };

  // Read-modify-write of one cursor; a conductor pruned meanwhile is not revived.
  async function patchCursor(id, patch) {
    const { watched } = state.get();
    if (!Object.hasOwn(watched, id)) return;
    await state.update({ watched: { ...watched, [id]: { ...watched[id], ...patch } } });
  }

  async function unwatch(id) {
    probed.delete(id);
    const { watched } = state.get();
    if (!Object.hasOwn(watched, id)) return;
    const { [id]: _gone, ...rest } = watched;
    await state.update({ watched: rest });
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
    const planPath = carried ? carried.planPath : pending.ev.planPath;
    return { text, ask: { kind: 'plan', planPath: typeof planPath === 'string' ? planPath : null } };
  }

  function emit(id, row, turnEnd, { text, ask }) {
    const fitted = text ? truncateBody(text, MAX_TEXT) : null;
    publish('announce', {
      sessionId: id,
      title: summarize(row).title,
      text: fitted ? fitted.text : NO_TEXT,
      turnSeq: turnEnd._seq,
      isError: !!turnEnd.isError,
      ask: ask && fitted?.cut ? { ...ask, truncated: true, ...(fitted.dropped ? { dropped: true } : {}) } : ask,
    });
  }

  // `askOnly` announces only a pending ask (with its turn, when that is the
  // newest) and otherwise leaves the cursor untouched. `rows` is an instance
  // list the caller has just read; omitted, it is read here.
  async function doReconcile(id, { askOnly = false, rows } = {}) {
    const st = cursorOf(id);
    if (!st) return;
    let row;
    try {
      row = (rows ?? await api.listInstances()).find((i) => i.id === id);
    } catch (e) {
      console.error('code-live: reconcile failed:', e.message);
      return;
    }
    // Only a live conductor is ever announced; a persisted id that is gone or
    // names a worker is pruned.
    if (!isConductor(row)) { await unwatch(id); return; }
    let data;
    try {
      data = await api.getEvents(id);
    } catch (e) {
      if (e.code === 'SESSION_GONE') { await unwatch(id); return; }
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
        await patchCursor(id, { lastHandledTurnSeq: turnEnd._seq });
      } else {
        announceTurn = !askOnly || (!!pending && pending.end._seq === turnEnd._seq);
      }
    }
    const combined = announceTurn && !!pending && pending.end._seq === turnEnd._seq;

    // An ask that an older turn ended (or a replayed one) is announced by itself,
    // before the later turn.
    if (pending && !combined) {
      const content = await compose({ row, events, turnEnd: pending.end, msgId: null, pending, useMcp: false });
      await patchCursor(id, { lastHandledAskId: pending.id });
      emit(id, row, pending.end, content);
    }
    if (announceTurn) {
      const content = await compose({ row, events, turnEnd, msgId, pending: combined ? pending : null, useMcp: true });
      await patchCursor(id, { lastHandledTurnSeq: turnEnd._seq, lastHandledMsgId: msgId, ...(combined ? { lastHandledAskId: pending.id } : {}) });
      emit(id, row, turnEnd, content);
    }
    // Settled unless the ask's own turn is still running.
    probed.set(id, { key: askKey(row), done: !kind || !askEv || !!askEnd });
  }

  // Runs `fn` for each id; one conductor's failure does not starve the rest,
  // and the first is rethrown once all have run.
  async function eachWatched(ids, fn) {
    let failure;
    for (const id of ids) {
      try { await fn(id); } catch (e) { failure ??= e; }
    }
    if (failure) throw failure;
  }

  const eventsOf = async (id) => {
    const data = await api.getEvents(id);
    return Array.isArray(data?.events) ? data.events : [];
  };

  // The id of the newest ask of `kind` in the conductor's events, or null.
  async function currentAskId(id, kind) {
    const ev = latestAskEvent(await eventsOf(id), kind);
    return ev ? askId(ev) : null;
  }

  // Adds `id` to the announced set with every turn it has finished marked
  // handled. Events are read unless `seq` is known. With `ask` its current ask
  // of that kind is marked handled too; that mark is returned (null for none).
  async function addCursor(id, { seq, ask }) {
    let handled = seq;
    let msgId = null;
    let askHandled = null;
    if (handled === undefined || ask) {
      const events = await eventsOf(id);
      if (handled === undefined) {
        const newest = newestTurnEnd(events, -Infinity);
        handled = newest ? newest._seq : -1;
        if (newest) msgId = lastAssistantMsgId(events, newest._seq);
      }
      const askEv = ask ? latestAskEvent(events, ask) : null;
      if (askEv) askHandled = askId(askEv);
    }
    probed.delete(id);
    const { watched } = state.get();
    await state.update({ watched: { ...watched, [id]: { lastHandledTurnSeq: handled, lastHandledMsgId: msgId, lastHandledAskId: askHandled } } });
    return askHandled;
  }

  const announcer = {
    // One conductor, or (without `id`) every announced one from a single list read.
    reconcile: (id) => serialize(async () => {
      if (id !== undefined) { await doReconcile(id); return; }
      const ids = watchedIds();
      if (ids.length === 0) return;
      let rows;
      try {
        rows = await api.listInstances();
      } catch (e) {
        console.error('code-live: reconcile failed:', e.message);
        return;
      }
      await eachWatched(ids, (one) => doReconcile(one, { rows }));
    }),

    // For triggers that have nobody to hand a rejection to: a failure is
    // logged, never left unhandled.
    reconcileLogged({ ask = false, id } = {}) {
      return (ask ? announcer.reconcileAsk() : announcer.reconcile(id)).catch(logFailure);
    },

    // Reconciles for a pending question or plan the host may not have sent a
    // turn_notification for. Coalesced, and skipped per conductor once its row's
    // ask state has been settled by a completed reconcile. It also prunes a
    // conductor that has left the host's list.
    reconcileAsk() {
      if (askQueued) return chain;
      askQueued = true;
      return serialize(async () => {
        askQueued = false;
        const ids = watchedIds();
        if (ids.length === 0) return;
        let rows;
        try {
          rows = await api.listInstances();
        } catch (e) {
          console.error('code-live: reconcile failed:', e.message);
          return;
        }
        await eachWatched(ids, async (id) => {
          if (!cursorOf(id)) return;
          const row = rows.find((i) => i.id === id);
          if (!isConductor(row)) { await unwatch(id); return; }
          const key = askKey(row);
          const last = probed.get(id);
          if (key === null || (last?.done && key === last.key)) return;
          await doReconcile(id, { askOnly: true, rows });
        });
      });
    },

    // Starts announcing `id` with every turn it has already finished marked
    // handled; a no-op when it is already announced. Pass `seq` when it is known
    // (-1 for a fresh session); otherwise it is read from the events route, and
    // a failure propagates. A question or plan the row still shows as unanswered
    // is news and is announced once.
    watch: (id, { seq } = {}) => serialize(async () => {
      if (cursorOf(id)) return false;
      await addCursor(id, { seq });
      return true;
    }).then((added) => {
      if (added) announcer.reconcileLogged({ ask: true });
    }),

    // For a caller about to answer or decide `id`'s pending ask of `kind`
    // ('question' | 'plan'): marks that ask handled, so the announcer does not
    // announce the ask being answered while the host still shows it, and
    // announces the conductor from then on. It applies whether or not the
    // conductor is already announced. Resolves to an async `undo` for when the
    // host write fails: it puts the ask back and announces it again.
    async holdAsk(id, kind) {
      const held = await serialize(async () => {
        const existing = cursorOf(id);
        if (!existing) return { added: true, prev: null, marked: await addCursor(id, { ask: kind }) };
        const marked = await currentAskId(id, kind);
        if (marked !== null) {
          probed.delete(id);
          await patchCursor(id, { lastHandledAskId: marked });
        }
        return { added: false, prev: existing.lastHandledAskId, marked };
      });
      if (held.added) announcer.reconcileLogged({ ask: true });
      return async () => {
        await serialize(async () => {
          // A newer announcement of this conductor's ask is not overwritten.
          if (held.marked === null || cursorOf(id)?.lastHandledAskId !== held.marked) return;
          probed.delete(id);
          await patchCursor(id, { lastHandledAskId: held.prev });
        });
        announcer.reconcileLogged({ ask: true });
      };
    },
  };

  if (link) {
    link.on('turn_notification', (frame) => {
      if (frame.id && cursorOf(frame.id)) announcer.reconcileLogged({ id: frame.id });
    });
    link.on('instances', () => { announcer.reconcileLogged({ ask: true }); });
    link.on('open', () => { announcer.reconcileLogged(); });
  }

  return announcer;
}
