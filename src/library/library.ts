// The library: lists recordings stored in the extension, plays them, exports them to
// Downloads, deletes them, and finalizes recordings that a crash left unfinished.

import { ACTIVE_KEY, errorMessage, type ActiveRecording } from "../lib/messages";
import { EXPORT_DIR, FILES, formatBytes, formatDuration, type SessionMeta } from "../lib/session";
import { deleteSession, listSessions, recordingFile, StorageWorker } from "../lib/storage";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const list = $<HTMLUListElement>("list");
const empty = $<HTMLParagraphElement>("empty");
const notice = $<HTMLParagraphElement>("notice");
const search = $<HTMLInputElement>("search");
const player = $<HTMLElement>("player");
const media = $<HTMLVideoElement>("media");

let sessions: SessionMeta[] = [];
let activeId: string | null = null;
let playingUrl: string | null = null;

function showNotice(text: string | null): void {
  notice.textContent = text ?? "";
  notice.hidden = !text;
}

async function activeSessionId(): Promise<string | null> {
  const { [ACTIVE_KEY]: active } = await chrome.storage.session.get(ACTIVE_KEY);
  return (active as ActiveRecording | undefined)?.sessionId ?? null;
}

/**
 * Finalizes sessions left in "recording" or "finalizing" by a crash or a closed
 * browser. Their raw file holds everything up to the last saved chunk.
 */
async function recoverInterrupted(): Promise<number> {
  const stranded = sessions.filter((s) => (s.state === "recording" || s.state === "finalizing") && s.id !== activeId);
  if (stranded.length === 0) return 0;
  const worker = new StorageWorker();
  try {
    for (const s of stranded) {
      await worker.call({
        op: "finalize",
        sessionId: s.id,
        // Full metadata as the patch, in case session.json itself was damaged.
        patch: { ...s, endedAt: s.endedAt ?? s.updatedAt, endReason: "recovered" },
      });
    }
  } finally {
    worker.terminate();
  }
  return stranded.length;
}

async function updateUsage(): Promise<void> {
  const { usage = 0 } = await navigator.storage.estimate();
  $<HTMLElement>("usage").textContent = `${formatBytes(usage)} used in the browser`;
}

// ---- actions ------------------------------------------------------------------------

async function play(s: SessionMeta): Promise<void> {
  closePlayer();
  playingUrl = URL.createObjectURL(await recordingFile(s.id));
  $<HTMLElement>("player-title").textContent = s.title;
  media.classList.toggle("audio-only", s.mode === "audio");
  media.src = playingUrl;
  player.hidden = false;
  player.scrollIntoView({ behavior: "smooth", block: "start" });
  void media.play();
}

function closePlayer(): void {
  media.pause();
  media.removeAttribute("src");
  media.load();
  if (playingUrl) URL.revokeObjectURL(playingUrl);
  playingUrl = null;
  player.hidden = true;
}

function download(url: string, filename: string): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false }, (id) => {
      if (id === undefined) return reject(new Error(chrome.runtime.lastError?.message ?? "download failed"));
      const listener = (delta: chrome.downloads.DownloadDelta) => {
        if (delta.id !== id || !delta.state) return;
        if (delta.state.current === "complete" || delta.state.current === "interrupted") {
          chrome.downloads.onChanged.removeListener(listener);
          if (delta.state.current === "complete") resolve();
          else reject(new Error(`download interrupted: ${delta.error?.current ?? "unknown reason"}`));
        }
      };
      chrome.downloads.onChanged.addListener(listener);
    });
  });
}

async function exportSession(s: SessionMeta): Promise<void> {
  const exportedAt = new Date().toISOString();
  const recording = URL.createObjectURL(await recordingFile(s.id));
  const json = URL.createObjectURL(
    new Blob([JSON.stringify({ ...s, exportedAt }, null, 2) + "\n"], { type: "application/json" }),
  );
  try {
    await download(recording, `${EXPORT_DIR}/${s.id}/${FILES.recording}`);
    await download(json, `${EXPORT_DIR}/${s.id}/${FILES.meta}`);
  } finally {
    URL.revokeObjectURL(recording);
    URL.revokeObjectURL(json);
  }
  const worker = new StorageWorker();
  try {
    await worker.call({ op: "update", sessionId: s.id, patch: { exportedAt } });
  } finally {
    worker.terminate();
  }
}

