// The page's one controller: builds the modules, runs the session, the
// microphone and the speaker, and holds what the components render. It is
// built once, outside React, so nothing it owns follows a component's
// lifecycle: the call, the mic and the event stream keep running while cc
// hides this keep-alive page. Browser globals are injectable for tests.
import { createApi } from './api.js';
import { createTranscriptStore } from './transcriptStore.js';
import { createSettings } from './settings.js';
import { createLiveSession } from './liveSession.js';
import { installAnnouncements } from './announcements.js';
import { createEventStream } from './events.js';
import { createPlayer } from './player.js';
import { createSessionView } from './sessionView.js';
import { createMicCapture } from './micCapture.js';
import { createStore } from './store.js';
import { isConnected } from './controls.js';

// getUserMedia's refusals of the permission itself (not a missing or busy device).
const BLOCKED = new Set(['NotAllowedError', 'SecurityError']);

/**
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   WebSocketImpl?: any,
 *   EventSourceImpl?: any,
 *   AudioContextImpl?: any,
 *   AudioWorkletNodeImpl?: any,
 *   mediaDevices?: any,
 *   now?: () => Date,
 * }} [env]
 */
export function createAppController({
  fetchImpl,
  WebSocketImpl,
  EventSourceImpl,
  AudioContextImpl = globalThis.AudioContext,
  AudioWorkletNodeImpl,
  mediaDevices = globalThis.navigator?.mediaDevices,
  now,
} = {}) {
  const api = createApi(fetchImpl);
  const transcript = createTranscriptStore();
  const settings = createSettings(api);
  const store = createStore({
    state: 'idle',
    micPaused: false,
    hostConnected: false,
    models: /** @type {{ id: string, label: string, hint?: string }[]} */ ([]),
    modelsError: /** @type {string | null} */ (null),
    modelId: '',
    micBlocked: false, // the last capture was refused the microphone permission
  });

  let audioCtx = null;
  let player = null;

  const view = createSessionView({
    transcript,
    // The player exists only after the first Connect (it needs the AudioContext).
    player: { enqueue: (b64) => player?.enqueue(b64), flush: () => player?.flush() },
    ...(now ? { now } : {}),
  });
  const session = createLiveSession({ api, WebSocketImpl, onEvent });
  const mic = createMicCapture({
    getContext: () => audioCtx,
    session,
    mediaDevices,
    AudioWorkletNodeImpl,
    onError(e) {
      transcript.add('error', `Microphone: ${e.message}`);
      if (BLOCKED.has(e?.name)) store.set({ micBlocked: true });
    },
    onStarted: () => store.set({ micBlocked: false }),
  });

  function stopMic() {
    mic.stop();
    player?.flush();
  }

  function onEvent(ev) {
    if (ev.type === 'mic') { store.set({ micPaused: session.micPaused }); return; }
    view.handle(ev);
    if (ev.type !== 'state') return;
    store.set({ state: ev.state, micPaused: session.micPaused, ...(ev.state === 'idle' ? { micBlocked: false } : {}) });
    if (ev.detail) transcript.add(ev.state === 'error' ? 'error' : 'status', ev.detail);
    if (ev.state === 'live' && !mic.active) mic.start();
    if (ev.state === 'idle' || ev.state === 'error') stopMic();
  }

  api.getModels().then(
    ({ models }) => store.set({ models, modelId: models[0]?.id ?? '' }),
    (e) => {
      store.set({ modelsError: e.message });
      transcript.add('error', `Loading models failed: ${e.message}`);
    },
  );
  settings.load();

  const eventSource = createEventStream({ url: 'api/events', EventSourceImpl });
  installAnnouncements({ eventSource, transcript, session, hostIndicator: { set: (connected) => store.set({ hostConnected: connected }) } });

  return {
    store,
    transcript,
    settings,

    // Connects from idle or error, disconnects from live or reconnecting, and
    // does nothing while connecting. Call it from the click: the AudioContext
    // must be created and resumed from a user gesture.
    async toggleConnect() {
      if (isConnected(session.state)) { session.disconnect(); return; }
      if (session.state !== 'idle' && session.state !== 'error') return;
      if (!audioCtx) { audioCtx = new AudioContextImpl(); player = createPlayer(audioCtx); }
      await audioCtx.resume();
      session.connect(store.get().modelId);
    },

    toggleMic() {
      if (session.micPaused) session.resumeMic();
      else session.pauseMic();
    },

    /** @param {string} modelId */
    setModel(modelId) { store.set({ modelId }); },
  };
}
