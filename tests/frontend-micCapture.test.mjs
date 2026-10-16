// Pins the mic capture lifecycle at unit level: a start acquires the stream,
// loads the worklet by its relative URL and builds one pcm-capture node; frames
// go out as 100 ms chunks of 16 kHz PCM16, and a pause discards frames and the
// partial chunk. A stop releases whatever a start has acquired so far, at once,
// however the start's steps are still pending; an abandoned start builds
// nothing; a failure releases the stream and clears the claim, unless a newer
// start holds it. onStarted fires only for a completed capture.
// The sample rate equals Gemini's 16 kHz input, so downsample is the identity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMicCapture } from '../frontend/src/lib/micCapture.js';
import { base64ToPcm16 } from '../frontend/src/lib/audio.js';

const tick = () => new Promise((r) => setImmediate(r));

function deferred() {
  const d = {};
  d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
  return d;
}

function setup({ gum, loadModule = async () => {} } = {}) {
  const streams = [];
  const nodes = [];
  const modules = [];
  const sent = [];
  const errors = [];
  let started = 0;
  const fakeStream = () => {
    const track = { stopped: false, stop() { this.stopped = true; } };
    const stream = { tracks: [track], getTracks() { return this.tracks; } };
    streams.push(stream);
    return stream;
  };
  const constraints = [];
  const ctx = {
    sampleRate: 16000,
    audioWorklet: { addModule: (url) => { modules.push(url); return loadModule(); } },
    createMediaStreamSource: () => ({ connected: false, connect() { this.connected = true; }, disconnect() { this.disconnected = true; } }),
  };
  class Node {
    port = {};
    constructor(c, name) { this.ctx = c; this.name = name; nodes.push(this); }
    connect() {}
    disconnect() { this.disconnected = true; }
  }
  const session = { micPaused: false, sendAudio: (d) => sent.push([...base64ToPcm16(d)]) };
  const mic = createMicCapture({
    getContext: () => ctx,
    session,
    mediaDevices: { getUserMedia: (c) => { constraints.push(c); return gum ? gum(fakeStream) : Promise.resolve(fakeStream()); } },
    AudioWorkletNodeImpl: Node,
    onError: (e) => errors.push(e),
    onStarted: () => { started++; },
  });
  return { mic, ctx, session, streams, nodes, modules, sent, errors, constraints, fakeStream, started: () => started };
}

const frame = (n, v) => ({ data: new Float32Array(n).fill(v) });

test('a start builds one pcm-capture node from the relative worklet URL and sends 100 ms PCM16 chunks', async () => {
  const s = setup();
  s.mic.start();
  assert.equal(s.mic.active, true, 'claimed before the first await');
  await tick();
  assert.deepEqual(s.constraints, [{ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }]);
  assert.deepEqual(s.modules, ['mic-worklet.js']);
  assert.equal(s.nodes.length, 1);
  assert.equal(s.nodes[0].name, 'pcm-capture');
  assert.equal(s.nodes[0].ctx, s.ctx);
  assert.equal(s.started(), 1);
  s.nodes[0].port.onmessage(frame(700, 0.25));
  s.nodes[0].port.onmessage(frame(700, 0.25));
  assert.equal(s.sent.length, 0, '1400 samples are under 100 ms at 16 kHz');
  s.nodes[0].port.onmessage(frame(700, 0.25));
  assert.equal(s.sent.length, 1, 'the third frame crosses 1600 samples and flushes what was held');
  assert.equal(s.sent[0].length, 2100);
  assert.ok(s.sent[0].every((x) => x === 8192));
});

test('while paused, frames and the partial chunk before the pause are discarded', async () => {
  const s = setup();
  s.mic.start();
  await tick();
  const feed = (n, v) => s.nodes[0].port.onmessage(frame(n, v));
  feed(700, 0.5); // partial chunk held when the pause starts
  s.session.micPaused = true;
  feed(700, -0.5);
  s.session.micPaused = false;
  feed(700, 0.25); feed(700, 0.25); feed(700, 0.25);
  assert.equal(s.sent.length, 1);
  assert.ok(s.sent[0].every((x) => x === 8192), 'only post-resume samples');
});

test('stop releases a completed capture: tracks stopped, node and source disconnected, handler dropped', async () => {
  const s = setup();
  s.mic.start();
  await tick();
  s.mic.stop();
  assert.equal(s.mic.active, false);
  assert.equal(s.streams[0].tracks[0].stopped, true);
  assert.equal(s.nodes[0].port.onmessage, null);
  assert.equal(s.nodes[0].disconnected, true);
});

test('stop while getUserMedia is pending stops the track once it resolves and builds no node', async () => {
  const d = deferred();
  const s = setup({ gum: () => d.promise });
  s.mic.start();
  s.mic.stop();
  d.resolve(s.fakeStream());
  await tick();
  assert.equal(s.streams[0].tracks[0].stopped, true);
  assert.equal(s.modules.length, 0, 'the abandoned start loads no worklet');
  assert.equal(s.nodes.length, 0);
  assert.equal(s.started(), 0);
});

test('stop while the worklet never loads stops the track at once', async () => {
  const s = setup({ loadModule: () => new Promise(() => {}) });
  s.mic.start();
  await tick();
  assert.equal(s.modules.length, 1);
  s.mic.stop();
  assert.equal(s.streams[0].tracks[0].stopped, true);
  assert.equal(s.nodes.length, 0);
});

test('a failure after getUserMedia stops the stream, reports the error and clears the claim', async () => {
  const s = setup({ loadModule: () => Promise.reject(new Error('module failed')) });
  s.mic.start();
  await tick();
  assert.equal(s.streams[0].tracks[0].stopped, true);
  assert.deepEqual(s.errors.map((e) => e.message), ['module failed']);
  assert.equal(s.mic.active, false);
  assert.equal(s.started(), 0);
});

test("a stale start's rejection does not clear the newer claim", async () => {
  const a = deferred();
  const queue = [a.promise];
  const s = setup({ gum: (make) => queue.shift() ?? Promise.resolve(make()) });
  s.mic.start();
  s.mic.stop();
  s.mic.start(); // the newer capture, which completes
  await tick();
  assert.equal(s.nodes.length, 1);
  a.reject(new Error('A denied'));
  await tick();
  assert.deepEqual(s.errors.map((e) => e.message), ['A denied']);
  assert.equal(s.mic.active, true, 'the newer claim survives');
});
