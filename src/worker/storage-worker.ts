// Storage worker: writes recordings into the origin private file system (OPFS).
//
// Layout: sessions/<id>/raw.webm while recording, then recording.webm once finalized,
// plus session.json throughout. Every append is flushed, so after a crash the raw file
// holds everything up to the last chunk and the session can be finalized later.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { FILES, SESSIONS_DIR, type SessionMeta } from "../lib/session";
import { repairHeader } from "../lib/webm";
import type { WorkerRequest, WorkerResponse } from "./protocol";

const HEAD_BYTES = 64 * 1024;
const COPY_CHUNK_BYTES = 4 * 1024 * 1024;

interface OpenSession {
  dir: FileSystemDirectoryHandle;
  raw: FileSystemSyncAccessHandle;
  size: number;
  meta: SessionMeta;
}

const openSessions = new Map<string, OpenSession>();
const encoder = new TextEncoder();

async function sessionDir(id: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const sessions = await root.getDirectoryHandle(SESSIONS_DIR, { create: true });
  return sessions.getDirectoryHandle(id, { create });
}

async function writeMeta(dir: FileSystemDirectoryHandle, meta: SessionMeta): Promise<void> {
  const file = await dir.getFileHandle(FILES.meta, { create: true });
  const handle = await file.createSyncAccessHandle();
  try {
    const data = encoder.encode(JSON.stringify(meta, null, 2) + "\n");
    // Write before truncating, so a crash in between leaves the old length of valid
    // bytes at worst rather than an empty file.
    handle.write(data, { at: 0 });
    handle.truncate(data.length);
    handle.flush();
  } finally {
    handle.close();
  }
}

/**
 * Reads session.json. If it is missing or corrupt, `fallback` stands in for it; callers
 * recovering such a session pass complete metadata as their patch for this reason.
 */
async function readMeta(dir: FileSystemDirectoryHandle, fallback?: Partial<SessionMeta>): Promise<SessionMeta> {
  try {
    const file = await (await dir.getFileHandle(FILES.meta)).getFile();
    return JSON.parse(await file.text()) as SessionMeta;
  } catch (e) {
    if (fallback?.id) return fallback as SessionMeta;
    throw e;
  }
}

async function fileExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

async function open(meta: SessionMeta): Promise<SessionMeta> {
  const dir = await sessionDir(meta.id, true);
  const raw = await (await dir.getFileHandle(FILES.raw, { create: true })).createSyncAccessHandle();
  raw.truncate(0);
  await writeMeta(dir, meta);
  openSessions.set(meta.id, { dir, raw, size: 0, meta });
  return meta;
}

async function append(sessionId: string, data: ArrayBuffer, durationMs: number): Promise<SessionMeta> {
  const session = openSessions.get(sessionId);
  if (!session) throw new Error(`session ${sessionId} is not open`);
  const written = session.raw.write(new Uint8Array(data), { at: session.size });
  session.size += written;
  session.raw.flush();
  session.meta = {
    ...session.meta,
    durationMs,
    bytes: session.size,
    updatedAt: new Date().toISOString(),
  };
  await writeMeta(session.dir, session.meta);
  return session.meta;
}

async function update(sessionId: string, patch: Partial<SessionMeta>): Promise<SessionMeta> {
  const session = openSessions.get(sessionId);
  const dir = session?.dir ?? (await sessionDir(sessionId, false));
  const meta = { ...(session?.meta ?? (await readMeta(dir, patch))), ...patch, updatedAt: new Date().toISOString() };
  if (session) session.meta = meta;
  await writeMeta(dir, meta);
  return meta;
}

/** Removes the media file from the browser and records that it is only in Downloads now. */
async function dropMedia(sessionId: string): Promise<SessionMeta> {
  const dir = await sessionDir(sessionId, false);
  const meta = await readMeta(dir);
  if (meta.state !== "complete") throw new Error("only a finished recording can be removed from the browser");
  const name = meta.file ?? FILES.recording;
  if (await fileExists(dir, name)) await dir.removeEntry(name);
  return update(sessionId, { browserCopyRemovedAt: new Date().toISOString() });
}

