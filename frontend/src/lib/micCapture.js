// The microphone capture of a live session: getUserMedia → the pcm-capture
// AudioWorklet → 100 ms chunks → 16 kHz PCM16 base64 to session.sendAudio.
import { createChunker, downsample, floatToPcm16, pcm16ToBase64 } from './audio.js';

const CHUNK_SECONDS = 0.1;

/**
 * @param {{
 *   getContext: () => any,
 *   session: { sendAudio(data: string): void, readonly micPaused: boolean },
 *   mediaDevices?: { getUserMedia(c: object): Promise<any> },
 *   AudioWorkletNodeImpl?: any,
 *   onError: (e: any) => void,
 *   onStarted?: () => void,
 * }} deps
 */
export function createMicCapture({ getContext, session, mediaDevices, AudioWorkletNodeImpl = globalThis.AudioWorkletNode, onError, onStarted = () => {} }) {
  let mic = null; // the current capture: claimed before the first await; its `stop` releases whatever has been acquired so far

  // One capture per session: `mic` is claimed before the first await, so a
  // 'live' that lands while a start is pending (a resume) starts nothing. A
  // start that stop() abandoned stops what it acquired and builds nothing.
  function start() {
    const claim = { stop: null };
    mic = claim;
    open(claim).catch((e) => {
      if (mic === claim) mic = null;
      onError(e);
    });
  }

  // Sets `claim.stop` to a release of everything acquired so far, as soon as
  // something is acquired, so stop() never waits for a pending step. A failure
  // after getUserMedia stops the stream before rejecting.
  async function open(claim) {
    const stream = await mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    const stopTracks = () => { for (const t of stream.getTracks()) t.stop(); };
    claim.stop = stopTracks;
    try {
      if (mic !== claim) { stopTracks(); return; }
      const audioCtx = getContext();
      await audioCtx.audioWorklet.addModule('mic-worklet.js');
      if (mic !== claim) { stopTracks(); return; }
      const source = audioCtx.createMediaStreamSource(stream);
      const node = new AudioWorkletNodeImpl(audioCtx, 'pcm-capture');
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
    onStarted();
  }

  return {
    start,
    stop() {
      mic?.stop?.();
      mic = null;
    },
    /** Whether a capture is claimed (started, or still starting). */
    get active() { return mic !== null; },
  };
}
