// Transcripts: the shape stored as transcript.json in a session folder, and the
// live status the background keeps in chrome.storage.session for pages to show.
//
// The companion is the source of truth while it works; the extension's copy is
// rewritten from it as lines arrive, so pages can show a partial transcript, and
// is final once the companion reports "done".

import type { SpeakerTimeline } from "./meeting-speakers";
import { FILES, SESSIONS_DIR } from "./session";

export type Speaker = "them" | "me" | "mixed";

export interface TranscriptLine {
  speaker: Speaker;
  startMs: number;
  endMs: number;
  text: string;
  lang?: string;
  /** Who said it, from the meeting's screen (speakers.json); "them" lines only. */
  name?: string;
}

export type TranscriptState = "live" | "transcribing" | "complete" | "failed";

export interface Transcript {
  schema: 1;
  sessionId: string;
  state: TranscriptState;
  model: string | null;
  language: string | null; // detected or chosen; null until known
  error: string | null;
  updatedAt: string;
  lines: TranscriptLine[];
}

/** Live progress per session, under TRANSCRIPTS_KEY in chrome.storage.session. */
export interface TranscriptStatus {
  state: TranscriptState;
  receivedMs: number;
  doneMs: number;
  error: string | null;
}

export const TRANSCRIPTS_KEY = "transcripts";

/** One speech model, as the companion reports it. */
export interface ModelInfo {
  name: string; // "small" | "medium" | "large"
  label: string; // Small, Medium, High
  size: number; // bytes
  installed: boolean;
  active: boolean;
  downloading: boolean;
  done: number; // bytes so far, while downloading
  error?: string; // why the last download failed
}

/** What the companion reported, under COMPANION_KEY; kept current during model downloads. */
export interface CompanionInfo {
  installed: boolean;
  ready: boolean;
  version: string | null;
  model: string | null;
  problems: string[];
  cpus: number;
  models: ModelInfo[];
  checkedAt: number;
}

export const COMPANION_KEY = "companion";

export const SPEAKER_LABEL: Record<Speaker, string> = { them: "Them", me: "Me", mixed: "" };

async function sessionDir(id: string, create = false): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const sessions = await root.getDirectoryHandle(SESSIONS_DIR, { create: true });
  return sessions.getDirectoryHandle(id, { create });
}

export async function readTranscript(id: string): Promise<Transcript | null> {
  try {
    const dir = await sessionDir(id);
    const file = await (await dir.getFileHandle(FILES.transcript)).getFile();
    return JSON.parse(await file.text()) as Transcript;
  } catch {
    return null;
  }
}

/** Works in pages and in the service worker (async OPFS API). */
export async function writeTranscript(t: Transcript): Promise<void> {
  const dir = await sessionDir(t.sessionId, true);
  const handle = await dir.getFileHandle(FILES.transcript, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(t, null, 2) + "\n");
  await writable.close();
}

/** A JSON file in a session folder, or null if it is missing or unreadable. */
export async function readSessionJson<T>(id: string, name: string): Promise<T | null> {
  try {
    const dir = await sessionDir(id);
    return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text()) as T;
  } catch {
    return null;
  }
}

export async function writeSessionJson(id: string, name: string, value: unknown): Promise<void> {
  const dir = await sessionDir(id, true);
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.write(JSON.stringify(value, null, 2) + "\n");
  await writable.close();
}

export async function readSpeakers(id: string): Promise<SpeakerTimeline | null> {
  try {
    const dir = await sessionDir(id);
    const file = await (await dir.getFileHandle(FILES.speakers)).getFile();
    return JSON.parse(await file.text()) as SpeakerTimeline;
  } catch {
    return null;
  }
}

export async function writeSpeakers(id: string, timeline: SpeakerTimeline): Promise<void> {
  const dir = await sessionDir(id, true);
  const writable = await (await dir.getFileHandle(FILES.speakers, { create: true })).createWritable();
  await writable.write(JSON.stringify(timeline) + "\n");
  await writable.close();
}

/** A line's speaker as shown: the name from the meeting when known, else Them / Me. */
export function speakerLabel(line: TranscriptLine): string {
  return line.name ?? SPEAKER_LABEL[line.speaker];
}

/** Index of the line playing at `ms`, or -1. Lines are sorted by start time. */
export function lineAt(lines: TranscriptLine[], ms: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.startMs <= ms) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Base64 of 16-bit PCM, the encoding the companion expects. */
export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Float samples in [-1, 1] to 16-bit PCM. */
export function floatToPcm(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}
