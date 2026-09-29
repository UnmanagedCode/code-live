// The four Gemini function-calling tools: their declarations (sent in the
// Live setup) and the dispatcher that validates args and calls the conductor
// service. callTool never throws; every failure is an {ok:false, code} result
// that Gemini reads back to the user.

export const DECLARATIONS = [
  {
    name: 'list_conductor_sessions',
    description: "List the user's live code-conductor conductor sessions (never workers), with the active target marked.",
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'create_conductor_session',
    description: 'Start a new code-conductor conductor session and make it the active target. To give it work, call send_to_conductor afterwards.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'send_to_conductor',
    description: "Send a prompt to a conductor session. Omit `session` to use the active target; naming a session makes it the active target. The conductor's reply is announced when its turn finishes.",
    parameters: {
      type: 'OBJECT',
      properties: {
        text: { type: 'STRING', description: 'The prompt to send, in the words the user wants the conductor to act on.' },
        session: { type: 'STRING', description: 'Conductor session id or exact title. Omit for the active target.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'read_conductor_messages',
    description: "Read a conductor session's most recent assistant messages. Never changes the active target.",
    parameters: {
      type: 'OBJECT',
      properties: {
        session: { type: 'STRING', description: 'Conductor session id or exact title. Omit for the active target.' },
        count: { type: 'INTEGER', description: 'How many recent messages to return, 1–10. Default 1.' },
      },
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

const HANDLERS = {
  list_conductor_sessions: (_args, service) => service.list(),
  create_conductor_session: (_args, service) => service.create(),
  send_to_conductor: (args, service) => {
    if (typeof args.text !== 'string' || args.text.trim() === '') throw new ArgError('text must be a non-empty string');
    return service.send({ text: args.text, session: optionalString(args, 'session') });
  },
  read_conductor_messages: (args, service) => {
    let count = 1;
    if (args.count !== undefined && args.count !== null) {
      if (!Number.isInteger(args.count) || args.count < 1 || args.count > 10) throw new ArgError('count must be an integer from 1 to 10');
      count = args.count;
    }
    return service.read({ session: optionalString(args, 'session'), count });
  },
};

export async function callTool(name, args, service) {
  const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : null;
  if (!handler) return { ok: false, code: 'UNKNOWN_TOOL', message: `unknown tool: ${String(name)}` };
  const a = args === undefined || args === null ? {} : args;
  if (typeof a !== 'object' || Array.isArray(a)) return { ok: false, code: 'INVALID_ARGS', message: 'args must be an object' };
  try {
    return await handler(a, service);
  } catch (e) {
    if (e instanceof ArgError) return { ok: false, code: 'INVALID_ARGS', message: e.message };
    if (e && typeof e.code === 'string') return { ok: false, code: e.code, message: e.message };
    console.error('code-live: tool', name, 'failed:', e);
    return { ok: false, code: 'INTERNAL_ERROR', message: String(e?.message ?? e) };
  }
}
