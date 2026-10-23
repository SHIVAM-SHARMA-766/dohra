// Feeds transcription: taps the tab ("them") and the microphone ("me") separately,
// so the transcript knows who spoke without guessing. Runs alongside the recorder
// in its own 16 kHz AudioContext, the rate Whisper consumes.

export type TapStream = "them" | "me";

export class Tap {
  private nodes: AudioWorkletNode[] = [];

  private constructor(private ctx: AudioContext) {}

  static async create(
    inputs: Partial<Record<TapStream, MediaStream>>,
    onBlock: (stream: TapStream, pcm: Int16Array) => void,
  ): Promise<Tap> {
    const ctx = new AudioContext({ sampleRate: 16000 });
    const tap = new Tap(ctx);
    try {
      await ctx.audioWorklet.addModule(chrome.runtime.getURL("tap-worklet.js"));
      for (const [stream, media] of Object.entries(inputs) as [TapStream, MediaStream][]) {
        const source = ctx.createMediaStreamSource(new MediaStream(media.getAudioTracks()));
        const node = new AudioWorkletNode(ctx, "dohra-tap", { numberOfOutputs: 1 });
        node.port.onmessage = (event: MessageEvent<{ pcm?: ArrayBuffer }>) => {
          if (event.data.pcm) onBlock(stream, new Int16Array(event.data.pcm));
        };
        source.connect(node);
        // A node only runs while connected toward the destination; it outputs silence.
        node.connect(ctx.destination);
        tap.nodes.push(node);
      }
    } catch (e) {
      await ctx.close();
      throw e;
    }
    return tap;
  }

  /** Emits any partial block, so no audio before this point is lost. */
  async flush(): Promise<void> {
    await Promise.all(
      this.nodes.map(
        (node) =>
          new Promise<void>((resolve) => {
            const previous = node.port.onmessage;
            node.port.onmessage = (event: MessageEvent<{ pcm?: ArrayBuffer; flushed?: boolean }>) => {
              if (event.data.flushed) resolve();
              else previous?.call(node.port, event);
            };
            node.port.postMessage({ flush: true });
          }),
      ),
    );
  }

  async close(): Promise<void> {
    for (const node of this.nodes) node.disconnect();
    await this.ctx.close();
  }
}
