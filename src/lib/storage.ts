// Storage access for extension pages: a client for the storage worker (writes), and
// direct OPFS reads for listing, playing and deleting sessions.

import type { WorkerRequest, WorkerResponse } from "../worker/protocol";
import { FILES, SCHEMA_VERSION, SESSIONS_DIR, type SessionMeta } from "./session";

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

export async function recordingFile(id: string): Promise<File> {
  const dir = await (await sessionsDir()).getDirectoryHandle(id);
  return (await dir.getFileHandle(FILES.recording)).getFile();
}

export async function deleteSession(id: string): Promise<void> {
  await (await sessionsDir()).removeEntry(id, { recursive: true });
}
