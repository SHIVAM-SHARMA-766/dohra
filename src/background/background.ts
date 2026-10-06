// Service worker: turns popup and keyboard commands into a recording.
//
// It owns the steps that need extension APIs — getting a tab-capture stream ID,
// managing the offscreen document, the toolbar badge, downloads — and keeps the one
// in-progress recording in chrome.storage.session, where the popup reads it.

import {
  ACTIVE_KEY,
  errorMessage,
  LAST_ERROR_KEY,
  type ActiveRecording,
  type BackgroundRequest,
  type ExportFile,
  type OffscreenRequest,
  type RecorderEvent,
  type Reply,
} from "../lib/messages";
import { sessionId, type SessionMeta } from "../lib/session";
import { loadSettings } from "../lib/settings";

const OFFSCREEN_URL = "offscreen.html";

// ---- state --------------------------------------------------------------------------

async function getActive(): Promise<ActiveRecording | null> {
  const { [ACTIVE_KEY]: active } = await chrome.storage.session.get(ACTIVE_KEY);
  return (active as ActiveRecording | undefined) ?? null;
}

async function setActive(active: ActiveRecording | null): Promise<void> {
  if (active) await chrome.storage.session.set({ [ACTIVE_KEY]: active });
  else await chrome.storage.session.remove(ACTIVE_KEY);
  await updateBadge(active);
}

async function patchActive(patch: Partial<ActiveRecording>): Promise<void> {
  const active = await getActive();
  if (active) await setActive({ ...active, ...patch });
}

async function setLastError(error: string | null): Promise<void> {
  if (error) await chrome.storage.session.set({ [LAST_ERROR_KEY]: error });
  else await chrome.storage.session.remove(LAST_ERROR_KEY);
}

async function updateBadge(active: ActiveRecording | null): Promise<void> {
  const [text, color] = !active
    ? ["", "#000000"]
    : active.status === "paused"
      ? ["II", "#5f6368"]
      : active.status === "recording" || active.status === "starting"
        ? ["REC", "#d93025"]
        : ["…", "#1a73e8"];
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

// ---- offscreen document -------------------------------------------------------------

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  return contexts.length > 0;
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS],
    justification: "Records the captured tab with MediaRecorder and writes it to disk from a worker.",
  });
}

async function closeOffscreen(): Promise<void> {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
}

async function toOffscreen(msg: OffscreenRequest): Promise<void> {
  const reply = (await chrome.runtime.sendMessage(msg)) as Reply | undefined;
  if (!reply) throw new Error("recorder did not respond");
  if (!reply.ok) throw new Error(reply.error);
}

// ---- commands -----------------------------------------------------------------------

function isCapturable(url: string | undefined): boolean {
  return !!url && /^(https?|file):/.test(url) && !url.startsWith("https://chromewebstore.google.com");
}

async function start(tabId: number, title: string): Promise<void> {
  if (await getActive()) throw new Error("a recording is already in progress");
  const tab = await chrome.tabs.get(tabId);
  if (!isCapturable(tab.url)) throw new Error("this page cannot be recorded — open the class in a normal web page");

  const settings = await loadSettings();
  // Must be requested while the user's click (popup or shortcut) still counts.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  const name = title.trim() || tab.title || "Session";
  const id = sessionId(name, new Date());
  await setLastError(null);
  await setActive({
    sessionId: id,
    title: name,
    tabId,
    mode: settings.mode,
    status: "starting",
    progress: { durationMs: 0, bytes: 0, paused: false, at: Date.now() },
  });

  try {
    await ensureOffscreen();
    await toOffscreen({
      target: "offscreen",
      type: "start",
      streamId,
      options: {
        sessionId: id,
        title: name,
        source: { url: tab.url ?? "", title: tab.title ?? "" },
        mode: settings.mode,
        quality: settings.quality,
        mic: settings.mic,
      },
    });
    await patchActive({ status: "recording" });
  } catch (e) {
    await setActive(null);
    await closeOffscreen();
    throw e;
  }
}

