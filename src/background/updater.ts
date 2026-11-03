// Checking for and applying updates (see lib/update.ts). A check asks the
// companion, which also finds the extension's folders; without one, it reads the
// latest release from GitHub itself, so the popup can still say an update exists.
// Applying needs the companion, and never happens during a recording.

import {
  LATEST_API,
  newer,
  UPDATE_KEY,
  UPDATED_KEY,
  type Place,
  type UpdateResult,
  type UpdateStatus,
} from "../lib/update";
import * as transcriber from "./transcriber";

/** How often the background checks by itself. */
const AUTO_CHECK_MS = 24 * 60 * 60 * 1000;

interface CompanionUpdateInfo {
  latest: string;
  url: string;
  companion: string;
  places: Place[] | null;
}

function current(): string {
  return chrome.runtime.getManifest().version;
}

// The REST API, since github.com's pages cannot be read across origins. It allows
// 60 requests an hour per IP address; on a busy shared network the check may fail
// until later. The companion does not use it.
async function fromGitHub(): Promise<{ latest: string; url: string }> {
  const res = await fetch(LATEST_API, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`could not reach GitHub to check for updates (${res.status})`);
  const body = (await res.json()) as { tag_name: string; html_url: string };
  return { latest: body.tag_name.replace(/^v/, ""), url: body.html_url };
}

export async function check(): Promise<UpdateStatus> {
  let status: UpdateStatus;
  let viaCompanion: CompanionUpdateInfo | null = null;
  try {
    viaCompanion = await transcriber.companionUpdate<CompanionUpdateInfo>("update-check");
  } catch {
    // Not installed, or a companion from before 0.6 that cannot update.
  }
  if (viaCompanion) {
    const places = viaCompanion.places ?? [];
    const available = newer(viaCompanion.latest, current()) || newer(viaCompanion.latest, viaCompanion.companion);
    const usable = places.filter((p) => !p.skip);
    status = {
      checkedAt: Date.now(),
      current: current(),
      latest: viaCompanion.latest,
      available,
      url: viaCompanion.url,
      companion: viaCompanion.companion,
      places,
      canApply: available && (usable.length > 0 || newer(viaCompanion.latest, viaCompanion.companion)),
    };
    if (available && usable.length === 0) {
      status.why =
        places[0]?.skip ??
        "The companion could not find the folder Dohra is loaded from. Update it by hand: download the new zip, unzip it over the old folder, and reload Dohra.";
    }
  } else {
    const gh = await fromGitHub();
    const available = newer(gh.latest, current());
    status = {
      checkedAt: Date.now(),
      current: current(),
      ...gh,
      available,
      companion: null,
      places: [],
      canApply: false,
      ...(available
        ? {
            why: "Updating by itself needs the companion (version 0.6 or later). Without it: download the new zip, unzip it over the old folder, and reload Dohra in chrome://extensions.",
          }
        : {}),
    };
  }
  await chrome.storage.local.set({ [UPDATE_KEY]: status });
  return status;
}

/** Checks once a day in the background, quietly. */
export async function checkIfDue(): Promise<void> {
  const { [UPDATE_KEY]: last } = await chrome.storage.local.get(UPDATE_KEY);
  const status = last as UpdateStatus | undefined;
  // A check from before this version was installed says nothing about it.
  if (status && status.current === current() && Date.now() - status.checkedAt < AUTO_CHECK_MS) return;
  await check().catch(() => {});
}

/**
 * Has the companion update the extension's folder(s) and itself, then reloads
 * Dohra so the new files run. `recording` blocks it: a reload ends the recording.
 */
export async function apply(recording: boolean): Promise<UpdateResult> {
  if (recording) throw new Error("finish the recording first: updating restarts Dohra");
  const result = await transcriber.companionUpdate<UpdateResult>("update-apply");
  const updated = result.updated ?? [];
  if (updated.length > 0) {
    await chrome.storage.local.set({ [UPDATED_KEY]: { from: current(), to: result.version } });
    // Let the reply reach the page first. Reloading closes Dohra's pages; the new
    // version reopens Settings to say it is done.
    setTimeout(() => chrome.runtime.reload(), 500);
  } else {
    await check().catch(() => {});
  }
  return result;
}

/** After an update's reload: reopens Settings on the result, once. */
export async function announceIfUpdated(): Promise<void> {
  const { [UPDATED_KEY]: updated } = await chrome.storage.local.get(UPDATED_KEY);
  if (!updated) return;
  await chrome.storage.local.remove(UPDATED_KEY);
  // Settings checks again by itself when opened this way.
  await chrome.tabs.create({ url: chrome.runtime.getURL("settings.html#updates") });
}
