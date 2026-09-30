// Reading code-conductor instance summaries and event streams: shared by the
// conductor service (tools, target picker) and the announcer.

export const CONDUCTOR_PROJECT = '.conduct';
export const MAX_TEXT = 4000;

export function isConductor(inst) {
  return !!inst && inst.project === CONDUCTOR_PROJECT;
}

export function truncate(text, max) {
  if (typeof text !== 'string' || text === '') return '';
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

// The text kept when a body exceeds `max`: a trailing `--- questions ---`
// section stays whole (the user must hear every option) and the prose before
// it is cut; anything else, a plan included, is cut from the end.
export function truncateBody(text, max) {
  if (typeof text !== 'string' || text.length <= max) return typeof text === 'string' ? text : '';
  const fences = [...text.matchAll(/^--- questions ---$/gm)];
  const at = fences.length ? fences[fences.length - 1].index : -1;
  const room = max - (text.length - at) - 1;
  if (at < 0 || room < 0) return truncate(text, max);
  const head = text.slice(0, at).replace(/\n+$/, '');
  return (room >= 2 && head ? `${truncate(head, room)}\n` : '') + text.slice(at);
}

// 'question' or 'plan' while the row shows an AskUserQuestion / ExitPlanMode
// the user has not answered (the host's sticky awaiting-user state), else null.
export function toolAsk(row) {
  const ask = row?.awaitingUser;
  return row?.awaitingUserSource === 'tool' && (ask === 'question' || ask === 'plan') ? ask : null;
}

// The host's raw `status: 'idle'` only means the session's own turn ended. Like
// the host's own UI, prefer `displayStatus` (`running` while background subagents
// work) and label an idle session that awaits a worker's wake `on a worker`.
// Both overlays apply only to `idle`, so `turn`, `spawning`, `exited` and
// `crashed` pass through.
function runState(inst) {
  const shown = inst.displayStatus ?? inst.status;
  return shown === 'idle' && inst.awaitingWake ? 'on a worker' : shown;
}

export function summarize(inst) {
  return {
    sessionId: inst.id,
    title: inst.title || truncate(inst.firstPrompt, 60) || 'Untitled conductor',
    status: runState(inst),
    lastResponseAt: inst.lastResponseAt ?? null,
  };
}

// The text blocks of an assistant_message event joined with newlines, or ''
// for anything else (including tool-use-only messages).
export function assistantText(ev) {
  if (!ev || ev.kind !== 'assistant_message') return '';
  const content = ev.message?.content;
  if (!Array.isArray(content)) return '';
  const text = content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
  return text.trim() === '' ? '' : text;
}

export function hasSeq(ev) {
  return !!ev && typeof ev._seq === 'number';
}

// The msgId of the last assistant message inside the turn that ends at
// `endSeq` (after the previous turn_end), or null when that turn said nothing.
export function lastAssistantMsgId(events, endSeq) {
  let turnStart = -Infinity;
  for (const ev of events) {
    if (ev.kind === 'turn_end' && hasSeq(ev) && ev._seq < endSeq && ev._seq > turnStart) turnStart = ev._seq;
  }
  let found = null;
  for (const ev of events) {
    if (ev.kind === 'assistant_message' && hasSeq(ev) && ev._seq > turnStart && ev._seq < endSeq && typeof ev.msgId === 'string') found = ev.msgId;
  }
  return found;
}
