// Rebuilds a conductor's messages from the host's event stream, the way the
// host's own message reconstruction does, so a read needs no host tool call. One
// linear pass, no regexes: the events are untrusted host input.
//
// A message is every top-level event sharing one msgId. Its prose is the text
// blocks of its assistant_message envelopes, or else its text_delta chunks (the
// only source for events replayed from disk). A plan_request or user_question
// attaches to the message that owns its toolUseId.
import { assistantText, hasSeq, renderPlan, renderQuestions } from './hostEvents.js';

const str = (v) => (typeof v === 'string' ? v : '');
const MESSAGE_KINDS = new Set(['message_start', 'text_delta', 'assistant_message', 'thinking_delta', 'tool_use']);
const ASK_TOOLS = { ExitPlanMode: 'plan', AskUserQuestion: 'questions' };
const DEFAULT_ORDER = ['prose', 'narration', 'plan', 'questions'];

function newMessage(msgId, ev, turn) {
  return {
    msgId, firstSeq: ev._seq, turn,
    opened: false, envelope: null, deltas: null, narration: null,
    plan: '', planPath: '', hasPlan: false, questions: null, order: [],
  };
}

function stamp(m, segment) {
  if (!m.order.includes(segment)) m.order.push(segment);
}

// Appends `text` to block `idx` of the message's `field`, a Map created on first use.
function append(m, field, idx, text) {
  const blocks = (m[field] ??= new Map());
  const key = Number.isFinite(idx) ? idx : 0;
  const parts = blocks.get(key);
  if (parts) parts.push(text); else blocks.set(key, [text]);
}

// The host's narration join: each block trimmed, empties dropped, a blank line between.
function joinNarration(blocks) {
  const out = [];
  for (const parts of blocks?.values() ?? []) {
    const t = parts.join('').trim();
    if (t) out.push(t);
  }
  return out.join('\n\n');
}

function finish(m) {
  const fromEnvelope = m.envelope ? m.envelope.join('') : '';
  const prose = fromEnvelope || (m.deltas ? [...m.deltas.values()].map((p) => p.join('')).join('') : '');
  const narration = joinNarration(m.narration);
  const questions = m.questions;
  if (!prose && !narration && !m.hasPlan && !questions) return null;
  const present = { prose: !!prose, narration: !!narration, plan: m.hasPlan, questions: !!questions };
  const order = [...m.order, ...DEFAULT_ORDER.filter((s) => !m.order.includes(s))].filter((s) => present[s]);
  return {
    key: `${m.firstSeq}-${m.msgId}`,
    msgId: m.msgId,
    firstSeq: m.firstSeq,
    opened: m.opened,
    turn: m.turn,
    prose,
    narration,
    plan: m.plan,
    planPath: m.planPath,
    hasPlan: m.hasPlan,
    questions,
    order,
  };
}

