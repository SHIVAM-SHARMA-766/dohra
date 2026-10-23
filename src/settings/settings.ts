// Dohra's settings page. Recording format, transcription and language are fixed;
// what can change is whether the popup offers a microphone switch, and the
// Downloads copy.

import type { Reply } from "../lib/messages";
import { formatBytes } from "../lib/session";
import { estimateBytesPerHour, loadSettings, saveSettings, screenResolution } from "../lib/settings";
import type { CompanionInfo } from "../lib/transcript";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const micSwitch = $<HTMLInputElement>("mic-switch");
const autoExport = $<HTMLInputElement>("auto-export");

async function save(): Promise<void> {
  const settings = await loadSettings();
  await saveSettings({ ...settings, micSwitchInPopup: micSwitch.checked, autoExport: autoExport.checked });
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
    el.textContent = "Microphone access is allowed.";
    return;
  }
  el.textContent = "Microphone access is not allowed yet. ";
  const link = document.createElement("a");
  link.href = "permissions.html";
  link.textContent = "Allow microphone";
  el.append(link);
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
    el.textContent = info.ready
      ? `Ready — companion ${info.version}, ${info.model} model.`
      : info.problems.join(" ") || "Not ready.";
  } catch (e) {
    el.textContent = e instanceof Error ? e.message : String(e);
  }
}

async function main(): Promise<void> {
  const { width, height } = screenResolution();
  $<HTMLElement>("resolution").textContent = `${width}×${height}`;
  $<HTMLElement>("estimate").textContent = formatBytes(estimateBytesPerHour(width, height));

  const settings = await loadSettings();
  micSwitch.checked = settings.micSwitchInPopup;
  autoExport.checked = settings.autoExport;
  micSwitch.addEventListener("change", () => void save());
  autoExport.addEventListener("change", () => void save());

  await showMicPermission();
  void showCompanion();
}

void main();
