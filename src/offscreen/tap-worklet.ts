// AudioWorklet that turns one audio input into 1-second blocks of 16-bit PCM for
// transcription. It runs in a 16 kHz AudioContext, so the browser has already
// resampled the input; this only mixes to mono and converts.
//
// Messages out: { pcm: ArrayBuffer } per full block, and { flushed: true } after
// a { flush: true } request, preceded by any partial block.

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;
declare const sampleRate: number;

class Tap extends AudioWorkletProcessor {
  private block = new Int16Array(sampleRate); // one second
  private filled = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<{ flush?: boolean }>) => {
      if (!event.data.flush) return;
      if (this.filled > 0) this.emit(this.block.slice(0, this.filled));
      this.filled = 0;
      this.port.postMessage({ flushed: true });
    };
  }

  private emit(pcm: Int16Array): void {
    this.port.postMessage({ pcm: pcm.buffer }, [pcm.buffer]);
  }

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const frames = channels[0]!.length;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (const ch of channels) sum += ch[i]!;
      const s = Math.max(-1, Math.min(1, sum / channels.length));
      this.block[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.filled === this.block.length) {
        this.emit(this.block);
        this.block = new Int16Array(sampleRate);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("dohra-tap", Tap);
