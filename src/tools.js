// The Gemini function-calling tools: their declarations (sent in the
// Live setup) and the dispatcher that validates args and calls the conductor
// service. Every tool that acts on a conductor requires its `session`.
// callTool never throws; every failure is an {ok:false, code} result that
// Gemini reads back to the user.

const SESSION_PARAM = { type: 'STRING', description: "The conductor's session id, from its CONDUCTOR UPDATE or list_conductor_sessions, or its exact title." };

export const DECLARATIONS = [
  {
    name: 'list_conductor_sessions',
    description: "List the user's live code-conductor conductor sessions (never workers). Several can be live at once; pass a session's sessionId to the other tools.",
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'create_conductor_session',
    description: 'Start a new code-conductor conductor session. Only when the user asks for a new conductor. Its replies are announced from then on; give it work with send_to_conductor using the returned session id.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'send_to_conductor',
    description: 'Send a prompt to the named conductor session. Its replies are announced from then on, each when its turn finishes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        session: SESSION_PARAM,
        text: { type: 'STRING', description: 'The prompt to send, in the words the user wants the conductor to act on.' },
      },
      required: ['session', 'text'],
    },
  },
  {
    name: 'read_conductor_messages',
    description: "Read a conductor session's most recent assistant messages, including any plan or questions it is waiting on (questionCount, hasPlan, planPath). Never starts announcing it.",
    parameters: {
      type: 'OBJECT',
      properties: {
        session: SESSION_PARAM,
        count: { type: 'INTEGER', description: 'Exactly how many recent messages to return, 1–10. Omit it to get the latest message together with the plan or questions its turn ended on.' },
      },
      required: ['session'],
    },
  },
  {
    name: 'answer_conductor_question',
    description: "Answer the question(s) the named conductor is waiting on, after the user has told you their answer. `answers` holds one entry per question, in order: entry 1 answers question 1. An entry's `choices` are the chosen options, each as the option's number or its words (one for a single-choice question, several allowed for a multi-select one); `text` is a free-text answer instead of an option; `note` adds a remark to a choice. Leave an entry empty to skip that question.",
    parameters: {
      type: 'OBJECT',
      properties: {
        session: SESSION_PARAM,
        answers: {
          type: 'ARRAY',
          description: 'One entry per question, in order.',
          items: {
            type: 'OBJECT',
            properties: {
              choices: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Chosen options: the option number or its words.' },
              text: { type: 'STRING', description: 'A free-text answer, used instead of choices.' },
              note: { type: 'STRING', description: 'An optional remark to go with the choices.' },
            },
          },
        },
      },
      required: ['session', 'answers'],
    },
  },
  {
    name: 'approve_conductor_plan',
    description: 'Approve the plan the named conductor is waiting on. Approving switches the conductor to bypassPermissions, so it then runs every tool without asking. Call it only after the user explicitly said yes to your read-back of the plan and of that consequence, and then pass confirmed true.',
    parameters: {
      type: 'OBJECT',
      properties: {
        session: SESSION_PARAM,
        confirmed: { type: 'BOOLEAN', description: 'True only when the user has explicitly said yes to approving.' },
        feedback: { type: 'STRING', description: 'Optional notes to send along with the approval.' },
      },
      required: ['session', 'confirmed'],
    },
  },
  {
    name: 'reject_conductor_plan',
    description: 'Reject the plan the named conductor is waiting on. It stays in plan mode and revises the plan. Pass what the user wants changed as `feedback`.',
    parameters: {
      type: 'OBJECT',
      properties: {
        session: SESSION_PARAM,
        feedback: { type: 'STRING', description: 'What the user wants changed in the plan.' },
      },
      required: ['session'],
    },
  },
];

export function toolDeclarations(model) {
  if (!model.toolBehavior) return DECLARATIONS;
  return DECLARATIONS.map((d) => ({ ...d, behavior: model.toolBehavior }));
}

class ArgError extends Error {}

