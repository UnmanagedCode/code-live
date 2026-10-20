// Paged reads of a conductor's events over the host's REST events route. Every
// read is bounded: at most MAX_EVENT_PAGES requests, EVENTS_PAGE events each.
export const EVENTS_PAGE = 500;
export const MAX_EVENT_PAGES = 8;

const eventsOf = (data) => (Array.isArray(data?.events) ? data.events : []);

// Backward pages, starting with the trailing page (or the one before `before`),
// until `enough(events)` holds, the host has no older events, or the page
// bound is hit. Resolves to `{events, complete}` with the events oldest first;
// `complete` means the host reported nothing older.
export async function readBack(api, id, { before, enough = () => false } = {}) {
  let events = [];
  let cursor = before;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const data = await api.getEvents(id, { limit: EVENTS_PAGE, before: cursor });
    events = eventsOf(data).concat(events);
    if (!data?.hasMore) return { events, complete: true };
    if (enough(events)) break;
    // A cursor that does not move would repeat the same page.
    if (!Number.isSafeInteger(data.nextBefore) || (cursor !== undefined && data.nextBefore >= cursor)) break;
    cursor = data.nextBefore;
  }
  return { events, complete: false };
}

// Forward pages after seq `after` (exclusive) until `done(events)` holds, a
// page is empty, or the page bound is hit. Resolves to the events oldest first.
export async function readForward(api, id, { after, done }) {
  let events = [];
  let cursor = after;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const data = await api.getEvents(id, { limit: EVENTS_PAGE, after: cursor });
    const got = eventsOf(data);
    events = events.concat(got);
    if (done(events)) break;
    if (got.length < EVENTS_PAGE) break;
    const last = got.findLast((ev) => Number.isSafeInteger(ev?._seq));
    if (!last) break;
    cursor = last._seq;
  }
  return events;
}