// The text-bearing messages in `events`, oldest first, each
// `{key, msgId, firstSeq, opened, turn, prose, narration, plan, planPath, hasPlan,
// questions, order}`. Events without a numeric `_seq`, and a sub-agent's
// (`parentToolUseId`), form nothing. `turn` counts the top-level turn_ends
// before the message. The key's seq is a lookup hint, never an identity: a
// respawn renumbers the stream and keeps the msgId.
export function assembleMessages(events) {
  const groups = new Map();
  const ordered = [];
  const owners = new Map();
  let turn = 0;
  let latest = null;
  for (const ev of events) {
    if (!hasSeq(ev) || ev.parentToolUseId) continue;
    if (ev.kind === 'turn_end') { turn++; continue; }
    if (ev.kind === 'plan_request' || ev.kind === 'user_question') {
      const m = (typeof ev.toolUseId === 'string' && owners.get(ev.toolUseId)) || latest;
      if (!m) continue;
      if (ev.kind === 'plan_request') {
        m.plan = str(ev.plan);
        m.planPath = str(ev.planPath);
        m.hasPlan = true;
        stamp(m, 'plan');
      } else if (Array.isArray(ev.questions) && ev.questions.length > 0) {
        m.questions = ev.questions;
        stamp(m, 'questions');
      }
      continue;
    }
    // Any event of a msgId (a block opener, a text_end, a usage record) joins its
    // group, so a message's first seq is its first event of any kind; only the
    // content kinds add to it.
    const msgId = str(ev.msgId) || (ev.kind === 'assistant_message' ? `m${ev._seq}` : '');
    if (!msgId) continue;
    let m = groups.get(msgId);
    if (!m) {
      m = newMessage(msgId, ev, turn);
      groups.set(msgId, m);
      ordered.push(m);
    }
    if (!MESSAGE_KINDS.has(ev.kind)) continue;
    latest = m;
    if (ev.kind === 'message_start') m.opened = true;
    if (ev.kind === 'text_delta') {
      append(m, 'deltas', ev.blockIdx, str(ev.text));
      stamp(m, 'prose');
    } else if (ev.kind === 'assistant_message') {
      const text = assistantText(ev);
      if (text) { (m.envelope ??= []).push(text); stamp(m, 'prose'); }
    } else if (ev.kind === 'thinking_delta') {
      if (ev.narration) { append(m, 'narration', ev.blockIdx, str(ev.text)); stamp(m, 'narration'); }
    } else if (ev.kind === 'tool_use') {
      const segment = Object.hasOwn(ASK_TOOLS, ev.name) ? ASK_TOOLS[ev.name] : null;
      if (segment) {
        stamp(m, segment);
        if (typeof ev.toolUseId === 'string') owners.set(ev.toolUseId, m);
      }
    }
  }
  return ordered.map(finish).filter(Boolean);
}

// The messages of a window of events that is cut at its old end (`complete`
// false: the host has older events). Only a message whose message_start is in
// the window provably started there, so the oldest message is left out unless it
// did: the window may begin inside it, on any of its events. (Events replayed
// from disk carry no message_start, so their oldest message is left out until the
// read has gone back to the beginning.) Returns `{messages, partial}`, `partial`
// being the message left out, or null.
export function wholeMessages(events, complete) {
  const messages = assembleMessages(events);
  const first = messages[0];
  if (complete || !first || first.opened) return { messages, partial: null };
  return { messages: messages.slice(1), partial: first };
}

// The host's full body of a message: its segments in arrival order, joined with
// newlines, with the host's fences around the narration, plan and questions.
export function messageBody(m) {
  const parts = m.order.map((segment) => {
    if (segment === 'prose') return m.prose;
    if (segment === 'narration') return `--- narration ---\n${m.narration}`;
    if (segment === 'plan') return renderPlan({ plan: m.plan, planPath: m.planPath });
    return renderQuestions(m.questions);
  });
  return parts.join('\n');
}

const hasAsk = (m) => m.hasPlan || !!m.questions;

// The host's default selection: the last message, bonded back (within its own
// turn) to the nearest plan-or-questions message before it. A last message that
// carries its own ask, or a turn with none, is returned alone.
export function bondedSelection(messages) {
  const last = messages.at(-1);
  if (!last || hasAsk(last)) return last ? [last] : [];
  for (let i = messages.length - 2; i >= 0 && messages[i].turn === last.turn; i--) {
    if (hasAsk(messages[i])) return messages.slice(i);
  }
  return [last];
}

// `<seq>-<msgId>` as {seq, msgId}, or null for anything else. The seq is the
// digits before the first '-', a safe integer.
export function parseMessageKey(s) {
  if (typeof s !== 'string') return null;
  const dash = s.indexOf('-');
  if (dash < 1 || dash > 15 || dash === s.length - 1) return null;
  for (let i = 0; i < dash; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return null;
  }
  return { seq: Number(s.slice(0, dash)), msgId: s.slice(dash + 1) };
}
