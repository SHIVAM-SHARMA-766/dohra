import { ACTIVE_KEY, LAST_ERROR_KEY, liveDuration, type ActiveRecording, type BackgroundRequest, type Reply } from "../lib/messages";
import { formatBytes, formatDuration } from "../lib/session";
import { estimateBytesPerHour, loadSettings, saveSettings, type Mode, type Quality, type Settings } from "../lib/settings";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const idleView = $<HTMLElement>("idle");
const recordingView = $<HTMLElement>("recording");
const errorBanner = $<HTMLParagraphElement>("error");
const titleInput = $<HTMLInputElement>("title");
const qualitySelect = $<HTMLSelectElement>("quality");
const micCheck = $<HTMLInputElement>("mic");
const autoExportCheck = $<HTMLInputElement>("auto-export");
const startButton = $<HTMLButtonElement>("start");
const pauseButton = $<HTMLButtonElement>("pause");
const stopButton = $<HTMLButtonElement>("stop");

let settings: Settings;
let active: ActiveRecording | null = null;
let timer: number | undefined;

async function request(msg: BackgroundRequest): Promise<void> {
  const reply = (await chrome.runtime.sendMessage(msg)) as Reply | undefined;
  if (reply && !reply.ok) throw new Error(reply.error);
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
}

async function persistSettings(): Promise<void> {
  settings = {
    mode: selectedMode(),
    quality: qualitySelect.value as Quality,
    mic: micCheck.checked,
    autoExport: autoExportCheck.checked,
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

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  titleInput.value = tab?.title ?? "";
  titleInput.select();

  for (const el of document.querySelectorAll("#idle input, #idle select")) {
    if (el !== titleInput) el.addEventListener("change", () => void persistSettings());
  }
  await renderSettings();
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

  const busy = active.status === "finalizing" || active.status === "exporting" || active.status === "starting";
  pauseButton.disabled = busy;
  stopButton.disabled = busy;
  pauseButton.textContent = active.status === "paused" ? "Resume" : "Pause";

  tick();
  if (active.status === "recording") timer = window.setInterval(tick, 500);
}

// ---- wiring -------------------------------------------------------------------------

async function main(): Promise<void> {
  const stored = await chrome.storage.session.get([ACTIVE_KEY, LAST_ERROR_KEY]);
  active = (stored[ACTIVE_KEY] as ActiveRecording | undefined) ?? null;
  showError((stored[LAST_ERROR_KEY] as string | undefined) ?? null);
  await initIdle();
  render();

  chrome.storage.session.onChanged.addListener((changes) => {
    if (ACTIVE_KEY in changes) {
      active = (changes[ACTIVE_KEY]!.newValue as ActiveRecording | undefined) ?? null;
      render();
    }
    if (LAST_ERROR_KEY in changes) showError((changes[LAST_ERROR_KEY]!.newValue as string | undefined) ?? null);
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
