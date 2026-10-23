// The connection to the transcription companion, owned by the service worker.
//
// One native-messaging port carries every session. An open port also keeps the
// service worker alive, which matters after a class: the companion may still be
// catching up for several minutes, and its "lines" and "done" events must have
// somewhere to go. The port is closed once nothing is in progress.
//
// Each time lines arrive, the transcript is fetched from the companion in pages
// and rewritten in the session folder, so pages can show it while it grows.

import { EXPORT_DIR, FILES, SESSIONS_DIR } from "../lib/session";
import { loadSettings } from "../lib/settings";
import {
  COMPANION_KEY,
  readTranscript,
  TRANSCRIPTS_KEY,
  writeTranscript,
  type CompanionInfo,
  type Transcript,
  type TranscriptLine,
  type TranscriptState,
  type TranscriptStatus,
} from "../lib/transcript";

const HOST = "com.dohra.companion";
const REQUEST_TIMEOUT_MS = 20_000;
const SAVE_DEBOUNCE_MS = 1_500;
const IDLE_DISCONNECT_MS = 10_000;

interface Hello {
  version: string;
  ready: boolean;
  problems: string[] | null;
  model: string;
  language: string;
}

type CompanionEvent =
  | { type: "reply"; id: number; ok: boolean; error?: string; data?: unknown }
  | { type: "progress"; sessionId: string; state: string; receivedMs: number; doneMs: number }
  | { type: "lines"; sessionId: string; lines: TranscriptLine[] }
  | { type: "done"; sessionId: string; state: "complete" | "failed"; error?: string }
  | { type: "error"; sessionId?: string; error: string };

let port: chrome.runtime.Port | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
/** Sessions the companion is still working on; the port stays open while any exist. */
const inProgress = new Set<string>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let hello: Hello | null = null;

function connect(): chrome.runtime.Port {
  if (port) return port;
  clearTimeout(idleTimer);
  const p = chrome.runtime.connectNative(HOST);
  p.onMessage.addListener((msg: CompanionEvent) => void onEvent(msg));
  p.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message ?? "the companion exited";
    port = null;
    hello = null;
    for (const { reject } of pending.values()) reject(new Error(reason));
    pending.clear();
    // Unfinished sessions resume the next time the companion starts.
    for (const id of inProgress) void setStatus(id, { error: `paused: ${reason}` });
  });
  port = p;
  return p;
}

function request<T>(msg: Record<string, unknown>): Promise<T> {
  const p = connect();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`companion did not answer "${String(msg.type)}"`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v as T);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    p.postMessage({ ...msg, id });
  });
}

function scheduleDisconnect(): void {
  clearTimeout(idleTimer);
  if (inProgress.size > 0) return;
  idleTimer = setTimeout(() => {
    if (inProgress.size === 0 && pending.size === 0) {
      port?.disconnect();
      port = null;
    }
  }, IDLE_DISCONNECT_MS);
}

// ---- status for pages --------------------------------------------------------------

async function getStatuses(): Promise<Record<string, TranscriptStatus>> {
  const { [TRANSCRIPTS_KEY]: all } = await chrome.storage.session.get(TRANSCRIPTS_KEY);
  return (all as Record<string, TranscriptStatus> | undefined) ?? {};
}

async function setStatus(id: string, patch: Partial<TranscriptStatus>): Promise<void> {
  const all = await getStatuses();
  const base: TranscriptStatus = all[id] ?? { state: "live", receivedMs: 0, doneMs: 0, error: null };
  all[id] = { ...base, ...patch };
  await chrome.storage.session.set({ [TRANSCRIPTS_KEY]: all });
}

function isNotInstalled(message: string): boolean {
  return /not found|forbidden|not allowed/i.test(message);
}

/** Connects (starting the companion if needed) and reports what it can do. */
export async function checkCompanion(): Promise<CompanionInfo> {
  let info: CompanionInfo;
  try {
    hello ??= await request<Hello>({ type: "hello" });
    info = {
      installed: true,
      ready: hello.ready,
      version: hello.version,
      model: hello.model,
      problems: hello.problems ?? [],
      checkedAt: Date.now(),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    info = {
      installed: !isNotInstalled(message),
      ready: false,
      version: null,
      model: null,
      problems: [isNotInstalled(message) ? "The Dohra companion is not installed." : message],
      checkedAt: Date.now(),
    };
  }
  await chrome.storage.session.set({ [COMPANION_KEY]: info });
  scheduleDisconnect();
  return info;
}

// ---- sessions ----------------------------------------------------------------------

/**
 * Starts transcribing a session. Returns false, with the reason recorded for the
 * popup, if the companion is missing or not ready — the recording goes ahead
 * without a transcript.
 */
export async function startSession(sessionId: string, live: boolean): Promise<boolean> {
  const info = await checkCompanion();
  if (!info.ready) return false;
  const { language } = await loadSettings();
  await request({ type: "start", sessionId, language });
  inProgress.add(sessionId);
  clearTimeout(idleTimer);
  await setStatus(sessionId, { state: live ? "live" : "transcribing", receivedMs: 0, doneMs: 0, error: null });
  await save(sessionId);
  return true;
}

export function sendAudio(sessionId: string, stream: string, pcm: string): void {
  if (!inProgress.has(sessionId) || !port) return;
  port.postMessage({ type: "audio", sessionId, stream, pcm });
}

export async function stopSession(sessionId: string): Promise<void> {
  if (!inProgress.has(sessionId)) return;
  await request({ type: "stop", sessionId });
  await setStatus(sessionId, { state: "transcribing" });
}

export async function failSession(sessionId: string, error: string): Promise<void> {
  await setStatus(sessionId, { state: "failed", error });
}

// ---- events ------------------------------------------------------------------------

async function onEvent(msg: CompanionEvent): Promise<void> {
  switch (msg.type) {
    case "reply": {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.data);
      else waiter.reject(new Error(msg.error ?? "companion error"));
      return;
    }
    case "progress":
      inProgress.add(msg.sessionId); // also covers sessions resumed after a restart
      await setStatus(msg.sessionId, {
        state: msg.state === "receiving" ? "live" : "transcribing",
        receivedMs: msg.receivedMs,
        doneMs: msg.doneMs,
        error: null,
      });
      return;
    case "lines":
      inProgress.add(msg.sessionId);
      scheduleSave(msg.sessionId);
      return;
    case "done":
      clearTimeout(saveTimers.get(msg.sessionId));
      await save(msg.sessionId, msg.state, msg.error ?? null);
      await setStatus(msg.sessionId, { state: msg.state, error: msg.error ?? null });
      inProgress.delete(msg.sessionId);
      if (msg.state === "complete") await exportTranscript(msg.sessionId);
      scheduleDisconnect();
      return;
    case "error":
      if (msg.sessionId) await setStatus(msg.sessionId, { error: msg.error });
      return;
  }
}

