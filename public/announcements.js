// Wires the backend's SSE stream to the page: finished conductor turns go to
// the transcript and, while live, into the Gemini session to be spoken.
export const ANNOUNCE_PREFIX = 'CONDUCTOR UPDATE';

function parse(ev) {
  try { return JSON.parse(ev.data); } catch { return undefined; }
}

export function installAnnouncements({ eventSource, transcript, session, targetPicker, hostIndicator }) {
  eventSource.addEventListener('announce', (ev) => {
    const a = parse(ev);
    if (!a) return;
    transcript.add('conductor', a.text, { title: a.title });
    if (session.state === 'live') session.sendText(`${ANNOUNCE_PREFIX} from "${a.title}":\n${a.text}`);
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
