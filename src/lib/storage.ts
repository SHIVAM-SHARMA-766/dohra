// Storage access for extension pages: a client for the storage worker (writes), and
// direct OPFS reads for listing, playing and deleting sessions.

import type { WorkerRequest, WorkerResponse } from "../worker/protocol";
import { FILES, SCHEMA_VERSION, SESSIONS_DIR, sessionId, type SessionMeta } from "./session";

export class StorageWorker {
  private worker = new Worker(chrome.runtime.getURL("worker.js"));
  private nextId = 1;
  private pending = new Map<number, { resolve: (m: SessionMeta) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const res = event.data;
      const waiter = this.pending.get(res.id);
      if (!waiter) return;
      this.pending.delete(res.id);
      if (res.ok) waiter.resolve(res.meta);
      else waiter.reject(new Error(res.error));
    };
  }

  call(req: WorkerRequest, transfer: Transferable[] = []): Promise<SessionMeta> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, req }, transfer);
    });
  }

  terminate(): void {
    this.worker.terminate();
  }
}

async function sessionsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(SESSIONS_DIR, { create: true });
}

/** Stand-in metadata for a folder whose session.json is missing or unreadable. */
function placeholderMeta(id: string): SessionMeta {
  const now = new Date().toISOString();
  return {
    schema: SCHEMA_VERSION,
    id,
    title: id,
    source: { url: "", title: "" },
    mode: "video",
    quality: null,
    mic: false,
    mimeType: "video/webm",
    recorder: "unknown",
    state: "recording",
    startedAt: now,
    endedAt: null,
    updatedAt: now,
    durationMs: 0,
    bytes: 0,
    sha256: null,
    endReason: null,
    error: "session.json was unreadable; details are incomplete",
    exportedAt: null,
  };
}

export async function listSessions(): Promise<SessionMeta[]> {
  const dir = await sessionsDir();
  const sessions: SessionMeta[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== "directory") continue;
    try {
      const file = await (await (handle as FileSystemDirectoryHandle).getFileHandle(FILES.meta)).getFile();
      sessions.push(JSON.parse(await file.text()) as SessionMeta);
    } catch {
      sessions.push(placeholderMeta(name));
    }
  }
  return sessions.sort((a, b) => b.id.localeCompare(a.id));
}

export async function getSession(id: string): Promise<SessionMeta | null> {
  try {
    const dir = await (await sessionsDir()).getDirectoryHandle(id);
    const file = await (await dir.getFileHandle(FILES.meta)).getFile();
    return JSON.parse(await file.text()) as SessionMeta;
  } catch {
    return null;
  }
}

export async function recordingFile(id: string, name: string = FILES.recording): Promise<File> {
  const dir = await (await sessionsDir()).getDirectoryHandle(id);
  return (await dir.getFileHandle(name)).getFile();
}

export async function deleteSession(id: string): Promise<void> {
  await (await sessionsDir()).removeEntry(id, { recursive: true });
}

// ---- importing a file -----------------------------------------------------------------

interface Probe {
  durationMs: number;
  width: number;
  height: number;
}

const PROBE_TIMEOUT_MS = 15_000;

/**
 * Reads a media file's length and picture size by loading its metadata. Chrome may
 * hold off loading media in a tab that is not visible; after a while this gives up
 * with zeros, and the session page fills them in once it plays or decodes the file.
 */
function probeMedia(file: File): Promise<Probe> {
  const unknown: Probe = { durationMs: 0, width: 0, height: 0 };
  const timeout = new Promise<Probe>((resolve) => setTimeout(() => resolve(unknown), PROBE_TIMEOUT_MS));
  return Promise.race([loadMetadata(file), timeout]);
}

function loadMetadata(file: File): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement("video");
    el.preload = "metadata";
    el.muted = true;
    const done = () => {
      URL.revokeObjectURL(url);
      el.removeAttribute("src");
      el.load();
    };
    const finish = () => {
      const durationMs = Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : 0;
      resolve({ durationMs, width: el.videoWidth, height: el.videoHeight });
      done();
    };
    el.onloadedmetadata = () => {
      if (Number.isFinite(el.duration)) return finish();
      // WebM straight from MediaRecorder has no duration in its header. Seeking far
      // past the end makes the browser scan the file and report it.
      el.ondurationchange = () => {
        if (Number.isFinite(el.duration)) finish();
      };
      el.currentTime = 1e101;
    };
    el.onerror = () => {
      done();
      reject(new Error("the browser cannot play this file; try an MP4, WebM, MP3, M4A or WAV"));
    };
    el.src = url;
  });
}

function extensionOf(name: string): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase();
  return ext ?? "bin";
}

/**
 * Copies a video or audio file into the library as a finished session, so it can be
 * played and transcribed like a recording. `onProgress` gets the fraction copied.
 */
export async function importMedia(file: File, onProgress: (fraction: number) => void): Promise<SessionMeta> {
  const probe = await probeMedia(file);
  const title = file.name.replace(/\.[^.]+$/, "") || "Imported recording";
  const started = new Date(file.lastModified || Date.now());
  const id = sessionId(title, new Date());
  const name = `recording.${extensionOf(file.name)}`;

  const dir = await (await sessionsDir()).getDirectoryHandle(id, { create: true });
  try {
    const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
    let copied = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        copied += chunk.byteLength;
        onProgress(copied / Math.max(file.size, 1));
        controller.enqueue(chunk);
      },
    });
    await file.stream().pipeThrough(counter).pipeTo(writable);

    const hasVideo = probe.width > 0 ? probe.height > 0 : !file.type.startsWith("audio/");
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      schema: SCHEMA_VERSION,
      id,
      title,
      source: { url: "", title: file.name },
      mode: hasVideo ? "video" : "audio",
      quality: hasVideo && probe.width > 0 ? `${probe.width}x${probe.height}` : null,
      mic: false,
      mimeType: file.type || "application/octet-stream",
      recorder: "import",
      state: "complete",
      startedAt: started.toISOString(),
      endedAt: new Date(started.getTime() + probe.durationMs).toISOString(),
      updatedAt: now,
      durationMs: probe.durationMs,
      bytes: file.size,
      sha256: null,
      endReason: "imported",
      error: null,
      exportedAt: null,
      file: name,
    };
    const metaFile = await (await dir.getFileHandle(FILES.meta, { create: true })).createWritable();
    await metaFile.write(JSON.stringify(meta, null, 2) + "\n");
    await metaFile.close();
    return meta;
  } catch (e) {
    await deleteSession(id).catch(() => {});
    throw e;
  }
}
