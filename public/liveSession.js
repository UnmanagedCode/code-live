// Gemini Live session client (DOM-free). Connects with an ephemeral token
// minted by the backend, turns server messages into events, runs tool calls
// through the backend, and resumes on goAway or an unexpected close using the
// latest resumption handle.
const MIME_IN = 'audio/pcm;rate=16000';

function decode(data) {
  let text;
  if (typeof data === 'string') text = data;
  else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) text = new TextDecoder().decode(data);
  else return null;
  try {
    const msg = JSON.parse(text);
    return msg && typeof msg === 'object' ? msg : null;
  } catch {
    return null;
  }
}

export function createLiveSession({
  api,
  WebSocketImpl = globalThis.WebSocket,
  onEvent = () => {},
  maxResumeFailures = 3,
  setupTimeoutMs = 15000,
  timers = { setTimeout: (...a) => setTimeout(...a), clearTimeout: (t) => clearTimeout(t) },
}) {
  let ws = null;
  let pending = null; // socket still waiting for setupComplete
  let state = 'idle';
  let model = null;
  let handle = null;
  let generation = 0; // bumped by connect/disconnect so stale sockets are ignored
  const cancelled = new Set();

  const emit = (ev) => { try { onEvent(ev); } catch (e) { console.error('code-live: onEvent failed', e); } };

  function setState(s, detail) {
    state = s;
    emit({ type: 'state', state: s, ...(detail ? { detail } : {}) });
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // Opens a socket, sends the (empty) client setup and resolves once the
  // server's setupComplete arrives; from then on the socket is current. No
  // setupComplete within setupTimeoutMs closes the socket and rejects.
  async function open(gen, resumeHandle) {
    const tok = await api.mintToken(model, resumeHandle);
    if (gen !== generation) throw new Error('superseded');
    return new Promise((resolve, reject) => {
      const sock = new WebSocketImpl(tok.wsUrl + '?access_token=' + encodeURIComponent(tok.token));
      sock.binaryType = 'arraybuffer';
      pending = sock;
      let ready = false;
      const fail = (message) => {
        ready = true;
        timers.clearTimeout(timer);
        if (pending === sock) pending = null;
        reject(new Error(message));
      };
      const timer = timers.setTimeout(() => {
        if (ready) return;
        fail(`Gemini did not complete setup within ${Math.round(setupTimeoutMs / 1000)} s`);
        sock.close();
      }, setupTimeoutMs);
      sock.addEventListener('open', () => sock.send(JSON.stringify({ setup: {} })));
      sock.addEventListener('message', (ev) => {
        const msg = decode(ev.data);
        if (!msg) return;
        if (!ready) {
          if (!msg.setupComplete) return;
          ready = true;
          timers.clearTimeout(timer);
          if (pending === sock) pending = null;
          if (gen !== generation) { sock.close(1000); reject(new Error('superseded')); return; }
          ws = sock;
          resolve();
          return;
        }
        if (ws === sock) handleMessage(msg);
      });
      sock.addEventListener('close', (ev) => {
        if (!ready) { fail(`Gemini closed the connection (${ev.code}${ev.reason ? ': ' + ev.reason : ''})`); return; }
        if (ws !== sock) return;
        ws = null;
        if (state === 'live' && handle) resume();
        else if (state === 'live') setState('error', `Gemini closed the connection (${ev.code}${ev.reason ? ': ' + ev.reason : ''})`);
      });
    });
  }

  async function resume() {
    if (state === 'reconnecting') return;
    if (!handle) { setState('error', 'The connection ended and cannot be resumed.'); return; }
    const gen = generation;
    setState('reconnecting');
    const old = ws;
    ws = null;
    if (old) old.close(1000);
    let lastError = null;
    for (let failures = 0; failures < maxResumeFailures; failures++) {
      try {
        await open(gen, handle);
        if (gen !== generation) return;
        setState('live');
        return;
      } catch (e) {
        if (gen !== generation) return;
        lastError = e;
      }
    }
    setState('error', `Could not resume the session: ${lastError?.message ?? 'unknown error'}`);
  }

  async function runTool(call) {
    const { id, name } = call;
    const args = call.args ?? {};
    emit({ type: 'tool_call', id, name, args });
    let result;
    try { result = await api.callTool(name, args); }
    catch (e) { result = { ok: false, code: 'CLIENT_ERROR', message: String(e?.message ?? e) }; }
    emit({ type: 'tool_result', id, name, result });
    if (cancelled.has(id)) { cancelled.delete(id); return; }
    send({ toolResponse: { functionResponses: [{ id, name, response: result }] } });
  }

  function handleMessage(msg) {
    const sc = msg.serverContent;
    if (sc) {
      for (const part of sc.modelTurn?.parts ?? []) {
        const d = part.inlineData;
        if (d && typeof d.data === 'string' && String(d.mimeType).startsWith('audio/')) emit({ type: 'audio', data: d.data, mimeType: d.mimeType });
      }
      if (sc.inputTranscription?.text) emit({ type: 'input_transcript', text: sc.inputTranscription.text });
      if (sc.outputTranscription?.text) emit({ type: 'output_transcript', text: sc.outputTranscription.text });
      if (sc.interrupted) emit({ type: 'interrupted' });
      if (sc.turnComplete) emit({ type: 'turn_complete', interactionStatus: sc.interactionStatus ?? null });
    }
    if (msg.toolCall) for (const call of msg.toolCall.functionCalls ?? []) runTool(call);
    if (msg.toolCallCancellation) {
      const ids = msg.toolCallCancellation.ids ?? [];
      for (const id of ids) cancelled.add(id);
      emit({ type: 'tool_cancelled', ids });
    }
    const upd = msg.sessionResumptionUpdate;
    if (upd && upd.resumable && upd.newHandle) handle = upd.newHandle;
    if (msg.goAway) resume();
  }

  return {
    get state() { return state; },

    async connect(modelId) {
      if (state !== 'idle' && state !== 'error') return;
      const gen = ++generation;
      model = modelId;
      handle = null;
      cancelled.clear();
      setState('connecting');
      try {
        await open(gen, null);
        if (gen === generation) setState('live');
      } catch (e) {
        if (gen === generation) setState('error', String(e?.message ?? e));
      }
    },

    // Works in every state, including mid-connect and mid-resume: the
    // handshaking socket is closed and the in-flight attempt is abandoned.
    disconnect() {
      generation++;
      const sock = ws;
      const handshaking = pending;
      ws = null;
      pending = null;
      handle = null;
      if (sock) sock.close(1000);
      if (handshaking) handshaking.close(1000);
      if (state !== 'idle') setState('idle');
    },

    sendAudio(data) {
      if (state === 'live') send({ realtimeInput: { audio: { data, mimeType: MIME_IN } } });
    },

    endAudio() {
      if (state === 'live') send({ realtimeInput: { audioStreamEnd: true } });
    },

    sendText(text) {
      if (state === 'live') send({ realtimeInput: { text } });
    },
  };
}
