// The page's server-sent event stream. A native EventSource retries a dropped
// connection by itself, but gives up for good (readyState CLOSED) when a retry
// is answered with a non-2xx status, such as the host's 503 while the backend
// restarts. This wrapper re-creates the source after a delay, keeps every
// registered listener, and sends the last real event id as `?lastEventId=`
// (an EventSource cannot set the Last-Event-ID header) so the backend replays
// what was missed. Same addEventListener surface as EventSource.
const CLOSED = 2;

export function createEventStream({
  url,
  EventSourceImpl = globalThis.EventSource,
  retryMs = 1000,
  maxRetryMs = 30000,
  timers = { setTimeout: (...a) => setTimeout(...a), clearTimeout: (t) => clearTimeout(t) },
}) {
  const listeners = []; // { type, wrapped }
  let source = null;
  let lastId = '';
  let delay = retryMs;
  let timer = null;
  let closed = false;

  // A frame with no `id:` field inherits the last-seen id, so lastEventId is empty only on a
  // fresh source that has seen none yet: the initial frames of a re-created source. The guard
  // keeps those from clearing the last real id.
  const track = (fn) => (ev) => {
    if (ev.lastEventId) lastId = ev.lastEventId;
    fn(ev);
  };

  function connect() {
    timer = null;
    source = new EventSourceImpl(lastId ? `${url}?lastEventId=${encodeURIComponent(lastId)}` : url);
    const current = source;
    for (const { type, wrapped } of listeners) current.addEventListener(type, wrapped);
    current.addEventListener('open', () => { delay = retryMs; });
    current.addEventListener('error', () => {
      // While CONNECTING the browser is still retrying by itself.
      if (closed || current !== source || current.readyState !== CLOSED || timer !== null) return;
      timer = timers.setTimeout(connect, delay);
      delay = Math.min(delay * 2, maxRetryMs);
    });
  }

  connect();

  return {
    addEventListener(type, fn) {
      const wrapped = track(fn);
      listeners.push({ type, wrapped });
      source.addEventListener(type, wrapped);
    },

    close() {
      closed = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      source.close();
    },
  };
}
