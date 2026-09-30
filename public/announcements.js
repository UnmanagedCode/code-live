// Wires the backend's SSE stream to the page: finished conductor turns go to
// the transcript and, while live, into the Gemini session to be spoken.
export const ANNOUNCE_PREFIX = 'CONDUCTOR UPDATE';
export const ASK_QUESTION_MARK = 'AWAITING ANSWER';
export const ASK_PLAN_MARK = 'AWAITING PLAN APPROVAL';

// The line that ends an update whose turn stopped on a question or plan.
function askFooter(ask) {
  if (ask?.kind === 'question') {
    const cut = ask.truncated ? ' Some options above were shortened: say so, and let the user pick by option number.' : '';
    return `${ASK_QUESTION_MARK}: ${ask.count} question(s). Use answer_conductor_question.${cut}`;
  }
  if (ask?.kind === 'plan') return `${ASK_PLAN_MARK}${ask.planPath ? ` (plan file: ${ask.planPath})` : ''}.`;
  return '';
}

function parse(ev) {
  try { return JSON.parse(ev.data); } catch { return undefined; }
}

export function installAnnouncements({ eventSource, transcript, session, targetPicker, hostIndicator }) {
  eventSource.addEventListener('announce', (ev) => {
    const a = parse(ev);
    if (!a) return;
    transcript.add('conductor', a.text, { title: a.title, ...(a.ask?.kind ? { ask: a.ask.kind } : {}) });
    const footer = askFooter(a.ask);
    if (session.state === 'live') session.sendText(`${ANNOUNCE_PREFIX} from "${a.title}":\n${a.text}${footer ? `\n${footer}` : ''}`);
  });
  eventSource.addEventListener('target', (ev) => {
    const t = parse(ev);
    if (t !== undefined) targetPicker.update(t);
  });
  eventSource.addEventListener('host', (ev) => {
    const h = parse(ev);
    if (h) hostIndicator.set(!!h.connected);
  });
}