async function stop(): Promise<void> {
  const active = await getActive();
  if (!active || active.status === "finalizing" || active.status === "exporting") return;
  if (!(await hasOffscreen())) {
    // The recorder is gone (crashed or killed); nothing left to stop.
    await setActive(null);
    return;
  }
  await patchActive({ status: "finalizing" });
  await toOffscreen({ target: "offscreen", type: "stop" });
}

async function pauseOrResume(type: "pause" | "resume"): Promise<void> {
  if (!(await getActive())) return;
  await toOffscreen({ target: "offscreen", type });
}

async function handleRequest(msg: BackgroundRequest): Promise<void> {
  switch (msg.type) {
    case "start":
      return start(msg.tabId, msg.title);
    case "stop":
      return stop();
    case "pause":
    case "resume":
      return pauseOrResume(msg.type);
  }
}

// ---- export to Downloads ------------------------------------------------------------

function waitForDownload(id: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const listener = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === "complete") {
        chrome.downloads.onChanged.removeListener(listener);
        resolve();
      } else if (delta.state.current === "interrupted") {
        chrome.downloads.onChanged.removeListener(listener);
        reject(new Error(`download interrupted: ${delta.error?.current ?? "unknown reason"}`));
      }
    };
    chrome.downloads.onChanged.addListener(listener);
  });
}

async function exportFiles(files: ExportFile[]): Promise<void> {
  for (const file of files) {
    const id = await chrome.downloads.download({ url: file.url, filename: file.filename, conflictAction: "uniquify", saveAs: false });
    await waitForDownload(id);
  }
}

async function finished(meta: SessionMeta, files: ExportFile[]): Promise<void> {
  let exported = false;
  try {
    const settings = await loadSettings();
    if (settings.autoExport && files.length > 0) {
      await patchActive({ status: "exporting" });
      await exportFiles(files);
      exported = true;
    }
  } catch (e) {
    await setLastError(`Saved in Dohra's library, but copying to Downloads failed: ${errorMessage(e)}`);
  }
  if (meta.state === "failed") await setLastError(`Recording failed: ${meta.error ?? "unknown error"}`);
  else if (meta.error) await setLastError(`Saved with a warning: ${meta.error}`);

  try {
    await toOffscreen({ target: "offscreen", type: "exported", ok: exported });
  } finally {
    await closeOffscreen();
    await setActive(null);
  }
}

async function handleRecorderEvent(event: RecorderEvent): Promise<void> {
  switch (event.type) {
    case "recorder-progress":
      return patchActive({ progress: event.progress, status: event.progress.paused ? "paused" : "recording" });
    case "recorder-finalizing":
      return patchActive({ status: "finalizing" });
    case "recorder-finished":
      return finished(event.meta, event.files);
    case "recorder-failed":
      await setLastError(`Recording failed: ${event.error}`);
      await closeOffscreen();
      return setActive(null);
  }
}

// ---- wiring -------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg: BackgroundRequest | RecorderEvent, _sender, sendResponse: (r: Reply) => void) => {
  if (msg?.target !== "background") return false;
  const work = msg.type.startsWith("recorder-")
    ? handleRecorderEvent(msg as RecorderEvent)
    : handleRequest(msg as BackgroundRequest);
  work.then(
    () => sendResponse({ ok: true }),
    async (e) => {
      const error = errorMessage(e);
      await setLastError(error);
      sendResponse({ ok: false, error });
    },
  );
  return true;
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "toggle-recording") return;
  try {
    const active = await getActive();
    if (active) await stop();
    else if (tab?.id !== undefined) await start(tab.id, tab.title ?? "");
  } catch (e) {
    await setLastError(errorMessage(e));
  }
});

// A recording outlives a service-worker restart, but not the offscreen document. If
// that is gone, the stored state is stale; the library recovers the files themselves.
void (async () => {
  const active = await getActive();
  if (active && !(await hasOffscreen())) await setActive(null);
  else await updateBadge(active);
})();
