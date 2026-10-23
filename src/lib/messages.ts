// Messages between the extension's contexts. chrome.runtime.sendMessage reaches every
// extension page, so each message names its target and receivers ignore the rest.

import type { SessionMeta } from "./session";
import type { Mode, Quality } from "./settings";

export interface StartOptions {
  sessionId: string;
  title: string;
  source: { url: string; title: string };
  mode: Mode;
  quality: Quality;
  mic: boolean;
  /** e.g. "dohra-extension/0.1.0". Offscreen documents cannot read the manifest themselves. */
  recorder: string;
  /** Tap audio for the companion; set only once it has accepted the session. */
  transcribe: boolean;
}

/** Popup (or keyboard shortcut) → background. */
export type BackgroundRequest =
  | { target: "background"; type: "start"; tabId: number; title: string }
  | { target: "background"; type: "stop" }
  | { target: "background"; type: "pause" }
  | { target: "background"; type: "resume" }
  /** Pages ask for the companion's state (replies with CompanionInfo). */
  | { target: "background"; type: "companion-status" }
  /** Transcribing a finished recording: the page decodes it and streams the audio. */
  | { target: "background"; type: "transcribe-start"; sessionId: string }
  | { target: "background"; type: "transcribe-audio"; sessionId: string; pcm: string }
  | { target: "background"; type: "transcribe-stop"; sessionId: string };

/** Offscreen recorder → background. */
export type RecorderEvent =
  | { target: "background"; type: "recorder-progress"; progress: Progress }
  | { target: "background"; type: "recorder-finalizing" }
  | { target: "background"; type: "recorder-finished"; meta: SessionMeta; files: ExportFile[] }
  | { target: "background"; type: "recorder-failed"; error: string }
  /** One block of 16 kHz PCM (base64) for transcription. */
  | { target: "background"; type: "recorder-audio"; stream: "them" | "me"; pcm: string }
  | { target: "background"; type: "recorder-tap-failed"; error: string };

/**
 * Recorded time as of `at` (epoch ms). Pages add `Date.now() - at` while not paused,
 * so a timer runs smoothly between the recorder's updates.
 */
export interface Progress {
  durationMs: number;
  bytes: number;
  paused: boolean;
  at: number;
}

export interface ExportFile {
  url: string; // blob: URL, valid until the offscreen document closes
  filename: string; // relative to the Downloads folder
}

/** Background → offscreen recorder. */
export type OffscreenRequest =
  | { target: "offscreen"; type: "start"; streamId: string; options: StartOptions }
  | { target: "offscreen"; type: "stop" }
  | { target: "offscreen"; type: "pause" }
  | { target: "offscreen"; type: "resume" }
  /** Sent once exported files are saved (or failed), so the recorder can record that and shut down. */
  | { target: "offscreen"; type: "exported"; ok: boolean };

export type Reply = { ok: true; data?: unknown } | { ok: false; error: string };

export type ActiveStatus = "starting" | "recording" | "paused" | "finalizing" | "exporting";

/** The one in-progress recording, kept in chrome.storage.session under ACTIVE_KEY. */
export interface ActiveRecording {
  sessionId: string;
  title: string;
  tabId: number;
  mode: Mode;
  status: ActiveStatus;
  progress: Progress;
}

export const ACTIVE_KEY = "active";
/** Last failure, shown by the popup until the next recording starts. */
export const LAST_ERROR_KEY = "lastError";

export function liveDuration(p: Progress): number {
  return p.durationMs + (p.paused ? 0 : Math.max(0, Date.now() - p.at));
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
