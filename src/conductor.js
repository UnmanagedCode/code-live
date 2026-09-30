// The conductor service behind both the Gemini tools and the UI's target
// picker. Every path resolves sessions against conductor rows only, so a
// worker session can never be listed, read, prompted or targeted.
import { assistantText, isConductor, summarize, truncate, MAX_TEXT } from './hostEvents.js';

const REPLY_NOTE = 'The reply will be announced when the conductor finishes its turn.';

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function describe(rows) {
  return rows.map((r) => `"${summarize(r).title}" (${r.id})`).join(', ') || 'none';
}

export function createConductorService({ api, link, state, announcer, publish }) {
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

    async read({ session, count = 1 }) {
      const row = await resolve(session);
      const data = await api.getEvents(row.id);
      const texts = (Array.isArray(data?.events) ? data.events : []).map(assistantText).filter(Boolean);
      return {
        ok: true,
        sessionId: row.id,
        title: summarize(row).title,
        messages: texts.slice(-count).map((t) => ({ text: truncate(t, MAX_TEXT) })),
      };
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
