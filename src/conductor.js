// The conductor service behind both the Gemini tools and the UI's target
// picker. Every path resolves sessions against conductor rows only, so a
// worker session can never be listed, read, prompted or targeted.
import { assistantText, isConductor, summarize, toolAsk, truncate, truncateBody, MAX_TEXT } from './hostEvents.js';
import { pairMessages } from './hostMcp.js';
import { describeAnswers, resolveAnswers, remapQuestion } from './answerMapping.js';

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
  const events = Array.isArray(data?.events) ? data.events : [];
  const ev = events.findLast((e) => e.kind === 'user_question' && Array.isArray(e.questions) && e.questions.length > 0);
  return ev ? ev.questions : null;
}

function describe(rows) {
  return rows.map((r) => `"${summarize(r).title}" (${r.id})`).join(', ') || 'none';
}

export function createConductorService({ api, link, state, announcer, publish, hostMcp }) {
  const activeId = () => state.get().activeTargetId;

  async function clearTarget() {
    await announcer.clear();
    publish('target', null);
  }

  // Resolves an optional session id or exact (case-insensitive) title to a
  // conductor row; omitted means the active target.
  async function resolve(session) {
    const all = await api.listInstances();
    const rows = all.filter(isConductor);
    if (session === undefined) {
      const id = activeId();
      if (!id) throw fail('NO_ACTIVE_TARGET', 'No conductor session is active. List the sessions and name one, or create one.');
      const row = rows.find((r) => r.id === id);
      if (!row) {
        await clearTarget();
        throw fail('SESSION_GONE', 'The active conductor session is no longer running; the active target was cleared.');
      }
      return row;
    }
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
      `The conductor is not waiting for ${kind === 'question' ? 'an answer to a question' : 'approval of a plan'} right now.`);
  }

  // A plan is approved or rejected only while the row shows an unanswered plan
  // and the host's own latest messages hold it: the host does not check.
  async function requirePendingPlan(row) {
    const sessionId = sessionOf(row);
    requireAsk(row, 'plan');
    const recent = await hostMcp.recentMessages(sessionId);
    if (!pairMessages(recent).some((m) => m.hasPlan)) {
      throw fail('NO_PENDING_PLAN', 'The conductor shows no plan in its latest messages, so there is nothing to approve or reject.');
    }
  }

  async function decidePlan(row, call, note) {
    const out = await call();
    return { ok: true, sessionId: row.id, title: summarize(row).title, mode: out.mode, delivered: true, note };
  }

  // The latest messages, or the /events prose when the host's MCP read fails.
  async function readMessages(row, count) {
    if (row.sessionId) {
      try {
        return pairMessages(await hostMcp.recentMessages(row.sessionId, { count })).map((m) => ({
          text: truncateBody(m.text, MAX_TEXT),
          ...(m.hasPlan ? { hasPlan: true } : {}),
          ...(m.planPath ? { planPath: m.planPath } : {}),
          ...(m.questionCount !== undefined ? { questionCount: m.questionCount } : {}),
        }));
      } catch (e) {
        console.error('code-live: get_recent_messages failed, reading /events:', e.message);
      }
    } else {
      console.error('code-live: the conductor has no host session id yet, reading /events');
    }
    const data = await api.getEvents(row.id);
    const texts = (Array.isArray(data?.events) ? data.events : []).map(assistantText).filter(Boolean);
    return texts.slice(-(count ?? 1)).map((t) => ({ text: truncate(t, MAX_TEXT) }));
  }

  async function applyTarget(row, seq) {
    await announcer.baseline(row.id, seq);
    const target = { sessionId: row.id, title: summarize(row).title };
    publish('target', target);
    return target;
  }

  return {
    resolve,
    clearTarget,

    async list() {
      const rows = (await api.listInstances()).filter(isConductor);
      const id = activeId();
      const sessions = rows.map((r) => ({ ...summarize(r), active: r.id === id }));
      const active = sessions.find((s) => s.active);
      return { ok: true, sessions, activeTarget: active ? { sessionId: active.sessionId, title: active.title } : null };
    },

    async create() {
      const inst = await api.createConductor();
      if (!inst || typeof inst.id !== 'string') throw fail('HOST_HTTP_ERROR', 'code-conductor did not return the new session');
      // A just-spawned session has finished no turns.
      const activeTarget = await applyTarget(inst, -1);
      return { ok: true, session: summarize(inst), activeTargetChanged: true, activeTarget };
    },

    async send({ text, session }) {
      const row = await resolve(session);
      const changed = row.id !== activeId();
      // Switch (and baseline) before prompting: a fast turn could otherwise
      // finish before the baseline and be marked handled unannounced.
      const activeTarget = changed ? await applyTarget(row) : null;
      const title = summarize(row).title;
      try {
        await link.prompt(row.id, text);
      } catch (e) {
        if (changed) e.message += ` ("${title}" is now the active target.)`;
        throw e;
      }
      return {
        ok: true,
        sessionId: row.id,
        title,
        delivered: true,
        note: REPLY_NOTE,
        ...(changed ? { activeTargetChanged: true, activeTarget } : {}),
      };
    },

    // No `count` returns the host's default selection, which bonds a trailing
    // prose message to the turn's plan or questions; an explicit `count` is
    // literal, exactly as the host treats it.
    async read({ session, count }) {
      const row = await resolve(session);
      return { ok: true, sessionId: row.id, title: summarize(row).title, messages: await readMessages(row, count) };
    },

    // Answers the active target's pending AskUserQuestion. `spoken` is aligned
    // to its questions; choices are mapped to the host's exact labels.
    async answer({ answers: spoken }) {
      const row = await resolve(undefined);
      const sessionId = sessionOf(row);
      requireAsk(row, 'question');
      const questions = latestQuestions(await api.getEvents(row.id));
      const mapped = resolveAnswers(questions, spoken);
      if (mapped.refusal) throw refusal(mapped.refusal);
      let { answers } = mapped;
      try {
        await hostMcp.answerQuestion(sessionId, answers);
      } catch (e) {
        const i = e.detail?.questionIndex;
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
    async approve({ confirmed, feedback }) {
      if (confirmed !== true) {
        throw fail('CONFIRMATION_REQUIRED', 'Approving lets the conductor run without permission prompts. Read the plan back, get an explicit yes from the user, then call again with confirmed true.');
      }
      const row = await resolve(undefined);
      await requirePendingPlan(row);
      return decidePlan(row, () => hostMcp.approvePlan(row.sessionId, feedback), APPROVED_NOTE);
    },

    async reject({ feedback }) {
      const row = await resolve(undefined);
      await requirePendingPlan(row);
      return decidePlan(row, () => hostMcp.rejectPlan(row.sessionId, feedback), REJECTED_NOTE);
    },

    async setTarget(id) {
      return applyTarget(await resolve(id));
    },

    // The active target as the page should show it: null unless the persisted
    // id is a live conductor row (also when the host can't be asked).
    async getTarget() {
      const id = activeId();
      if (!id) return null;
      let row;
      try {
        row = (await api.listInstances()).find((i) => i.id === id);
      } catch {
        return null;
      }
      return isConductor(row) ? { sessionId: id, title: summarize(row).title } : null;
    },
  };
}
