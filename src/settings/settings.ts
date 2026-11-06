// Dohra's settings page. Recording format and transcript language are fixed; what
// can change is whether recordings are transcribed, the speech model, whether the
// popup offers a microphone switch, and the Downloads copy. It also checks for
// and applies updates.

import type { Reply } from "../lib/messages";
import { hydrateIcons } from "../lib/icons";
import { mountModelPicker } from "../lib/model-picker";
import { loadSettings, saveSettings } from "../lib/settings";
import type { CompanionInfo } from "../lib/transcript";
import { UPDATE_KEY, type UpdateResult, type UpdateStatus } from "../lib/update";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const micSwitch = $<HTMLInputElement>("mic-switch");
const autoExport = $<HTMLInputElement>("auto-export");
const transcribe = $<HTMLInputElement>("transcribe");
const keepInBrowser = $<HTMLInputElement>("keep-in-browser");

async function save(): Promise<void> {
  const settings = await loadSettings();
  await saveSettings({
    ...settings,
    micSwitchInPopup: micSwitch.checked,
    autoExport: autoExport.checked,
    transcribe: transcribe.checked,
    keepInBrowser: keepInBrowser.checked,
  });
  // Without the Downloads copy, the browser's is the only one.
  keepInBrowser.disabled = !autoExport.checked;
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

// ---- updates ----------------------------------------------------------------------

async function ask<T>(type: "update-check" | "update-apply"): Promise<T> {
  const reply = (await chrome.runtime.sendMessage({ target: "background", type })) as Reply | undefined;
  if (!reply) throw new Error("no answer from Dohra's background — reload the extension");
  if (!reply.ok) throw new Error(reply.error);
  return reply.data as T;
}

function showUpdate(status: UpdateStatus | null, error?: string): void {
  const version = chrome.runtime.getManifest().version;
  $<HTMLElement>("versions").textContent =
    `Dohra ${version}` + (status?.companion ? ` · companion ${status.companion}` : "");
  const el = $<HTMLElement>("update-status");
  const apply = $<HTMLButtonElement>("update-apply");
  const why = $<HTMLElement>("update-why");
  const notes = $<HTMLAnchorElement>("update-notes");
  apply.hidden = true;
  why.hidden = true;
  notes.hidden = true;
  delete el.dataset.tone;
  if (error) {
    el.textContent = `Could not check: ${error}`;
    return;
  }
  if (!status) {
    el.textContent = "";
    return;
  }
  const when = new Date(status.checkedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  if (!status.available) {
    el.dataset.tone = "ok";
    el.textContent = `Up to date (checked ${when}).`;
    return;
  }
  el.dataset.tone = "new";
  el.textContent = `Dohra ${status.latest} is available.`;
  notes.href = status.url;
  notes.hidden = false;
  if (status.canApply) {
    apply.textContent = `Update to ${status.latest}`;
    apply.hidden = false;
  }
  if (status.why) {
    why.textContent = status.why;
    why.hidden = false;
  }
}

let checking = false;

async function checkUpdate(): Promise<void> {
  checking = true;
  const button = $<HTMLButtonElement>("update-check");
  button.disabled = true;
  $<HTMLElement>("update-status").textContent = "Checking…";
  try {
    showUpdate(await ask<UpdateStatus>("update-check"));
  } catch (e) {
    showUpdate(null, e instanceof Error ? e.message : String(e));
  } finally {
    checking = false;
    button.disabled = false;
  }
}

async function applyUpdate(): Promise<void> {
  const apply = $<HTMLButtonElement>("update-apply");
  const el = $<HTMLElement>("update-status");
  apply.disabled = true;
  $<HTMLButtonElement>("update-check").disabled = true;
  el.textContent = "Downloading and installing… Dohra restarts by itself when done.";
  try {
    const result = await ask<UpdateResult>("update-apply");
    // With the extension's folder rewritten, Dohra reloads now and this page closes.
    el.textContent = result.updated?.length
      ? `Updated to ${result.version}. Restarting Dohra…`
      : `The companion is updated to ${result.version}.`;
  } catch (e) {
    el.textContent = `Update failed: ${e instanceof Error ? e.message : String(e)}`;
    apply.disabled = false;
  } finally {
    $<HTMLButtonElement>("update-check").disabled = false;
  }
}

async function initUpdates(): Promise<void> {
  $<HTMLButtonElement>("update-check").addEventListener("click", () => void checkUpdate());
  $<HTMLButtonElement>("update-apply").addEventListener("click", () => void applyUpdate());
  const { [UPDATE_KEY]: last } = await chrome.storage.local.get(UPDATE_KEY);
  const status = (last as UpdateStatus | undefined) ?? null;
  // A check from before the running version was installed is stale. One already
  // running (a click before this loaded) will show its own result.
  if (!checking) showUpdate(status && status.current === chrome.runtime.getManifest().version ? status : null);
  if (location.hash === "#updates") {
    $<HTMLElement>("updates").scrollIntoView();
    const s = $<HTMLElement>("saved");
    s.textContent = `Dohra is updated to ${chrome.runtime.getManifest().version}.`;
    setTimeout(() => (s.textContent = ""), 4000);
    await checkUpdate();
  }
}

async function main(): Promise<void> {
  hydrateIcons();
  const settings = await loadSettings();
  micSwitch.checked = settings.micSwitchInPopup;
  autoExport.checked = settings.autoExport;
  transcribe.checked = settings.transcribe;
  keepInBrowser.checked = settings.keepInBrowser;
  keepInBrowser.disabled = !settings.autoExport;
  keepInBrowser.addEventListener("change", () => void save());
  $<HTMLElement>("model-settings").hidden = !settings.transcribe;
  micSwitch.addEventListener("change", () => void save());
  autoExport.addEventListener("change", () => void save());
  transcribe.addEventListener("change", () => void save());

  await showMicPermission();
  void showCompanion();
  void initUpdates();
}

void main();
