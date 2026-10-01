// Reading code-conductor instance summaries and event streams: shared by the
// conductor service and the announcer.

export const CONDUCTOR_PROJECT = '.conduct';
export const MAX_TEXT = 4000;

export function isConductor(inst) {
  return !!inst && inst.project === CONDUCTOR_PROJECT;
}

export function truncate(text, max) {
  if (typeof text !== 'string' || text === '') return '';
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

// Caps every line at `cap` chars. The label comes first on an option line, so a
// description goes before its label, but a label longer than `cap` is cut too.
function capLines(lines, cap) {
  return lines.map((l) => (l.length > cap ? `${l.slice(0, cap - 1)}…` : l));
}

// The text kept when a body exceeds `max`, as {text, cut, dropped}. A trailing
// `--- questions ---` section stays whole when it fits (the user must hear
// every option) and the prose before it is cut. A section that alone exceeds
// `max` is shortened line by line (`cut`); if even that does not fit, trailing
// lines are dropped whole and a last line counts them (`dropped`, which
// implies `cut`). Anything else, a plan included, is cut from the end and
// reports neither.
export function truncateBody(text, max) {
  if (typeof text !== 'string') return { text: '', cut: false, dropped: false };
  if (text.length <= max) return { text, cut: false, dropped: false };
  const fences = [...text.matchAll(/^--- questions ---$/gm)];
  const at = fences.length ? fences[fences.length - 1].index : -1;
  if (at < 0) return { text: truncate(text, max), cut: false, dropped: false };
  const section = text.slice(at);
  const room = max - section.length - 1;
  if (room >= 0) {
    const head = text.slice(0, at).replace(/\n+$/, '');
    return { text: (room >= 2 && head ? `${truncate(head, room)}\n` : '') + section, cut: false, dropped: false };
  }
  const lines = section.split('\n');
  for (const cap of [160, 80, 40, 20]) {
    const fitted = capLines(lines, cap).join('\n');
    if (fitted.length <= max) return { text: fitted, cut: true, dropped: false };
  }
  const capped = capLines(lines, 20);
  const kept = [];
  let used = 0;
  for (const l of capped) {
    if (used + l.length + 1 > max - 40) break;
    kept.push(l);
    used += l.length + 1;
  }
  kept.push(`… ${capped.length - kept.length} more line(s) not shown`);
  return { text: kept.join('\n'), cut: true, dropped: true };
}

// Host payload fields are not trusted to be well formed: anything else than a
// string renders as empty rather than throwing.
const str = (v) => (typeof v === 'string' ? v : '');
const obj = (v) => (v && typeof v === 'object' ? v : {});

// The host's rendering of an AskUserQuestion payload in a message body.
export function renderQuestions(questions) {
  const lines = ['--- questions ---'];
  (Array.isArray(questions) ? questions : []).forEach((raw, i) => {
    const q = obj(raw);
    lines.push(`${i + 1}. ${str(q.question)} (multiSelect: ${!!q.multiSelect})${str(q.header) ? ` · header: ${q.header}` : ''}`);
    for (const rawOpt of Array.isArray(q.options) ? q.options : []) {
      const opt = obj(rawOpt);
      lines.push(`   - ${str(opt.label)}${str(opt.description) ? `: ${opt.description}` : ''}`);
    }
  });
  return lines.join('\n');
}

// The host's rendering of an ExitPlanMode payload (a plan_request event).
export function renderPlan(ev) {
  const header = str(ev?.planPath) ? `--- plan · saved to ${ev.planPath} ---` : '--- plan ---';
  return str(ev?.plan) ? `${header}\n${ev.plan}` : header;
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

// The text blocks of a top-level assistant_message event (sub-agent messages
// carry parentToolUseId and are not the conductor's) joined with newlines, or ''
// for anything else (including tool-use-only messages).
export function assistantText(ev) {
  if (!ev || ev.kind !== 'assistant_message' || ev.parentToolUseId) return '';
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

// Top-level turn_end / assistant_message events only: the host's own turn
// reconstruction skips the ones a sub-agent emits (`parentToolUseId`).
export const isTopLevel = (ev) => hasSeq(ev) && !ev.parentToolUseId;

export function newestTurnEnd(events, afterSeq) {
  let found = null;
  for (const ev of events) {
    if (ev.kind === 'turn_end' && isTopLevel(ev) && ev._seq > afterSeq && (!found || ev._seq > found._seq)) found = ev;
  }
  return found;
}

// The msgId of the last top-level assistant message inside the turn that ends
// at `endSeq` (after the previous turn_end), or null when that turn said nothing.
export function lastAssistantMsgId(events, endSeq) {
  let turnStart = -Infinity;
  for (const ev of events) {
    if (ev.kind === 'turn_end' && isTopLevel(ev) && ev._seq < endSeq && ev._seq > turnStart) turnStart = ev._seq;
  }
  let found = null;
  for (const ev of events) {
    if (ev.kind === 'assistant_message' && isTopLevel(ev) && ev._seq > turnStart && ev._seq < endSeq && typeof ev.msgId === 'string') found = ev.msgId;
  }
  return found;
}

// The newest unanswered-kind ask event ('question' → user_question, 'plan' →
// plan_request that was not auto-approved), or null.
export function latestAskEvent(events, kind) {
  const want = kind === 'question' ? 'user_question' : 'plan_request';
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind === want && isTopLevel(ev) && !ev.autoApproved && (kind !== 'question' || Array.isArray(ev.questions))) return ev;
  }
  return null;
}

// Identifies one ask across a host replay: the tool_use id, which a renumbered
// ring keeps, else its position.
export const askId = (ev) => (typeof ev.toolUseId === 'string' ? ev.toolUseId : `${ev.kind}@${ev._seq}`);

// The first turn_end after an ask event: the turn the ask ended, or null while
// that turn is still running.
export function askTurnEnd(events, askEv) {
  let found = null;
  for (const ev of events) {
    if (ev.kind === 'turn_end' && isTopLevel(ev) && ev._seq > askEv._seq && (!found || ev._seq < found._seq)) found = ev;
  }
  return found;
}
