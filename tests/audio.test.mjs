// Pins: the PCM conversions feeding Gemini (16 kHz PCM16 in) and the player
// (24 kHz PCM16 out) keep length, clamp and round-trip correctly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downsample, floatToPcm16, pcm16ToFloat, bytesToBase64, base64ToBytes, pcm16ToBase64, base64ToPcm16, createChunker } from '../public/audio.js';

test('downsample keeps the rate ratio and interpolates', () => {
  const input = Float32Array.from({ length: 480 }, (_, i) => i / 480);
  const out = downsample(input, 48000, 16000);
  assert.equal(out.length, 160);
  assert.ok(Math.abs(out[1] - input[3]) < 1e-6);
  assert.equal(downsample(input, 16000, 16000).length, 480);
});

test('floatToPcm16 clamps at ±1', () => {
  assert.deepEqual([...floatToPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5]))], [0, 32767, -32768, 32767, -32768, 16384]);
  assert.deepEqual([...pcm16ToFloat(Int16Array.from([-32768, 0, 16384]))], [-1, 0, 0.5]);
});

test('base64 round-trips bytes and PCM', () => {
  const bytes = Uint8Array.from({ length: 70000 }, (_, i) => (i * 7) & 0xff);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  assert.equal(bytesToBase64(Uint8Array.from([104, 105])), 'aGk=');
  const pcm = Int16Array.from([1, -1, 32767, -32768]);
  assert.deepEqual([...base64ToPcm16(pcm16ToBase64(pcm))], [...pcm]);
});

test('createChunker emits size-sample chunks and clear drops a partial one', () => {
  // Pins: chunks are size-sample concatenations in push order, and clear() discards
  // a partly filled chunk. (That the page calls clear() while paused is pinned by
  // frontend-app.test.mjs.)
  const chunks = [];
  const c = createChunker(8, (all) => chunks.push([...all]));
  c.push(Float32Array.from([1, 2, 3]));
  c.push(Float32Array.from([4, 5, 6]));
  assert.deepEqual(chunks, []);
  c.push(Float32Array.from([7, 8, 9, 10]));
  assert.deepEqual(chunks, [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]);
  c.push(Float32Array.from([-1, -2, -3]));
  c.clear();
  c.push(Float32Array.from([1, 1, 1, 1, 1, 1, 1, 1]));
  assert.deepEqual(chunks[1], [1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(chunks.length, 2);
});