function scheduleSave(id: string): void {
  clearTimeout(saveTimers.get(id));
  saveTimers.set(
    id,
    setTimeout(() => void save(id), SAVE_DEBOUNCE_MS),
  );
}

/** Rewrites transcript.json from the companion's copy. State defaults to the live status. */
async function save(id: string, final?: TranscriptState, error: string | null = null): Promise<void> {
  const lines: TranscriptLine[] = [];
  let model: string | null = hello?.model ?? null;
  try {
    for (let from = 0; ; ) {
      const page = await request<{ lines: TranscriptLine[] | null; next: number; total: number }>({
        type: "transcript",
        sessionId: id,
        from,
      });
      for (const l of page.lines ?? []) {
        lines.push({ speaker: l.speaker, startMs: l.startMs, endMs: l.endMs, text: l.text, lang: l.lang });
      }
      if (page.next >= page.total || !page.lines?.length) break;
      from = page.next;
    }
  } catch (e) {
    // Keep what was saved before rather than overwrite it with nothing.
    const existing = await readTranscript(id);
    if (existing) return;
    error = e instanceof Error ? e.message : String(e);
  }
  const existing = await readTranscript(id);
  const state = final ?? (await getStatuses())[id]?.state ?? "transcribing";
  model ??= existing?.model ?? null;
  const language = lines.find((l) => l.lang)?.lang ?? null;
  const transcript: Transcript = {
    schema: 1,
    sessionId: id,
    state,
    model,
    language,
    error,
    updatedAt: new Date().toISOString(),
    lines,
  };
  await writeTranscript(transcript);
  // Bump the status so open pages reload the file.
  await setStatus(id, {});
}

async function exportTranscript(id: string): Promise<void> {
  const { autoExport } = await loadSettings();
  if (!autoExport) return;
  const transcript = await readTranscript(id);
  if (!transcript) return;
  const json = JSON.stringify(transcript, null, 2) + "\n";
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  try {
    await chrome.downloads.download({
      // A service worker cannot create blob URLs; a data URL works for a file this size.
      url: `data:application/json;base64,${btoa(binary)}`,
      filename: `${EXPORT_DIR}/${id}/${FILES.transcript}`,
      conflictAction: "overwrite",
      saveAs: false,
    });
  } catch {
    // The copy in the library is what matters; Downloads is a convenience.
  }
}

/**
 * After a browser restart, reconnects if any transcript was left unfinished. The
 * companion resumes such sessions by itself as soon as it starts.
 */
export async function resumeUnfinished(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  let sessions: FileSystemDirectoryHandle;
  try {
    sessions = await root.getDirectoryHandle(SESSIONS_DIR);
  } catch {
    return;
  }
  const unfinished: string[] = [];
  for await (const [name, handle] of sessions.entries()) {
    if (handle.kind !== "directory") continue;
    const t = await readTranscript(name);
    if (t && (t.state === "live" || t.state === "transcribing")) unfinished.push(name);
  }
  if (unfinished.length === 0) return;
  const info = await checkCompanion();
  if (!info.ready) return;

  // Still in the companion's queue: its events will finish the job. Otherwise it
  // finished while the browser was closed, and the result only needs collecting.
  const working = new Set((await request<{ sessionId: string }[]>({ type: "status" })).map((p) => p.sessionId));
  for (const id of unfinished) {
    if (working.has(id)) {
      inProgress.add(id);
      await setStatus(id, { state: "transcribing", error: null });
      continue;
    }
    try {
      const page = await request<{ state: string }>({ type: "transcript", sessionId: id, from: 0 });
      const state: TranscriptState = page.state === "complete" ? "complete" : "failed";
      await save(id, state, state === "failed" ? "transcription stopped before it finished" : null);
      await setStatus(id, { state });
      if (state === "complete") await exportTranscript(id);
    } catch (e) {
      await save(id, "failed", e instanceof Error ? e.message : String(e));
      await setStatus(id, { state: "failed" });
    }
  }
  scheduleDisconnect();
}
