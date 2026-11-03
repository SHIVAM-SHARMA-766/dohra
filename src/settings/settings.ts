// Dohra's settings page. Recording format and transcript language are fixed; what
// can change is whether recordings are transcribed, the speech model, whether the
// popup offers a microphone switch, and the Downloads copy.

import type { Reply } from "../lib/messages";
import { hydrateIcons } from "../lib/icons";
import { mountModelPicker } from "../lib/model-picker";
import { loadSettings, saveSettings } from "../lib/settings";
import type { CompanionInfo } from "../lib/transcript";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const micSwitch = $<HTMLInputElement>("mic-switch");
const autoExport = $<HTMLInputElement>("auto-export");
const transcribe = $<HTMLInputElement>("transcribe");

async function save(): Promise<void> {
  const settings = await loadSettings();
  await saveSettings({
    ...settings,
    micSwitchInPopup: micSwitch.checked,
    autoExport: autoExport.checked,
    transcribe: transcribe.checked,
  });
  $<HTMLElement>("model-settings").hidden = !transcribe.checked;
  $<HTMLElement>("saved").textContent = "Saved.";
  setTimeout(() => ($<HTMLElement>("saved").textContent = ""), 1500);
}

async function showMicPermission(): Promise<void> {
  const el = $<HTMLElement>("mic-permission");
  let state = "prompt";
  try {
    state = (await navigator.permissions.query({ name: "microphone" as PermissionName })).state;
  } catch {}
  el.dataset.granted = String(state === "granted");
  el.replaceChildren();
  if (state === "granted") {
    el.textContent = "Access allowed";
    return;
  }
  el.textContent = "Microphone access is not allowed yet. ";
  const link = document.createElement("a");
  link.href = "permissions.html";
  link.textContent = "Allow microphone";
  el.append(link);
}

function companionText(info: CompanionInfo): string {
  if (info.ready) return `Companion ${info.version} is ready.`;
  return info.problems.join(" ") || "Not ready.";
}

async function showCompanion(): Promise<void> {
  const el = $<HTMLElement>("companion");
  try {
    const reply = (await chrome.runtime.sendMessage({ target: "background", type: "companion-status" })) as Reply | undefined;
    if (!reply) throw new Error("no answer from Dohra's background — reload the extension");
    if (!reply.ok) throw new Error(reply.error);
    const info = reply.data as CompanionInfo | undefined;
    if (!info) throw new Error("Dohra was updated but not reloaded — reload it in chrome://extensions");
    el.dataset.ready = String(info.ready);
    el.textContent = companionText(info);
    if (info.version === null) {
      // Without the companion there are no models to manage: point to setup.
      el.append(" ");
      const link = document.createElement("a");
      link.href = "setup.html";
      link.textContent = "Set up transcription";
      el.append(link);
      return;
    }
    mountModelPicker($<HTMLElement>("models"), info, (updated) => {
      el.dataset.ready = String(updated.ready);
      el.textContent = companionText(updated);
    });
  } catch (e) {
    el.textContent = e instanceof Error ? e.message : String(e);
  }
}

async function main(): Promise<void> {
  hydrateIcons();
  const settings = await loadSettings();
  micSwitch.checked = settings.micSwitchInPopup;
  autoExport.checked = settings.autoExport;
  transcribe.checked = settings.transcribe;
  $<HTMLElement>("model-settings").hidden = !settings.transcribe;
  micSwitch.addEventListener("change", () => void save());
  autoExport.addEventListener("change", () => void save());
  transcribe.addEventListener("change", () => void save());

  await showMicPermission();
  void showCompanion();
}

void main();
