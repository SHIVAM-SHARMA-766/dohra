// First-run setup, opened when Dohra is installed and whenever transcription is
// not ready: microphone permission, then — only for transcripts — the companion and
// a speech model. Each step shows its state and the page moves on by itself as each
// is done. Choosing "just record" turns transcripts off and skips the last two.

import { hydrateIcons } from "../lib/icons";
import type { Reply } from "../lib/messages";
import { mountModelPicker } from "../lib/model-picker";
import { loadSettings, saveSettings } from "../lib/settings";
import type { CompanionInfo } from "../lib/transcript";

const REPO = "SHIVAM-SHARMA-766/dohra";
const POLL_MS = 3_000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Platform {
  id: string;
  name: string;
  commands: string;
}

// The latest release's files, at addresses that always point to the newest version.
const DOWNLOAD = `https://github.com/${REPO}/releases/latest/download`;

const PLATFORMS: Platform[] = [
  {
    id: "linux",
    name: "Linux (Terminal)",
    commands: `curl -fLo dohra-companion ${DOWNLOAD}/dohra-companion-linux-amd64
chmod +x dohra-companion
./dohra-companion install`,
  },
  {
    id: "windows",
    name: "Windows (PowerShell)",
    commands: `Invoke-WebRequest ${DOWNLOAD}/dohra-companion-windows-amd64.exe -OutFile dohra-companion.exe
.\\dohra-companion.exe install`,
  },
  {
    id: "mac",
    name: "macOS (Terminal, with Homebrew)",
    commands: `brew install whisper-cpp
curl -fLo dohra-companion ${DOWNLOAD}/dohra-companion-darwin-$(uname -m | sed s/x86_64/amd64/)
chmod +x dohra-companion
./dohra-companion install`,
  },
];

function currentPlatform(): string {
  const p = navigator.platform.toLowerCase();
  if (p.startsWith("win")) return "windows";
  if (p.startsWith("mac")) return "mac";
  return "linux";
}

function renderPlatforms(): void {
  const here = currentPlatform();
  const sorted = [...PLATFORMS].sort((a, b) => Number(b.id === here) - Number(a.id === here));
  for (const p of sorted) {
    const section = document.createElement("div");
    section.className = `platform${p.id === here ? " current" : ""}`;
    const title = document.createElement("h3");
    title.textContent = p.name;
    const pre = document.createElement("pre");
    pre.textContent = p.commands;
    const copy = document.createElement("button");
    copy.className = "copy small";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(p.commands).then(() => {
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1500);
      });
    });
    section.append(title, pre, copy);
    $("platforms").append(section);
  }
}

function markStep(id: string, done: boolean): void {
  $(id).dataset.done = String(done);
}

// ---- 1. microphone ------------------------------------------------------------------

let micDone = false;

async function checkMic(): Promise<void> {
  let state = "prompt";
  try {
    state = (await navigator.permissions.query({ name: "microphone" as PermissionName })).state;
  } catch {}
  micDone = state === "granted";
  markStep("step-mic", micDone);
  $("allow-mic").hidden = micDone || state === "denied";
  $("mic-status").textContent = micDone
    ? "Microphone allowed."
    : state === "denied"
      ? "The microphone is blocked. Allow it in the browser's site settings for Dohra, then reload this page."
      : "";
  updateDone();
}

async function allowMic(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    // checkMic reports the outcome.
  }
  await checkMic();
}

// ---- 2. companion, 3. model ---------------------------------------------------------

let info: CompanionInfo | null = null;
let picker: (() => void) | null = null;
let pollTimer: number | undefined;

async function companionStatus(): Promise<CompanionInfo> {
  const reply = (await chrome.runtime.sendMessage({ target: "background", type: "companion-status" })) as
    | Reply
    | undefined;
  if (!reply) throw new Error("Dohra's background did not answer; reload the extension in chrome://extensions.");
  if (!reply.ok) throw new Error(reply.error);
  return reply.data as CompanionInfo;
}

function showCompanion(next: CompanionInfo): void {
  info = next;
  const status = $("companion-status");
  markStep("step-companion", next.installed && next.version !== null);
  $("companion-install").hidden = next.installed && next.version !== null;
  if (next.version !== null) {
    status.textContent = `Companion ${next.version} installed.`;
  } else {
    status.textContent = next.problems[0] ?? "The companion is not installed yet.";
  }

  markStep("step-model", next.ready);
  $("model-wait").hidden = next.version !== null;
  if (next.version !== null && !picker) {
    picker = mountModelPicker($("models"), next, (updated) => {
      info = updated;
      markStep("step-model", updated.ready);
      updateDone();
    });
  }
  updateDone();
}

async function check(): Promise<void> {
  window.clearTimeout(pollTimer);
  try {
    showCompanion(await companionStatus());
  } catch (e) {
    $("companion-status").textContent = e instanceof Error ? e.message : String(e);
  }
  // Wait for the companion to be installed from the terminal.
  if (!info || info.version === null) pollTimer = window.setTimeout(() => void check(), POLL_MS);
}

// ---- transcripts or recording only ----------------------------------------------

let transcribe = true;

function showChoice(): void {
  $("want-transcripts").setAttribute("aria-pressed", String(transcribe));
  $("record-only").setAttribute("aria-pressed", String(!transcribe));
  document.querySelector("main")!.dataset.recordOnly = String(!transcribe);
  $("done-transcripts").hidden = !transcribe;
  updateDone();
}

async function choose(want: boolean): Promise<void> {
  transcribe = want;
  await saveSettings({ ...(await loadSettings()), transcribe: want });
  showChoice();
}

function updateDone(): void {
  $("done").hidden = !(micDone && (!transcribe || info?.ready));
}

hydrateIcons();
renderPlatforms();
$("allow-mic").addEventListener("click", () => void allowMic());
$("want-transcripts").addEventListener("click", () => void choose(true));
$("record-only").addEventListener("click", () => void choose(false));
void loadSettings().then((s) => {
  transcribe = s.transcribe;
  showChoice();
});
void checkMic();
void check();