/**
 * Turns raw.webm into recording.webm: repairs the header (Duration, AlphaMode), copies
 * the rest across, and hashes the result. Safe to re-run if interrupted, since raw.webm is only removed
 * once recording.webm is complete. Works both right after recording and on a session
 * recovered after a crash.
 */
async function finalize(sessionId: string, patch: Partial<SessionMeta>): Promise<SessionMeta> {
  const session = openSessions.get(sessionId);
  if (session) {
    session.raw.close();
    openSessions.delete(sessionId);
  }
  const dir = session?.dir ?? (await sessionDir(sessionId, false));
  let meta: SessionMeta = { ...(session?.meta ?? (await readMeta(dir, patch))), ...patch, state: "finalizing" };
  await writeMeta(dir, meta);

  const done = async (changes: Partial<SessionMeta>) => {
    meta = { ...meta, ...changes, updatedAt: new Date().toISOString() };
    await writeMeta(dir, meta);
    return meta;
  };

  if (!(await fileExists(dir, FILES.raw))) {
    return done({ state: "failed", error: "raw recording is missing" });
  }

  const src = await (await dir.getFileHandle(FILES.raw)).createSyncAccessHandle();
  let dst: FileSystemSyncAccessHandle | null = null;
  let warning: string | null = null;
  let written = 0;
  const hash = sha256.create();
  try {
    const size = src.getSize();
    if (size === 0) {
      src.close();
      await dir.removeEntry(FILES.raw);
      return done({ state: "failed", bytes: 0, error: "nothing was recorded" });
    }

    const head = new Uint8Array(Math.min(size, HEAD_BYTES));
    src.read(head, { at: 0 });
    let newHead: Uint8Array = new Uint8Array(0);
    let consumed = 0;
    try {
      ({ head: newHead, consumed } = repairHeader(head, meta.durationMs));
    } catch (e) {
      // Keep the recording even if the header cannot be patched; it still plays, it
      // just cannot be seeked in every player.
      warning = `duration not written: ${e instanceof Error ? e.message : String(e)}`;
    }

    dst = await (await dir.getFileHandle(FILES.recording, { create: true })).createSyncAccessHandle();
    dst.truncate(0);
    dst.write(newHead, { at: 0 });
    hash.update(newHead);
    written = newHead.length;

    const buffer = new Uint8Array(COPY_CHUNK_BYTES);
    for (let pos = consumed; pos < size; ) {
      const n = src.read(buffer, { at: pos });
      if (n === 0) break;
      const chunk = buffer.subarray(0, n);
      dst.write(chunk, { at: written });
      hash.update(chunk);
      pos += n;
      written += n;
    }
    dst.flush();
  } finally {
    src.close();
    dst?.close();
  }

  await dir.removeEntry(FILES.raw);
  return done({ state: "complete", bytes: written, sha256: bytesToHex(hash.digest()), error: warning });
}

function handle(req: WorkerRequest): Promise<SessionMeta> {
  switch (req.op) {
    case "open":
      return open(req.meta);
    case "append":
      return append(req.sessionId, req.data, req.durationMs);
    case "update":
      return update(req.sessionId, req.patch);
    case "finalize":
      return finalize(req.sessionId, req.patch);
    case "drop-media":
      return dropMedia(req.sessionId);
  }
}

// One request at a time, in arrival order: appends must not interleave, and finalize
// must see every append that came before it.
let queue: Promise<unknown> = Promise.resolve();

self.onmessage = (event: MessageEvent<{ id: number; req: WorkerRequest }>) => {
  const { id, req } = event.data;
  queue = queue.then(async () => {
    let response: WorkerResponse;
    try {
      response = { id, ok: true, meta: await handle(req) };
    } catch (e) {
      response = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    self.postMessage(response);
  });
};
