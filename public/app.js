// Page wiring: builds the modules, connects the controls, and runs the
// microphone and speaker for a live session.
import { createApi } from './api.js';
import { createTranscript } from './transcript.js';
import { installSettings } from './settings.js';
import { installTargetPicker } from './targetPicker.js';
import { createLiveSession } from './liveSession.js';
import { installAnnouncements } from './announcements.js';
import { createPlayer } from './player.js';
import { downsample, floatToPcm16, pcm16ToBase64 } from './audio.js';
import { el } from './dom.js';

const $ = (id) => document.getElementById(id);
const CHUNK_SECONDS = 0.1;

const api = createApi();
const transcript = createTranscript($('transcript'));
installSettings($('settings'), api);
const targetPicker = installTargetPicker($('target'), api, { onError: (e) => transcript.add('error', e.message) });
const hostIndicator = {
  set(connected) {
    $('host').textContent = connected ? 'Host connected' : 'Host disconnected';
    $('host').dataset.state = connected ? 'on' : 'off';
  },
};

let audioCtx = null;
let player = null;
let micStop = null;

const session = createLiveSession({ api, onEvent });

function onEvent(ev) {
  switch (ev.type) {
    case 'state':
      $('state').textContent = ev.state;
      $('state').dataset.state = ev.state;
      $('connect').disabled = !(ev.state === 'idle' || ev.state === 'error');
      $('disconnect').disabled = ev.state === 'idle' || ev.state === 'error';
      if (ev.detail) transcript.add(ev.state === 'error' ? 'error' : 'status', ev.detail);
      if (ev.state === 'live' && !micStop) startMic().catch((e) => transcript.add('error', `Microphone: ${e.message}`));
      if (ev.state === 'idle' || ev.state === 'error') stopMic();
      break;
    case 'audio': player?.enqueue(ev.data); break;
    case 'input_transcript': transcript.appendStream('you', ev.text); break;
    case 'output_transcript': transcript.appendStream('gemini', ev.text); break;
    case 'turn_complete': transcript.endTurn(); break;
    case 'interrupted': player?.flush(); transcript.endTurn(); break;
    case 'tool_call': transcript.add('tool_call', ev.args, { name: ev.name }); break;
    case 'tool_result': transcript.add('tool_result', ev.result, { name: ev.name }); break;
    case 'tool_cancelled': transcript.add('status', `Tool call cancelled (${ev.ids.join(', ')})`); break;
  }
}

async function startMic() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  await audioCtx.audioWorklet.addModule('mic-worklet.js');
  const source = audioCtx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(audioCtx, 'pcm-capture');
  const want = Math.round(audioCtx.sampleRate * CHUNK_SECONDS);
  let buf = [];
  let len = 0;
  node.port.onmessage = ({ data }) => {
    buf.push(data);
    len += data.length;
    if (len < want) return;
    const all = new Float32Array(len);
    let off = 0;
    for (const b of buf) { all.set(b, off); off += b.length; }
    buf = [];
    len = 0;
    session.sendAudio(pcm16ToBase64(floatToPcm16(downsample(all, audioCtx.sampleRate, 16000))));
  };
  source.connect(node);
  micStop = () => {
    node.port.onmessage = null;
    source.disconnect();
    node.disconnect();
    for (const t of stream.getTracks()) t.stop();
  };
}

function stopMic() {
  if (micStop) { micStop(); micStop = null; }
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
targetPicker.load();

const eventSource = new EventSource('api/events');
installAnnouncements({ eventSource, transcript, session, targetPicker, hostIndicator });
