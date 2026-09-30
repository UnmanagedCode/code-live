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

export function summarize(inst) {
  return {
    sessionId: inst.id,
    title: inst.title || truncate(inst.firstPrompt, 60) || 'Untitled conductor',
    status: inst.status,
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
