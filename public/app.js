// Page wiring: builds the modules, connects the controls, and runs the
// microphone and speaker for a live session.
import { createApi } from './api.js';
import { createTranscript } from './transcript.js';
import { installSettings } from './settings.js';
import { createLiveSession } from './liveSession.js';
import { installAnnouncements } from './announcements.js';
import { createEventStream } from './events.js';
import { createPlayer } from './player.js';
import { createSessionView } from './sessionView.js';
import { installMicControl } from './micControl.js';
import { createChunker, downsample, floatToPcm16, pcm16ToBase64 } from './audio.js';
import { el } from './dom.js';

const $ = (id) => document.getElementById(id);
const CHUNK_SECONDS = 0.1;

const api = createApi();
const transcript = createTranscript($('transcript'));
installSettings($('settings'), api);
const hostIndicator = {
  set(connected) {
    $('host').textContent = connected ? 'Host connected' : 'Host disconnected';
    $('host').dataset.state = connected ? 'on' : 'off';
  },
};

let audioCtx = null;
let player = null;
let mic = null; // the current capture: claimed before the first await; its `stop` releases whatever has been acquired so far

const view = createSessionView({
  transcript,
  // The player exists only after the first Connect (it needs the AudioContext).
  player: { enqueue: (b64) => player?.enqueue(b64), flush: () => player?.flush() },
});
const session = createLiveSession({ api, onEvent });
// onEvent only fires after a user action, so it can reference micControl.
const micControl = installMicControl({ button: $('pause'), indicator: $('mic'), session });

function onEvent(ev) {
  if (ev.type === 'mic') { micControl.render(); return; }
  if (ev.type !== 'state') { view.handle(ev); return; }
  $('state').textContent = ev.state;
  $('state').dataset.state = ev.state;
  micControl.render();
  // Disconnect stays enabled while connecting/reconnecting so a stuck attempt can be abandoned.
  $('connect').disabled = !(ev.state === 'idle' || ev.state === 'error');
  $('disconnect').disabled = ev.state === 'idle' || ev.state === 'error';
  if (ev.detail) transcript.add(ev.state === 'error' ? 'error' : 'status', ev.detail);
  if (ev.state === 'live' && !mic) startMic();
  if (ev.state === 'idle' || ev.state === 'error') stopMic();
}

// One capture per session: `mic` is claimed before the first await, so a
// 'live' that lands while a start is pending (a resume) starts nothing. A
// start that stopMic abandoned stops what it acquired and builds nothing.
function startMic() {
  const claim = { stop: null };
  mic = claim;
  openMic(claim).catch((e) => {
    if (mic === claim) mic = null;
    transcript.add('error', `Microphone: ${e.message}`);
  });
}

// Sets `claim.stop` to a release of everything acquired so far, as soon as
// something is acquired, so stopMic never waits for a pending step. A failure
// after getUserMedia stops the stream before rejecting.
async function openMic(claim) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  const stopTracks = () => { for (const t of stream.getTracks()) t.stop(); };
  claim.stop = stopTracks;
  try {
    if (mic !== claim) { stopTracks(); return; }
    await audioCtx.audioWorklet.addModule('mic-worklet.js');
    if (mic !== claim) { stopTracks(); return; }
    const source = audioCtx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(audioCtx, 'pcm-capture');
    const want = Math.round(audioCtx.sampleRate * CHUNK_SECONDS);
    const chunker = createChunker(want, (all) => session.sendAudio(pcm16ToBase64(floatToPcm16(downsample(all, audioCtx.sampleRate, 16000)))));
    // A pause keeps the mic open but discards what it captures.
    node.port.onmessage = ({ data }) => (session.micPaused ? chunker.clear() : chunker.push(data));
    source.connect(node);
    claim.stop = () => {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      stopTracks();
    };
  } catch (e) {
    stopTracks();
    throw e;
  }
}

function stopMic() {
  mic?.stop?.();
  mic = null;
  player?.flush();
}

$('connect').addEventListener('click', async () => {
  // The AudioContext must be created from a user gesture.
  if (!audioCtx) { audioCtx = new AudioContext(); player = createPlayer(audioCtx); }
  await audioCtx.resume();
  session.connect($('model').value);
});
$('disconnect').addEventListener('click', () => session.disconnect());

api.getModels()
  .then(({ models }) => $('model').replaceChildren(...models.map((m) => el('option', { value: m.id }, m.hint ? `${m.label} (${m.hint})` : m.label))))
  .catch((e) => transcript.add('error', `Loading models failed: ${e.message}`));

const eventSource = createEventStream({ url: 'api/events' });
installAnnouncements({ eventSource, transcript, session, hostIndicator });
