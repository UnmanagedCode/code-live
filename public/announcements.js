// Wires the backend's SSE stream to the page: finished conductor turns go to
// the transcript and, while live, into the Gemini session to be spoken.
export const ANNOUNCE_PREFIX = 'CONDUCTOR UPDATE';
export const ASK_QUESTION_MARK = 'AWAITING ANSWER';
export const ASK_PLAN_MARK = 'AWAITING PLAN APPROVAL';

// What a conductor writes (its title, its reply, a plan path) reaches Gemini
// inside an update whose header and footer name the session to act on, so none
// of it may pose as either. Everything interpolated stays on one line (a title
// also loses its quotes); in a reply, a line that would read as a header or
// footer once invisible characters and combining marks are dropped, Unicode
// spaces are plain spaces and case is ignored is prefixed with "> ". Every
// Unicode line separator, and the FS/GS/RS controls, starts a line. Look-alike
// letters and markdown-decorated markers are not caught.
const BREAKS = '\\n\\r\\v\\f\\u001c-\\u001e\\u0085\\u2028\\u2029';
const oneLine = (s) => String(s).replace(new RegExp(`[${BREAKS}]+`, 'g'), ' ');
const safeTitle = (title) => oneLine(title).replaceAll('"', "'");
const BREAK_SPLIT = new RegExp(`(\\r\\n|[${BREAKS}])`);
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const MARKER = new RegExp(`^ *(?:${ANNOUNCE_PREFIX.replaceAll(' ', ' +')}|AWAITING(?![A-Za-z0-9]))`, 'i');
const COMBINING = /\p{Mn}/gu;
const readsAsMarker = (line) => MARKER.test(line.normalize('NFKD').replace(COMBINING, '').replace(INVISIBLE, '').replace(/\s/gu, ' '));
// split() with a capture group alternates lines and the breaks between them.
const safeBody = (text) => String(text).split(BREAK_SPLIT).map((part, i) => (i % 2 === 0 && readsAsMarker(part) ? `> ${part}` : part)).join('');

// The line that ends an update whose turn stopped on a question or plan.
function askFooter(ask, sessionId) {
  if (ask?.kind === 'question') {
    let cut = '';
    if (ask.dropped) cut = ' Some options are missing from the text above: say so, and let the user pick by option number.';
    else if (ask.truncated) cut = ' Some options above were shortened: say so, and let the user pick by option number.';
    return `${ASK_QUESTION_MARK}: ${ask.count} question(s). Use answer_conductor_question with session ${sessionId}.${cut}`;
  }
  if (ask?.kind === 'plan') return `${ASK_PLAN_MARK}${ask.planPath ? ` (plan file: ${oneLine(ask.planPath)})` : ''}. Use approve_conductor_plan or reject_conductor_plan with session ${sessionId}.`;
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
    const sessionId = oneLine(a.sessionId);
    const footer = askFooter(a.ask, sessionId);
    if (session.state === 'live') session.sendText(`${ANNOUNCE_PREFIX} from "${safeTitle(a.title)}" (session ${sessionId}):\n${safeBody(a.text)}${footer ? `\n${footer}` : ''}`);
  });
  eventSource.addEventListener('host', (ev) => {
    const h = parse(ev);
    if (h) hostIndicator.set(!!h.connected);
  });
}
