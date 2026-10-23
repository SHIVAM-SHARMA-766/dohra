// The session format: one folder per recording, the same shape in browser storage and
// in the exported copy under Downloads/Dohra/. Later stages (transcript, notes, slides)
// add files to the same folder, and a future desktop recorder writes the same format.

import type { Mode, Quality } from "./settings";

export const SCHEMA_VERSION = 1;

export type SessionState =
  | "recording" // capture in progress, or interrupted before it could finish
  | "finalizing" // capture stopped, final file being written
  | "complete"
  | "failed";

export type EndReason = "user" | "tab-closed" | "capture-error" | "recovered";

export interface SessionMeta {
  schema: typeof SCHEMA_VERSION;
  id: string;
  title: string;
  source: { url: string; title: string };
  mode: Mode;
  quality: Quality | null; // null for audio-only
  mic: boolean;
  mimeType: string;
  recorder: string; // e.g. "dohra-extension/0.1.0"
  state: SessionState;
  startedAt: string; // ISO 8601
  endedAt: string | null;
  updatedAt: string;
  /** Recorded time, excluding pauses. Updated on every chunk, so it survives a crash. */
  durationMs: number;
  bytes: number;
  sha256: string | null; // of recording.webm, set once complete
  endReason: EndReason | null;
  error: string | null;
  exportedAt: string | null;
}

export const FILES = {
  raw: "raw.webm", // written while recording; replaced by recording.webm when finalized
  recording: "recording.webm",
  meta: "session.json",
  transcript: "transcript.json",
} as const;

export const SESSIONS_DIR = "sessions";
export const EXPORT_DIR = "Dohra";

/**
 * Lowercase ASCII slug for folder names. Non-Latin titles (e.g. Hindi) slug to empty,
 * in which case the caller falls back to a generic name.
 */
export function slugify(text: string, maxLength = 40): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `2026-10-06_1900_dsa-class` — sorts chronologically and reads well in a file manager. */
export function sessionId(title: string, at: Date): string {
  const stamp =
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `_${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${stamp}_${slugify(title) || "session"}`;
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
