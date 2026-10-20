// The conductor service behind the Gemini tools. Every action names its
// conductor and resolves it against conductor rows only, so a worker session
// can never be listed, read, prompted, answered or decided. Acting on a
// conductor (create, send, answer, approve, reject) starts announcing it.
import { askTurnEnd, hasSeq, isConductor, isTopLevel, latestAskEvent, summarize, textParts, toolAsk, truncateBody, MAX_TEXT } from './hostEvents.js';
import { assembleMessages, bondedSelection, messageBody, wholeMessages } from './eventMessages.js';
import { MAX_MESSAGE_PAGES, readBack, readForward } from './eventPages.js';
import { describeAnswers, resolveAnswers, remapQuestion } from './answerMapping.js';

const CUT_HINT = 'Messages marked truncated are cut: read each whole with its messageKey, part 1 up to parts.';
const TURN_HINT = 'The start of this turn is further back than the read could reach: a plan or question of the turn may be older. Read older messages with before set to nextBefore.';
const REPLY_NOTE = 'The reply will be announced when the conductor finishes its turn.';
const APPROVED_NOTE = 'The conductor is now running without permission prompts. Its reply will be announced when it finishes its turn.';
const REJECTED_NOTE = 'The conductor will revise the plan. Its reply will be announced when it finishes its turn.';

// `detail` carries the fields the tool result may show Gemini (see tools.js).
function fail(code, message, detail) {
  return Object.assign(new Error(message), { code, ...(detail ? { detail } : {}) });
}

function refusal(r) {
  const { code, message, ...detail } = r;
  return fail(code, message, detail);
}

function latestQuestions(data) {
  const ev = latestAskEvent(Array.isArray(data?.events) ? data.events : [], 'question');
  return ev && ev.questions.length > 0 ? ev.questions : null;
}

function describe(rows) {
  return rows.map((r) => `"${summarize(r).title}" (${r.id})`).join(', ') || 'none';
}

