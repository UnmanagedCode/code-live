// The one adapter for code-conductor's MCP endpoint. code-live calls the bare
// `POST <host>/mcp` (stateless JSON-RPC `tools/call`, no initialize, no session
// header), which is outside the sanctioned plugin API: a host change can break
// it without a manifest-level signal. Every such call lives here. Moving to a
// sanctioned host-tool path means editing MCP_PATH, `callTool` and the plugin
// manifest, and nothing else.
//
// `sessionId` in every method is the host's public session id (the instance
// row's `sessionId`), not the instance row's `id`.

const MCP_PATH = '/mcp';
const BOUNDARY = /^--- message \d+\/\d+ · .* chars ---\n?/;

function mcpError(code, message, detail) {
  return Object.assign(new Error(message), { code, ...(detail !== undefined ? { detail } : {}) });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

// Pairs get_recent_messages' metadata with its bodies, one entry per message,
// dropping the boundary line the host prefixes when several messages return.
export function pairMessages({ meta, bodies }) {
  const messages = Array.isArray(meta?.messages) ? meta.messages : [];
  return messages.map((m, i) => ({
    msgId: m.msgId,
    text: String(bodies[i] ?? '').replace(BOUNDARY, ''),
    ...(m.hasPlan ? { hasPlan: true } : {}),
    ...(m.planPath ? { planPath: m.planPath } : {}),
    ...(typeof m.questionCount === 'number' ? { questionCount: m.questionCount } : {}),
  }));
}

export function createHostMcp({ baseUrl, fetchImpl = fetch, timeoutMs = 10000 }) {
  let nextId = 0;

  // Resolves to the `content[].text` strings of a successful tool result.
  async function callTool(name, args, { mutating = false } = {}) {
    const ctl = new AbortController();
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ctl.abort();
        reject(mcpError('HOST_TIMEOUT', mutating
          ? `code-conductor did not answer ${name} in time; it may have been delivered, so do not resend without checking`
          : `code-conductor did not answer ${name} in time`));
      }, timeoutMs);
    });
    const exchange = (async () => {
      let res;
      try {
        res = await fetchImpl(baseUrl + MCP_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method: 'tools/call', params: { name, arguments: args } }),
          signal: ctl.signal,
        });
      } catch (e) {
        throw mcpError('HOST_UNAVAILABLE', `code-conductor is unreachable (${e?.message ?? e})`);
      }
      if (!res.ok) throw mcpError('HOST_HTTP_ERROR', `code-conductor POST ${MCP_PATH} failed: HTTP ${res.status}`);
      return res.json().catch(() => null);
    })();
    let body;
    try {
      // The timeout covers reading the body too, not only the response head.
      body = await Promise.race([exchange, timedOut]);
    } finally {
      clearTimeout(timer);
    }
    if (body?.error) throw mcpError('HOST_MCP_ERROR', `code-conductor ${name} failed: ${body.error.message ?? 'no reason given'}`);
    const content = body?.result?.content;
    if (!Array.isArray(content) || content.some((c) => typeof c?.text !== 'string') || content.length === 0) {
      throw mcpError('HOST_MCP_ERROR', `code-conductor ${name} returned an unreadable result`);
    }
    if (body.result.isError) throw mcpError('HOST_MCP_ERROR', `code-conductor ${name} failed: ${content[0].text}`);
    const texts = content.map((c) => c.text);
    const first = parseJson(texts[0]);
    if (first && typeof first === 'object' && first.ok === false) {
      const { ok, code, reason, ...detail } = first;
      throw mcpError(typeof code === 'string' ? code : 'HOST_MCP_ERROR', typeof reason === 'string' ? reason : `code-conductor refused ${name}`, detail);
    }
    return texts;
  }

  async function objectResult(name, args) {
    const texts = await callTool(name, args, { mutating: true });
    const out = parseJson(texts[0]);
    if (!out || typeof out !== 'object') throw mcpError('HOST_MCP_ERROR', `code-conductor ${name} returned an unreadable result`);
    return out;
  }

  const withFeedback = (sessionId, feedback) => ({ sessionId, ...(feedback ? { feedback } : {}) });

  return {
    // No `count` is sent: the host's default call bonds a trailing prose
    // message back to the turn's plan/questions message.
    async recentMessages(sessionId, { count } = {}) {
      const texts = await callTool('get_recent_messages', { sessionId, ...(count !== undefined ? { count } : {}) });
      const meta = parseJson(texts[0]);
      if (!meta || typeof meta !== 'object') throw mcpError('HOST_MCP_ERROR', 'code-conductor get_recent_messages returned unreadable metadata');
      return { meta, bodies: texts.slice(1) };
    },
    answerQuestion: (sessionId, answers) => objectResult('answer_question', { sessionId, answers }),
    approvePlan: (sessionId, feedback) => objectResult('approve_plan', withFeedback(sessionId, feedback)),
    rejectPlan: (sessionId, feedback) => objectResult('reject_plan', withFeedback(sessionId, feedback)),
  };
}
