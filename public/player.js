// Gapless playback of Gemini's 24 kHz PCM16 audio chunks.
import { base64ToPcm16, pcm16ToFloat } from './audio.js';

const RATE = 24000;

export function createPlayer(ctx) {
  let nextStart = 0;
  const sources = new Set();
  return {
    enqueue(b64) {
      const samples = pcm16ToFloat(base64ToPcm16(b64));
      if (samples.length === 0) return;
      const buf = ctx.createBuffer(1, samples.length, RATE);
      buf.getChannelData(0).set(samples);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const at = Math.max(ctx.currentTime, nextStart);
      src.start(at);
      nextStart = at + buf.duration;
      sources.add(src);
      src.onended = () => sources.delete(src);
    },
    // Stops everything queued; used when Gemini reports it was interrupted.
    flush() {
      for (const src of sources) { try { src.stop(); } catch { /* not started */ } }
      sources.clear();
      nextStart = 0;
    },
  };
}
