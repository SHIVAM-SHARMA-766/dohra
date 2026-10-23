// The recorder. Runs in an offscreen document because a Manifest V3 service worker
// has no DOM: no getUserMedia, no MediaRecorder, no AudioContext.
//
// Captures the tab (and optionally the microphone), plays the tab's audio back out —
// tab capture mutes the tab otherwise — and streams the recording to the storage
// worker in chunks. When transcribing, it also taps both sources as 16 kHz PCM and
// passes it to the background for the companion.

import {
  errorMessage,
  type ExportFile,
  type OffscreenRequest,
  type Progress,
  type RecorderEvent,
  type Reply,
  type StartOptions,
} from "../lib/messages";
import { EXPORT_DIR, FILES, SCHEMA_VERSION, type EndReason, type SessionMeta } from "../lib/session";
import { AUDIO_BITS_PER_SECOND, QUALITY, TIMESLICE_MS } from "../lib/settings";
import { recordingFile, StorageWorker } from "../lib/storage";
import { pcmToBase64 } from "../lib/transcript";
import { Tap } from "./tap";

interface Recording {
  options: StartOptions;
  recorder: MediaRecorder;
  streams: MediaStream[];
  audio: AudioContext;
  storage: StorageWorker;
  /** Chunk writes, chained so they land in order. */
  writes: Promise<void>;
  bytes: number;
  /** Recorded time before the current run, and when the current run began (performance.now). */
  accumulatedMs: number;
  runStartedAt: number | null;
  stopping: boolean;
  writeError: string | null;
  tap: Tap | null;
  /** Tapped audio is dropped while paused, keeping it aligned with the recording. */
  tapPaused: boolean;
}

let current: Recording | null = null;
let exportedUrls: string[] = [];

function send(event: RecorderEvent): void {
  chrome.runtime.sendMessage(event).catch(() => {
    // The service worker restarts on demand; a dropped progress update is harmless.
  });
}

function elapsed(r: Recording): number {
  return r.accumulatedMs + (r.runStartedAt === null ? 0 : performance.now() - r.runStartedAt);
}

function progress(r: Recording): Progress {
  return { durationMs: elapsed(r), bytes: r.bytes, paused: r.runStartedAt === null, at: Date.now() };
}

function pickMimeType(video: boolean): string {
  const candidates = video
    ? ["video/webm;codecs=vp8,opus", "video/webm"]
    : ["audio/webm;codecs=opus", "audio/webm"];
  const found = candidates.find((t) => MediaRecorder.isTypeSupported(t));
  if (!found) throw new Error("this browser cannot record WebM");
  return found;
}

async function captureTab(streamId: string, options: StartOptions): Promise<MediaStream> {
  const source = { chromeMediaSource: "tab", chromeMediaSourceId: streamId };
  const q = QUALITY[options.quality];
  // Chrome's tab capture takes the legacy "mandatory" constraint form, which the DOM
  // types do not describe.
  const constraints = {
    audio: { mandatory: source },
    video:
      options.mode === "video"
        ? { mandatory: { ...source, maxWidth: q.width, maxHeight: q.height, maxFrameRate: q.frameRate } }
        : false,
  } as unknown as MediaStreamConstraints;
  return navigator.mediaDevices.getUserMedia(constraints);
}

async function captureMic(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "NotAllowedError") {
      throw new Error("microphone permission not granted — use 'Allow microphone' in the popup first");
    }
    throw e;
  }
}

async function start(streamId: string, options: StartOptions): Promise<void> {
  if (current) throw new Error("already recording");

  const streams: MediaStream[] = [];
  let audio: AudioContext | null = null;
  try {
    const tab = await captureTab(streamId, options);
    streams.push(tab);

    // Mix tab audio (and mic) into one track; send tab audio to the speakers as well.
    audio = new AudioContext();
    const mix = audio.createMediaStreamDestination();
    const tabAudio = audio.createMediaStreamSource(tab);
    tabAudio.connect(audio.destination);
    tabAudio.connect(mix);
    if (options.mic) {
      const mic = await captureMic();
      streams.push(mic);
      audio.createMediaStreamSource(mic).connect(mix); // recorded, not played back
    }

    const video = options.mode === "video";
    const mimeType = pickMimeType(video);
    const recorder = new MediaRecorder(new MediaStream([...mix.stream.getAudioTracks(), ...tab.getVideoTracks()]), {
      mimeType,
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      ...(video ? { videoBitsPerSecond: QUALITY[options.quality].videoBitsPerSecond } : {}),
    });

    const now = new Date().toISOString();
    const meta: SessionMeta = {
      schema: SCHEMA_VERSION,
      id: options.sessionId,
      title: options.title,
      source: options.source,
      mode: options.mode,
      quality: video ? options.quality : null,
      mic: options.mic,
      mimeType,
      recorder: options.recorder,
      state: "recording",
      startedAt: now,
      endedAt: null,
      updatedAt: now,
      durationMs: 0,
      bytes: 0,
      sha256: null,
      endReason: null,
      error: null,
      exportedAt: null,
    };
    const storage = new StorageWorker();
    await storage.call({ op: "open", meta });

    const micStream = options.mic ? streams[1] : undefined;

    const r: Recording = {
      options,
      recorder,
      streams,
      audio,
      storage,
      writes: Promise.resolve(),
      bytes: 0,
      accumulatedMs: 0,
      runStartedAt: null,
      stopping: false,
      writeError: null,
      tap: null,
      tapPaused: false,
    };
    current = r;

    if (options.transcribe) {
      // A failure here costs the transcript, never the recording.
      try {
        r.tap = await Tap.create({ them: tab, ...(micStream ? { me: micStream } : {}) }, (stream, pcm) => {
          if (!r.tapPaused) send({ target: "background", type: "recorder-audio", stream, pcm: pcmToBase64(pcm) });
        });
      } catch (e) {
        send({ target: "background", type: "recorder-tap-failed", error: errorMessage(e) });
      }
    }

    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      const durationMs = elapsed(r);
      r.writes = r.writes.then(async () => {
        if (r.writeError) return;
        try {
          const data = await event.data.arrayBuffer();
          const saved = await storage.call({ op: "append", sessionId: options.sessionId, data, durationMs }, [data]);
          r.bytes = saved.bytes;
          if (!r.stopping) send({ target: "background", type: "recorder-progress", progress: progress(r) });
        } catch (e) {
          // Most likely the disk is full. Stop rather than keep recording into nothing.
          r.writeError = errorMessage(e);
          void stop("capture-error", `saving failed: ${r.writeError}`);
        }
      });
    };
    recorder.onerror = (event) => {
      const error = (event as Event & { error?: DOMException }).error;
      void stop("capture-error", `recorder error: ${error?.message ?? "unknown"}`);
    };
    // The tab's tracks end when the tab is closed or capture is otherwise cut off.
    for (const track of tab.getTracks()) track.onended = () => void stop("tab-closed");

    recorder.start(TIMESLICE_MS);
    r.runStartedAt = performance.now();
    send({ target: "background", type: "recorder-progress", progress: progress(r) });
  } catch (e) {
    for (const s of streams) s.getTracks().forEach((t) => t.stop());
    await audio?.close();
    current = null;
    throw e;
  }
}

