// Requests to the storage worker. All file I/O happens there, because only a worker
// can use synchronous access handles: writes land in place and survive a crash once
// flushed. The async writable-stream API only commits a file when it is closed, so a
// crash mid-recording would lose everything.

import type { SessionMeta } from "../lib/session";

export type WorkerRequest =
  | { op: "open"; meta: SessionMeta }
  | { op: "append"; sessionId: string; data: ArrayBuffer; durationMs: number }
  | { op: "update"; sessionId: string; patch: Partial<SessionMeta> }
  | { op: "finalize"; sessionId: string; patch: Partial<SessionMeta> }
  /** Deletes the media file, keeping everything else; only once the Downloads copy is verified. */
  | { op: "drop-media"; sessionId: string };

export type WorkerResponse =
  | { id: number; ok: true; meta: SessionMeta }
  | { id: number; ok: false; error: string };
