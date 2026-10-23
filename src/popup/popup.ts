import { ACTIVE_KEY, LAST_ERROR_KEY, liveDuration, type ActiveRecording, type BackgroundRequest, type Reply } from "../lib/messages";
import { formatBytes, formatDuration } from "../lib/session";
import {
  estimateBytesPerHour,
  loadSettings,
  saveSettings,
  type Language,
  type Mode,
  type Quality,
  type Settings,
} from "../lib/settings";
import { TRANSCRIPTS_KEY, type CompanionInfo, type TranscriptStatus } from "../lib/transcript";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const idleView = $<HTMLElement>("idle");
const recordingView = $<HTMLElement>("recording");
const errorBanner = $<HTMLParagraphElement>("error");
const titleInput = $<HTMLInputElement>("title");
const qualitySelect = $<HTMLSelectElement>("quality");
const micCheck = $<HTMLInputElement>("mic");
const autoExportCheck = $<HTMLInputElement>("auto-export");
const transcribeCheck = $<HTMLInputElement>("transcribe");
const languageSelect = $<HTMLSelectElement>("language");
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

async function micGranted(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return status.state === "granted";
  } catch {
    return false;
  }
}

// ---- idle view ----------------------------------------------------------------------

function selectedMode(): Mode {
  return (document.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value as Mode) ?? "video";
}

async function renderSettings(): Promise<void> {
  const mode = selectedMode();
  $<HTMLElement>("quality-field").hidden = mode === "audio";
  const perHour = estimateBytesPerHour(mode, qualitySelect.value as Quality);
  $<HTMLElement>("estimate").textContent = `About ${formatBytes(perHour)} per hour.`;
  $<HTMLElement>("mic-help").hidden = !micCheck.checked || (await micGranted());
  $<HTMLElement>("language-field").hidden = !transcribeCheck.checked;
  $<HTMLElement>("companion").hidden = !transcribeCheck.checked;
}

async function showCompanion(): Promise<void> {
  const el = $<HTMLElement>("companion");
  el.textContent = "Checking the transcription companion…";
  try {
    const info = (await request({ target: "background", type: "companion-status" })) as CompanionInfo;
    el.dataset.ready = String(info.ready);
    if (info.ready) {
      el.textContent = `Companion ready · ${info.model} model`;
    } else {
      el.textContent = `${info.problems[0] ?? "The companion is not ready."} `;
      const link = document.createElement("a");
      link.href = "#";
      link.textContent = "Set it up";
      link.addEventListener("click", (e) => {
        e.preventDefault();
        void chrome.tabs.create({ url: chrome.runtime.getURL("companion.html") });
      });
      el.append(link);
    }
  } catch (e) {
    el.textContent = `Could not check the companion: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function persistSettings(): Promise<void> {
  settings = {
    mode: selectedMode(),
    quality: qualitySelect.value as Quality,
    mic: micCheck.checked,
    autoExport: autoExportCheck.checked,
    transcribe: transcribeCheck.checked,
    language: languageSelect.value as Language,
  };
  await saveSettings(settings);
  await renderSettings();
}

async function initIdle(): Promise<void> {
  settings = await loadSettings();
  document.querySelector<HTMLInputElement>(`input[name="mode"][value="${settings.mode}"]`)!.checked = true;
  qualitySelect.value = settings.quality;
  micCheck.checked = settings.mic;
  autoExportCheck.checked = settings.autoExport;
  transcribeCheck.checked = settings.transcribe;
  languageSelect.value = settings.language;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  titleInput.value = tab?.title ?? "";
  titleInput.select();

  for (const el of document.querySelectorAll("#idle input, #idle select")) {
    if (el !== titleInput) el.addEventListener("change", () => void persistSettings());
  }
  await renderSettings();
  if (settings.transcribe) void showCompanion();
  transcribeCheck.addEventListener("change", () => {
    if (transcribeCheck.checked) void showCompanion();
  });
}

async function startRecording(): Promise<void> {
  if (settings.mic && !(await micGranted())) {
    showError("Allow microphone access first, or untick 'Include my microphone'.");
    return;
  }
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
  const el = $<HTMLElement>("transcript-status");
  const t = active ? transcripts[active.sessionId] : undefined;
  if (!t) {
    el.textContent = "";
    return;
  }
  el.textContent =
    t.state === "failed"
      ? `Transcript failed: ${t.error ?? "unknown error"}`
      : `Transcript: ${formatDuration(t.doneMs)} of ${formatDuration(t.receivedMs)} done${t.error ? ` (${t.error})` : ""}`;
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
  status.textContent = STATUS_TEXT[active.status];
  status.dataset.status = active.status;
  $<HTMLElement>("size").textContent = `${formatBytes(active.progress.bytes)} saved`;
  renderTranscriptStatus();

  const busy = active.status === "finalizing" || active.status === "exporting" || active.status === "starting";
  pauseButton.disabled = busy;
  stopButton.disabled = busy;
  pauseButton.textContent = active.status === "paused" ? "Resume" : "Pause";

  tick();
  if (active.status === "recording") timer = window.setInterval(tick, 500);
}

// ---- wiring -------------------------------------------------------------------------

async function main(): Promise<void> {
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
  pauseButton.addEventListener("click", () => {
    const type = active?.status === "paused" ? "resume" : "pause";
    void request({ target: "background", type }).catch((e) => showError(String(e)));
  });
  $<HTMLAnchorElement>("open-library").addEventListener("click", (e) => {
    e.preventDefault();
    void chrome.tabs.create({ url: chrome.runtime.getURL("library.html") });
  });
  $<HTMLAnchorElement>("allow-mic").addEventListener("click", (e) => {
    e.preventDefault();
    void chrome.tabs.create({ url: chrome.runtime.getURL("permissions.html") });
  });
}

void main();