function pause(): void {
  const r = current;
  if (!r || r.stopping || r.runStartedAt === null) return;
  r.recorder.pause();
  r.accumulatedMs = elapsed(r);
  r.runStartedAt = null;
  r.tapPaused = true;
  send({ target: "background", type: "recorder-progress", progress: progress(r) });
}

function resume(): void {
  const r = current;
  if (!r || r.stopping || r.runStartedAt !== null) return;
  r.recorder.resume();
  r.runStartedAt = performance.now();
  r.tapPaused = false;
  send({ target: "background", type: "recorder-progress", progress: progress(r) });
}

async function stop(reason: EndReason, error: string | null = null): Promise<void> {
  const r = current;
  if (!r || r.stopping) return;
  r.stopping = true;
  const durationMs = elapsed(r);
  r.runStartedAt = null;

  try {
    if (r.recorder.state !== "inactive") {
      // The final chunk arrives via ondataavailable before onstop fires.
      await new Promise<void>((resolve) => {
        r.recorder.addEventListener("stop", () => resolve(), { once: true });
        r.recorder.stop();
      });
    }
    await r.writes;
    if (r.tap) {
      // Send the last partial second before the background is told we stopped;
      // messages from here arrive in order.
      await r.tap.flush().catch(() => {});
      await r.tap.close().catch(() => {});
    }
    for (const s of r.streams) s.getTracks().forEach((t) => t.stop());
    await r.audio.close();

    send({ target: "background", type: "recorder-finalizing" });
    const meta = await r.storage.call({
      op: "finalize",
      sessionId: r.options.sessionId,
      patch: { endedAt: new Date().toISOString(), endReason: reason, durationMs, ...(error ? { error } : {}) },
    });
    send({ target: "background", type: "recorder-finished", meta, files: await exportFiles(meta) });
  } catch (e) {
    r.storage.terminate();
    current = null;
    send({ target: "background", type: "recorder-failed", error: errorMessage(e) });
  }
}

/** Blob URLs for the background to download into Downloads/Dohra/<id>/. */
async function exportFiles(meta: SessionMeta): Promise<ExportFile[]> {
  if (meta.state !== "complete") return [];
  const recording = URL.createObjectURL(await recordingFile(meta.id));
  const exportedMeta = { ...meta, exportedAt: new Date().toISOString() };
  const json = URL.createObjectURL(
    new Blob([JSON.stringify(exportedMeta, null, 2) + "\n"], { type: "application/json" }),
  );
  exportedUrls = [recording, json];
  return [
    { url: recording, filename: `${EXPORT_DIR}/${meta.id}/${FILES.recording}` },
    { url: json, filename: `${EXPORT_DIR}/${meta.id}/${FILES.meta}` },
  ];
}

async function exported(ok: boolean): Promise<void> {
  const r = current;
  exportedUrls.forEach((u) => URL.revokeObjectURL(u));
  exportedUrls = [];
  if (!r) return;
  try {
    if (ok) await r.storage.call({ op: "update", sessionId: r.options.sessionId, patch: { exportedAt: new Date().toISOString() } });
  } finally {
    r.storage.terminate();
    current = null;
  }
}

async function handle(msg: OffscreenRequest): Promise<void> {
  switch (msg.type) {
    case "start":
      return start(msg.streamId, msg.options);
    case "stop":
      // Replies once capture has stopped; finalizing continues and reports by message.
      void stop("user");
      return;
    case "pause":
      return pause();
    case "resume":
      return resume();
    case "exported":
      return exported(msg.ok);
  }
}

chrome.runtime.onMessage.addListener((msg: OffscreenRequest, _sender, sendResponse: (r: Reply) => void) => {
  if (msg?.target !== "offscreen") return false;
  handle(msg).then(
    () => sendResponse({ ok: true }),
    (e) => sendResponse({ ok: false, error: errorMessage(e) }),
  );
  return true;
});
