// AudioWorklet that forwards copies of the microphone's input frames to the
// main thread. Loaded with audioWorklet.addModule, so it cannot import.
class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
