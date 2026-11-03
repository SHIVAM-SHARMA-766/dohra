// Quick start: one click records the current tab — audio and video at the best
// quality the screen allows, the microphone, and a transcript. The only choices here are the title,
// the transcript, the Downloads copy, and (if enabled on the Settings page) the microphone.

import {
  ACTIVE_KEY,
  LAST_ERROR_KEY,
  liveDuration,
  micMuted,
  type ActiveRecording,
  type BackgroundRequest,
  type Reply,
} from "../lib/messages";
import { hydrateIcons, icon } from "../lib/icons";
import { formatBytes, formatDuration } from "../lib/session";
import { loadSettings, micEnabled, saveSettings, type Settings } from "../lib/settings";
import { TRANSCRIPTS_KEY, type CompanionInfo, type TranscriptStatus } from "../lib/transcript";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const idleView = $<HTMLElement>("idle");
const recordingView = $<HTMLElement>("recording");
const errorBanner = $<HTMLParagraphElement>("error");
const titleInput = $<HTMLInputElement>("title");
const micCheck = $<HTMLInputElement>("mic");
const autoExportCheck = $<HTMLInputElement>("auto-export");
const transcribeCheck = $<HTMLInputElement>("transcribe");
const startButton = $<HTMLButtonElement>("start");
const pauseButton = $<HTMLButtonElement>("pause");
const stopButton = $<HTMLButtonElement>("stop");

let settings: Settings;
let active: ActiveRecording | null = null;
let transcripts: Record<string, TranscriptStatus> = {};
let timer: number | undefined;

async function request(msg: BackgroundRequest): Promise<unknown> {
  const reply = (await chrome.runtime.sendMessage(msg)) as Reply | undefined;
  if (reply && !reply.ok) throw new Error(reply.error);
  return reply?.data;
}

function showError(error: string | null): void {
  errorBanner.textContent = error ?? "";
  errorBanner.hidden = !error;
}

function openPage(path: string): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL(path) });
}

async function micGranted(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return status.state === "granted";
  } catch {
    return false;
  }
}

// ---- idle view ----------------------------------------------------------------------

function chip(iconName: string, text: string): HTMLSpanElement {
  const c = document.createElement("span");
  c.className = "chip";
  c.append(icon(iconName), text);
  return c;
}

/** Shows what will be recorded, and blocks Start while the microphone is needed but not allowed. */
async function renderSummary(): Promise<void> {
  const mic = micEnabled(settings);
  $<HTMLElement>("summary").replaceChildren(
    chip("video", "Audio + video"),
    ...(mic ? [chip("mic", "Microphone")] : []),
    ...(settings.transcribe ? [chip("text", "Transcript")] : []),
  );
  $<HTMLElement>("companion").hidden = !settings.transcribe;

  const blocked = mic && !(await micGranted());
  $<HTMLElement>("mic-help").hidden = !blocked;
  startButton.disabled = blocked;
}

async function showCompanion(): Promise<void> {
  const el = $<HTMLElement>("companion");
  el.textContent = "Checking transcription…";
  delete el.dataset.ready;
  delete el.dataset.tone;
  let info: CompanionInfo | undefined;
  try {
    info = (await request({ target: "background", type: "companion-status" })) as CompanionInfo | undefined;
  } catch (e) {
    el.textContent = `Could not check the companion: ${e instanceof Error ? e.message : String(e)}`;
    return;
  }
  if (!info) {
    // The popup loads fresh from disk, but the background keeps running old code
    // until the extension is reloaded.
    el.textContent = "Dohra was updated but not reloaded. Reload it in chrome://extensions.";
    return;
  }
  el.dataset.ready = String(info.ready);
  el.dataset.tone = info.ready ? "ok" : "warn";
  if (info.ready) {
    const model = info.models.find((m) => m.active)?.label ?? info.model;
    el.textContent = `Transcription ready · ${model} model`;
    return;
  }
  el.textContent = `No transcript yet: ${info.problems[0] ?? "the companion is not ready."} `;
  const link = document.createElement("a");
  link.href = "#";
  link.textContent = "Finish setup";
  link.addEventListener("click", (e) => {
    e.preventDefault();
    openPage("setup.html");
  });
  el.append(link);
}

async function persistSettings(): Promise<void> {
  const wasTranscribing = settings.transcribe;
  settings = {
    ...settings,
    mic: micCheck.checked,
    autoExport: autoExportCheck.checked,
    transcribe: transcribeCheck.checked,
  };
  await saveSettings(settings);
  await renderSummary();
  if (settings.transcribe && !wasTranscribing) void showCompanion();
}

async function initIdle(): Promise<void> {
  settings = await loadSettings();
  $<HTMLElement>("mic-switch").hidden = !settings.micSwitchInPopup;
  micCheck.checked = settings.mic;
  autoExportCheck.checked = settings.autoExport;
  transcribeCheck.checked = settings.transcribe;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  titleInput.value = tab?.title ?? "";
  titleInput.select();

  micCheck.addEventListener("change", () => void persistSettings());
  autoExportCheck.addEventListener("change", () => void persistSettings());
  transcribeCheck.addEventListener("change", () => void persistSettings());
  await renderSummary();
  if (settings.transcribe) void showCompanion();
}