async function remove(s: SessionMeta): Promise<void> {
  const where = s.exportedAt ? " The copy in Downloads is not affected." : " It has not been copied to Downloads.";
  if (!confirm(`Delete "${s.title}" from Dohra?${where}`)) return;
  closePlayer();
  await deleteSession(s.id);
}

async function run(action: () => Promise<void>, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  showNotice(null);
  try {
    await action();
    await refresh();
  } catch (e) {
    showNotice(errorMessage(e));
  } finally {
    button.disabled = false;
  }
}

// ---- rendering ----------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, onClick: (b: HTMLButtonElement) => void, className?: string): HTMLButtonElement {
  const b = el("button", className, label);
  b.addEventListener("click", () => onClick(b));
  return b;
}

function stateLabel(s: SessionMeta): [string, string] | null {
  if (s.id === activeId) return ["Recording now", "live"];
  if (s.state === "failed") return ["Failed", "bad"];
  if (s.state !== "complete") return ["Unfinished", "bad"];
  if (s.endReason === "recovered") return ["Recovered", "warn"];
  if (s.endReason === "tab-closed") return ["Tab closed", "warn"];
  return null;
}

function renderItem(s: SessionMeta): HTMLLIElement {
  const li = el("li", "item");
  const info = el("div", "info");

  const title = el("div", "title", s.title);
  const label = stateLabel(s);
  if (label) title.append(" ", el("span", `tag ${label[1]}`, label[0]));
  info.append(title);

  const started = new Date(s.startedAt);
  const details = [
    started.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }),
    started.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    formatDuration(s.durationMs),
    formatBytes(s.bytes),
    s.mode === "audio" ? "audio" : `video ${s.quality ?? ""}`.trim(),
    ...(s.mic ? ["+ mic"] : []),
  ];
  info.append(el("div", "meta", details.join(" · ")));
  if (s.error) info.append(el("div", "error-text", s.error));
  if (s.sha256) {
    const hash = el("div", "hash", `sha256 ${s.sha256.slice(0, 16)}…`);
    hash.title = s.sha256;
    info.append(hash);
  }
  if (s.exportedAt) info.append(el("div", "hint", `Copied to Downloads/${EXPORT_DIR}/${s.id}/`));

  const actions = el("div", "actions");
  if (s.state === "complete") {
    actions.append(
      button("Play", (b) => void run(() => play(s), b), "primary"),
      button(s.exportedAt ? "Save again" : "Save to Downloads", (b) => void run(() => exportSession(s), b)),
    );
  }
  if (s.id !== activeId) actions.append(button("Delete", (b) => void run(() => remove(s), b)));

  li.append(info, actions);
  return li;
}

function render(): void {
  const query = search.value.trim().toLowerCase();
  const shown = sessions.filter((s) => !query || s.title.toLowerCase().includes(query));
  list.replaceChildren(...shown.map(renderItem));
  empty.hidden = sessions.length > 0;
  if (sessions.length > 0 && shown.length === 0) list.append(el("li", "hint", "No titles match."));
}

async function refresh(): Promise<void> {
  activeId = await activeSessionId();
  sessions = await listSessions();
  render();
  await updateUsage();
}

async function main(): Promise<void> {
  try {
    await refresh();
    const recovered = await recoverInterrupted();
    if (recovered > 0) {
      showNotice(`Recovered ${recovered} recording${recovered > 1 ? "s" : ""} that ended unexpectedly. Everything up to the last few seconds was kept.`);
      await refresh();
    }
  } catch (e) {
    showNotice(`Could not load recordings: ${errorMessage(e)}`);
  }

  search.addEventListener("input", render);
  $<HTMLButtonElement>("player-close").addEventListener("click", closePlayer);
  // Pick up a recording as soon as it finishes.
  chrome.storage.session.onChanged.addListener((changes) => {
    if (ACTIVE_KEY in changes) void refresh();
  });
}

void main();
