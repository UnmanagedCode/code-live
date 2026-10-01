// Wires the backend's SSE stream to the page: finished conductor turns go to
// the transcript and, while live, into the Gemini session to be spoken.
export const ANNOUNCE_PREFIX = 'CONDUCTOR UPDATE';
export const ASK_QUESTION_MARK = 'AWAITING ANSWER';
export const ASK_PLAN_MARK = 'AWAITING PLAN APPROVAL';

// The line that ends an update whose turn stopped on a question or plan.
function askFooter(ask, sessionId) {
  if (ask?.kind === 'question') {
    let cut = '';
    if (ask.dropped) cut = ' Some options are missing from the text above: say so, and let the user pick by option number.';
    else if (ask.truncated) cut = ' Some options above were shortened: say so, and let the user pick by option number.';
    return `${ASK_QUESTION_MARK}: ${ask.count} question(s). Use answer_conductor_question with session ${sessionId}.${cut}`;
  }
  if (ask?.kind === 'plan') return `${ASK_PLAN_MARK}${ask.planPath ? ` (plan file: ${ask.planPath})` : ''}. Use approve_conductor_plan or reject_conductor_plan with session ${sessionId}.`;
  return '';
}

function parse(ev) {
  try { return JSON.parse(ev.data); } catch { return undefined; }
}

export function installAnnouncements({ eventSource, transcript, session, hostIndicator }) {
  eventSource.addEventListener('announce', (ev) => {
    const a = parse(ev);
    if (!a) return;
    transcript.add('conductor', a.text, { title: a.title, ...(a.ask?.kind ? { ask: a.ask.kind } : {}) });
    const footer = askFooter(a.ask, a.sessionId);
    if (session.state === 'live') session.sendText(`${ANNOUNCE_PREFIX} from "${a.title}" (session ${a.sessionId}):\n${a.text}${footer ? `\n${footer}` : ''}`);
  });
  eventSource.addEventListener('host', (ev) => {
    const h = parse(ev);
    if (h) hostIndicator.set(!!h.connected);
  });
}