function optionalString(args, key) {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ArgError(`${key} must be a string`);
  const t = v.trim();
  return t === '' ? undefined : t;
}

const NO_SESSION = 'session is required: name the conductor by the session id from its update or from list_conductor_sessions';

function requiredSession(args) {
  const v = args.session;
  if (v === undefined || v === null) throw new ArgError(NO_SESSION);
  if (typeof v !== 'string') throw new ArgError('session must be a string');
  if (v.trim() === '') throw new ArgError(NO_SESSION);
  return v.trim();
}

// A choice is usually a string, but the model sometimes sends the bare number.
function answerEntries(args) {
  if (!Array.isArray(args.answers)) throw new ArgError('answers must be an array with one entry per question');
  return args.answers.map((e, i) => {
    const n = i + 1;
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new ArgError(`answers[${i}] must be an object`);
    if (e.choices !== undefined && e.choices !== null) {
      if (!Array.isArray(e.choices) || e.choices.some((c) => typeof c !== 'string' && !Number.isFinite(c))) {
        throw new ArgError(`answers[${i}].choices must be a list of option numbers or words (question ${n})`);
      }
    }
    for (const key of ['text', 'note']) {
      if (e[key] !== undefined && e[key] !== null && typeof e[key] !== 'string') throw new ArgError(`answers[${i}].${key} must be a string`);
    }
    return { choices: (e.choices ?? []).map(String), ...(e.text ? { text: e.text } : {}), ...(e.note ? { note: e.note } : {}) };
  });
}

const HANDLERS = {
  list_conductor_sessions: (_args, service) => service.list(),
  create_conductor_session: (_args, service) => service.create(),
  send_to_conductor: (args, service) => {
    if (typeof args.text !== 'string' || args.text.trim() === '') throw new ArgError('text must be a non-empty string');
    return service.send({ text: args.text, session: requiredSession(args) });
  },
  read_conductor_messages: (args, service) => {
    let count;
    if (args.count !== undefined && args.count !== null) {
      if (!Number.isInteger(args.count) || args.count < 1 || args.count > 10) throw new ArgError('count must be an integer from 1 to 10');
      count = args.count;
    }
    return service.read({ session: requiredSession(args), count });
  },
  answer_conductor_question: (args, service) => service.answer({ session: requiredSession(args), answers: answerEntries(args) }),
  approve_conductor_plan: (args, service) => {
    if (args.confirmed !== undefined && args.confirmed !== null && typeof args.confirmed !== 'boolean') throw new ArgError('confirmed must be a boolean');
    return service.approve({ session: requiredSession(args), confirmed: args.confirmed === true, feedback: optionalString(args, 'feedback') });
  },
  reject_conductor_plan: (args, service) => service.reject({ session: requiredSession(args), feedback: optionalString(args, 'feedback') }),
};

// The error detail fields a failed result shows Gemini, so it can re-read the
// options to the user.
const DETAIL_FIELDS = ['question', 'offered', 'expected', 'got'];
function shownDetail(detail) {
  if (!detail || typeof detail !== 'object') return {};
  return Object.fromEntries(DETAIL_FIELDS.filter((k) => detail[k] !== undefined).map((k) => [k, detail[k]]));
}

export async function callTool(name, args, service) {
  const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : null;
  if (!handler) return { ok: false, code: 'UNKNOWN_TOOL', message: `unknown tool: ${String(name)}` };
  const a = args === undefined || args === null ? {} : args;
  if (typeof a !== 'object' || Array.isArray(a)) return { ok: false, code: 'INVALID_ARGS', message: 'args must be an object' };
  try {
    return await handler(a, service);
  } catch (e) {
    if (e instanceof ArgError) return { ok: false, code: 'INVALID_ARGS', message: e.message };
    if (e && typeof e.code === 'string') return { ok: false, code: e.code, message: e.message, ...shownDetail(e.detail) };
    console.error('code-live: tool', name, 'failed:', e);
    return { ok: false, code: 'INTERNAL_ERROR', message: String(e?.message ?? e) };
  }
}