async function startRecording(): Promise<void> {
  if (startButton.disabled) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  startButton.disabled = true;
  showError(null);
  try {
    await request({ target: "background", type: "start", tabId: tab.id, title: titleInput.value });
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  } finally {
    startButton.disabled = false;
  }
}

// ---- recording view -----------------------------------------------------------------

const STATUS_TEXT: Record<ActiveRecording["status"], string> = {
  starting: "Starting…",
  recording: "Recording",
  paused: "Paused",
  finalizing: "Saving…",
  exporting: "Copying to Downloads…",
};

function renderTranscriptStatus(): void {
  const t = active ? transcripts[active.sessionId] : undefined;
  $<HTMLElement>("transcript-box").hidden = !t;
  if (!t) return;
  const el = $<HTMLElement>("transcript-status");
  const bar = $<HTMLProgressElement>("transcript-progress");
  bar.max = Math.max(t.receivedMs, 1);
  bar.value = t.doneMs;
  el.textContent =
    t.state === "failed"
      ? (t.error ?? "failed")
      : `${formatDuration(t.doneMs)} of ${formatDuration(t.receivedMs)}${t.error ? ` · ${t.error}` : ""}`;
}

function renderMic(): void {
  const mic = active?.mic;
  $<HTMLElement>("mic-box").hidden = !mic?.recorded;
  if (!mic?.recorded) return;
  const text = $<HTMLElement>("mic-text");
  const muted = micMuted(mic);
  text.dataset.tone = muted ? "warn" : "ok";
  text.textContent = mic.manual
    ? "Your mic is muted in Dohra"
    : mic.meeting === true
      ? "Muted in the meeting: your mic is not recorded"
      : mic.meeting === false
        ? "Your mic is recorded (follows the meeting's mute)"
        : "Your mic is recorded";
  setButton($<HTMLButtonElement>("mic-toggle"), "mic", mic.manual ? "Unmute" : "Mute");
}

function setButton(b: HTMLButtonElement, iconName: string, text: string): void {
  b.replaceChildren(icon(iconName), text);
}

function tick(): void {
  if (!active) return;
  $<HTMLElement>("timer").textContent = formatDuration(liveDuration(active.progress));
}

function render(): void {
  idleView.hidden = !!active;
  recordingView.hidden = !active;
  window.clearInterval(timer);
  if (!active) return;

  $<HTMLElement>("rec-title").textContent = active.title;
  const status = $<HTMLElement>("rec-status");
  status.replaceChildren();
  if (active.status === "recording") {
    const dot = document.createElement("span");
    dot.className = "pulse";
    status.append(dot);
  }
  status.append(STATUS_TEXT[active.status]);
  status.dataset.status = active.status;
  $<HTMLElement>("size").textContent = formatBytes(active.progress.bytes);
  renderTranscriptStatus();

  const busy = active.status === "finalizing" || active.status === "exporting" || active.status === "starting";
  pauseButton.disabled = busy;
  stopButton.disabled = busy;
  if (active.status === "paused") setButton(pauseButton, "record", "Resume");
  else setButton(pauseButton, "pause", "Pause");
  setButton(stopButton, "stop", "Stop");
  renderMic();

  tick();
  if (active.status === "recording") timer = window.setInterval(tick, 500);
}

// ---- wiring -------------------------------------------------------------------------

async function main(): Promise<void> {
  hydrateIcons();
  const stored = await chrome.storage.session.get([ACTIVE_KEY, LAST_ERROR_KEY, TRANSCRIPTS_KEY]);
  active = (stored[ACTIVE_KEY] as ActiveRecording | undefined) ?? null;
  transcripts = (stored[TRANSCRIPTS_KEY] as Record<string, TranscriptStatus> | undefined) ?? {};
  showError((stored[LAST_ERROR_KEY] as string | undefined) ?? null);
  await initIdle();
  render();

  chrome.storage.session.onChanged.addListener((changes) => {
    if (ACTIVE_KEY in changes) {
      active = (changes[ACTIVE_KEY]!.newValue as ActiveRecording | undefined) ?? null;
      render();
    }
    if (LAST_ERROR_KEY in changes) showError((changes[LAST_ERROR_KEY]!.newValue as string | undefined) ?? null);
    if (TRANSCRIPTS_KEY in changes) {
      transcripts = (changes[TRANSCRIPTS_KEY]!.newValue as Record<string, TranscriptStatus> | undefined) ?? {};
      renderTranscriptStatus();
    }
  });

  startButton.addEventListener("click", () => void startRecording());
  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void startRecording();
  });
  stopButton.addEventListener("click", () => void request({ target: "background", type: "stop" }).catch((e) => showError(String(e))));
  $<HTMLButtonElement>("mic-toggle").addEventListener("click", () => {
    const muted = !active?.mic?.manual;
    void request({ target: "background", type: "mic-manual", muted }).catch((e) => showError(String(e)));
  });
  pauseButton.addEventListener("click", () => {
    const type = active?.status === "paused" ? "resume" : "pause";
    void request({ target: "background", type }).catch((e) => showError(String(e)));
  });
  for (const [id, page] of [
    ["open-library", "library.html"],
    ["open-settings", "settings.html"],
    ["allow-mic", "permissions.html"],
  ] as const) {
    $<HTMLAnchorElement>(id).addEventListener("click", (e) => {
      e.preventDefault();
      openPage(page);
    });
  }
}

void main();