export function createConductorService({ api, link, announcer, hostMcp }) {
  // Resolves a session id or exact (case-insensitive) title to a conductor row.
  async function resolve(session) {
    const all = await api.listInstances();
    const rows = all.filter(isConductor);
    if (all.some((i) => i.id === session && !isConductor(i))) {
      throw fail('NOT_A_CONDUCTOR', 'That session is a worker, not a conductor. Code Live only works with conductor sessions.');
    }
    const byId = rows.find((r) => r.id === session);
    if (byId) return byId;
    const wanted = session.toLowerCase();
    const byTitle = rows.filter((r) => summarize(r).title.toLowerCase() === wanted);
    if (byTitle.length === 1) return byTitle[0];
    if (byTitle.length > 1) throw fail('AMBIGUOUS_SESSION', `Several conductor sessions match "${session}": ${describe(byTitle)}. Use the session id.`);
    throw fail('UNKNOWN_SESSION', `No conductor session matches "${session}". Available: ${describe(rows)}.`);
  }

  // The host's public session id, read from the live row every time: it is
  // null while the session is still spawning.
  function sessionOf(row) {
    if (!row.sessionId) throw fail('SESSION_NOT_READY', 'The conductor session is still starting; try again in a moment.');
    return row.sessionId;
  }

  function requireAsk(row, kind) {
    if (toolAsk(row) === kind) return;
    throw fail(kind === 'question' ? 'NO_PENDING_QUESTION' : 'NO_PENDING_PLAN',
      `"${summarize(row).title}" is not waiting for ${kind === 'question' ? 'an answer to a question' : 'approval of a plan'} right now.`);
  }

  // The trailing page of the conductor's events.
  async function eventsOf(id) {
    const data = await api.getEvents(id);
    return Array.isArray(data?.events) ? data.events : [];
  }

  // A plan is approved or rejected only while the row shows an unanswered plan
  // and the conductor's events hold that plan with the turn that ended on it:
  // the host does not check.
  async function requirePendingPlan(row) {
    sessionOf(row);
    requireAsk(row, 'plan');
    const events = await eventsOf(row.id);
    const ev = latestAskEvent(events, 'plan');
    if (!ev || !askTurnEnd(events, ev)) {
      throw fail('NO_PENDING_PLAN', `"${summarize(row).title}" shows no plan in its latest events, so there is nothing to approve or reject.`);
    }
  }

  // Runs a host write that answers or decides the conductor's pending ask. The
  // ask is marked handled first, so it is not announced while the host still
  // shows it; a failed write puts it back so it is announced again.
  async function withAskHeld(row, kind, write) {
    const undo = await announcer.holdAsk(row.id, kind);
    try {
      return await write();
    } catch (e) {
      await undo().catch((e2) => console.error('code-live: restoring the pending ask failed:', e2.message));
      throw e;
    }
  }

  // Sends the answers, retrying once against the labels the host offers.
  // Returns the answers that were delivered.
  async function deliverAnswers(sessionId, questions, spoken, first) {
    let answers = first;
    try {
      await hostMcp.answerQuestion(sessionId, answers);
    } catch (e) {
      const i = e.detail?.questionIndex;
      // The host counts questions from 0 and Gemini from 1.
      if (e.code === 'NOT_MULTISELECT' && Number.isInteger(i)) {
        throw fail('NOT_MULTISELECT', `Question ${i + 1} takes a single choice, but several were given.`, { question: i + 1 });
      }
      if (e.code !== 'INVALID_OPTION' || !Array.isArray(e.detail?.offered) || !Number.isInteger(i)) throw e;
      // The host's own label list is authoritative: map the spoken words to
      // it once, then give up and hand the options back.
      const entry = spoken[i] ?? {};
      const multi = questions?.[i]?.multiSelect ?? (Array.isArray(entry.choices) && entry.choices.length > 1);
      const again = remapQuestion(i, entry, e.detail.offered, !!multi);
      if (again.refusal) throw refusal(again.refusal);
      answers = answers.map((a, k) => (k === i ? again.answer : a));
      try {
        await hostMcp.answerQuestion(sessionId, answers);
      } catch (e2) {
        if (e2.code === 'INVALID_OPTION' && Array.isArray(e2.detail?.offered)) {
          throw fail('INVALID_OPTION', e2.message, { question: i + 1, offered: e2.detail.offered });
        }
        throw e2;
      }
    }
    return answers;
  }

  async function decidePlan(row, call, note) {
    const out = await call();
    return { ok: true, sessionId: row.id, title: summarize(row).title, mode: out.mode, delivered: true, note };
  }

  // Whether the window's events let the default selection be settled: a
  // top-level turn_end before the last message's start, so its whole turn is in.
  function reachesTurnStart(events, last) {
    return events.some((ev) => ev.kind === 'turn_end' && isTopLevel(ev) && ev._seq < last.firstSeq);
  }

  function listed(m) {
    const body = messageBody(m);
    const fitted = truncateBody(body, MAX_TEXT);
    return {
      messageKey: m.key,
      text: fitted.text,
      totalChars: body.length,
      ...(m.hasPlan ? { hasPlan: true } : {}),
      ...(m.planPath ? { planPath: m.planPath } : {}),
      ...(m.questions ? { questionCount: m.questions.length } : {}),
      ...(fitted.cut ? { questionsTruncated: true } : {}),
      ...(fitted.dropped ? { questionsDropped: true } : {}),
      ...(fitted.text.length < body.length ? { truncated: true } : {}),
    };
  }

  // Whether a window holds what the request needs: `want` whole messages (the
  // oldest is not counted while the window may start inside it), and for the
  // default selection its turn's start too, or an ask already bonded.
  const enoughFor = (want, byTurn) => (events) => {
    const { messages } = wholeMessages(events, false);
    if (messages.length < want) return false;
    if (!byTurn) return true;
    const last = messages.at(-1);
    return bondedSelection(messages).length > 1 || !!last.questions || last.hasPlan || reachesTurnStart(events, last);
  };

  // The message listing. A message the window may start inside is never listed
  // (see `wholeMessages`); the read goes back until the messages asked for are
  // whole. A window with none, where the host has older events, is refused:
  // an empty list would read as a conductor with nothing to say.
  async function listMessages(row, { count, before }) {
    const byTurn = count === undefined && !before;
    const { events, complete } = await readBack(api, row.id, { before: before?.seq, enough: enoughFor(count ?? 1, byTurn), maxPages: MAX_MESSAGE_PAGES });
    const { messages, partial } = wholeMessages(events, complete);
    if (messages.length === 0 && (partial || !complete)) {
      throw fail('MESSAGES_NOT_REACHED', `No whole message of "${summarize(row).title}" lies within the newest events the read can reach${partial ? ' (the newest message is longer than that)' : ''}.`);
    }
    let picked;
    if (count !== undefined) picked = messages.slice(-count);
    else picked = before ? messages.slice(-1) : bondedSelection(messages);
    const start = picked.length ? messages.indexOf(picked[0]) : 0;
    const items = picked.map(listed);
    // The default selection is bonded to its turn: without the turn's start in
    // the window, an older plan or question of the turn may be missing.
    const turnOpen = byTurn && !complete && !reachesTurnStart(events, messages.at(-1)) && picked.length === 1 && !picked[0].hasPlan && !picked[0].questions;
    const hints = [...(items.some((m) => m.truncated) ? [CUT_HINT] : []), ...(turnOpen ? [TURN_HINT] : [])];
    return {
      messages: items,
      ...(hints.length ? { hint: hints.join(' ') } : {}),
      ...(!complete || start > 0 ? { nextBefore: picked[0]?.key } : {}),
    };
  }

  // A message's events are done once it is followed by a turn end or by another
  // message, and every plan or question it asked has its event.
  const messageDone = (msgId) => (events) => {
    let mine = false;
    let closed = false;
    const asked = new Set();
    for (const ev of events) {
      if (!hasSeq(ev) || ev.parentToolUseId) continue;
      if (ev.msgId === msgId) {
        mine = true;
        if (ev.kind === 'tool_use' && (ev.name === 'ExitPlanMode' || ev.name === 'AskUserQuestion') && typeof ev.toolUseId === 'string') asked.add(ev.toolUseId);
      } else if (mine && (ev.kind === 'turn_end' || (typeof ev.msgId === 'string' && ev.msgId))) closed = true;
      if ((ev.kind === 'plan_request' || ev.kind === 'user_question') && typeof ev.toolUseId === 'string') asked.delete(ev.toolUseId);
    }
    return closed && asked.size === 0;
  };

  return {
    resolve,

    async list() {
      const rows = (await api.listInstances()).filter(isConductor);
      return { ok: true, sessions: rows.map(summarize) };
    },

    async create() {
      const inst = await api.createConductor();
      if (!inst || typeof inst.id !== 'string') throw fail('HOST_HTTP_ERROR', 'code-conductor did not return the new session');
      // A just-spawned session has finished no turns.
      await announcer.watch(inst.id, { seq: -1 });
      return { ok: true, session: summarize(inst) };
    },

    async send({ text, session }) {
      const row = await resolve(session);
      // Watch (and baseline) before prompting: a fast turn could otherwise
      // finish before the baseline and be marked handled unannounced.
      await announcer.watch(row.id);
      await link.prompt(row.id, text);
      return { ok: true, sessionId: row.id, title: summarize(row).title, delivered: true, note: REPLY_NOTE };
    },

    // No `count` returns the default selection, which bonds a trailing prose
    // message to the turn's plan or questions; an explicit `count` is literal.
    // `before` is a parsed message key: the messages before it.
    async read({ session, count, before }) {
      const row = await resolve(session);
      return { ok: true, sessionId: row.id, title: summarize(row).title, ...await listMessages(row, { count, before }) };
    },

    // One message whole, a part at a time, from the events around its first
    // event. The read starts one event early, so a key whose seq has been
    // reassigned to the middle of that message (a respawn renumbers the stream
    // and keeps only the msgId) finds the message starting earlier and is refused.
    // A message that does not close within the page bound is refused, never
    // returned as a fragment; one still being written says so (`inProgress`).
    async readMessage({ session, messageKey, part }) {
      const row = await resolve(session);
      const title = summarize(row).title;
      const read = await readForward(api, row.id, { after: messageKey.seq - 2, done: messageDone(messageKey.msgId), maxPages: MAX_MESSAGE_PAGES });
      const m = assembleMessages(read.events).find((x) => x.msgId === messageKey.msgId);
      if (!m || m.firstSeq !== messageKey.seq) {
        throw fail('MESSAGE_NOT_FOUND', `No message ${messageKey.seq}-${messageKey.msgId} in "${title}" any more; list the messages again with read_conductor_messages.`);
      }
      if (!read.done && !read.ended) {
        throw fail('MESSAGE_TOO_LONG', `The message ${m.key} of "${title}" is longer than the read can reach in one go, so it cannot be read whole.`);
      }
      const body = messageBody(m);
      const parts = textParts(body);
      if (part > parts.length) throw fail('NO_SUCH_PART', `The message has ${parts.length} part(s).`, { expected: parts.length, got: part });
      return {
        ok: true,
        sessionId: row.id,
        title,
        messageKey: m.key,
        part,
        parts: parts.length,
        totalChars: body.length,
        text: parts[part - 1],
        ...(read.done ? {} : { inProgress: true }),
        ...(m.hasPlan ? { hasPlan: true } : {}),
        ...(m.planPath ? { planPath: m.planPath } : {}),
        ...(m.questions ? { questionCount: m.questions.length } : {}),
      };
    },

    // Answers the named conductor's pending AskUserQuestion. `spoken` is aligned
    // to its questions; choices are mapped to the host's exact labels.
    async answer({ session, answers: spoken }) {
      const row = await resolve(session);
      const sessionId = sessionOf(row);
      requireAsk(row, 'question');
      const questions = latestQuestions(await api.getEvents(row.id));
      const mapped = resolveAnswers(questions, spoken);
      if (mapped.refusal) throw refusal(mapped.refusal);
      // Every refusal above comes before the first write.
      const answers = await withAskHeld(row, 'question', () => deliverAnswers(sessionId, questions, spoken, mapped.answers));
      return {
        ok: true,
        sessionId: row.id,
        title: summarize(row).title,
        delivered: true,
        answered: describeAnswers(answers),
        note: REPLY_NOTE,
      };
    },

    // Approval switches the conductor to bypassPermissions, so it needs an
    // explicit `confirmed:true` before anything reaches the host.
    async approve({ session, confirmed, feedback }) {
      if (confirmed !== true) {
        throw fail('CONFIRMATION_REQUIRED', 'Approving lets the conductor run without permission prompts. Read the plan back, get an explicit yes from the user, then call again with confirmed true.');
      }
      const row = await resolve(session);
      await requirePendingPlan(row);
      return withAskHeld(row, 'plan', () => decidePlan(row, () => hostMcp.approvePlan(row.sessionId, feedback), APPROVED_NOTE));
    },

    async reject({ session, feedback }) {
      const row = await resolve(session);
      await requirePendingPlan(row);
      return withAskHeld(row, 'plan', () => decidePlan(row, () => hostMcp.rejectPlan(row.sessionId, feedback), REJECTED_NOTE));
    },
  };
}
