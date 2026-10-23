// The library: lists recordings stored in the extension with their transcript state,
// opens them, exports them to Downloads, deletes them, and finalizes recordings
// that a crash left unfinished.

import { hydrateIcons, icon } from "../lib/icons";
import { ACTIVE_KEY, errorMessage, type ActiveRecording } from "../lib/messages";
import { EXPORT_DIR, FILES, formatBytes, formatDuration, type SessionMeta } from "../lib/session";
import { deleteSession, listSessions, recordingFile, StorageWorker } from "../lib/storage";
import { readTranscript, TRANSCRIPTS_KEY, type TranscriptState, type TranscriptStatus } from "../lib/transcript";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const list = $<HTMLUListElement>("list");
const empty = $<HTMLElement>("empty");
const notice = $<HTMLParagraphElement>("notice");
const search = $<HTMLInputElement>("search");

let sessions: SessionMeta[] = [];
let activeId: string | null = null;
let transcriptStates: Record<string, TranscriptState | undefined> = {};

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
  $<HTMLElement>("usage").textContent = `${formatBytes(usage)} used`;
}

// ---- actions ------------------------------------------------------------------------

function open(s: SessionMeta): void {
  location.href = `session.html?id=${encodeURIComponent(s.id)}`;
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

function button(
  label: string,
  onClick: (b: HTMLButtonElement) => void,
  opts: { className?: string; iconName?: string; iconOnly?: boolean } = {},
): HTMLButtonElement {
  const b = el("button", opts.className);
  if (opts.iconName) b.append(icon(opts.iconName));
  if (opts.iconOnly) {
    b.title = label;
    b.setAttribute("aria-label", label);
  } else {
    b.append(label);
  }
  b.addEventListener("click", () => onClick(b));
  return b;
}

function metaItem(iconName: string, text: string): HTMLSpanElement {
  const span = el("span");
  span.append(icon(iconName), text);
  return span;
}

const TRANSCRIPT_TAG: Record<TranscriptState | "none", [string, string] | null> = {
  none: null,
  live: ["Transcribing", "info"],
  transcribing: ["Transcribing", "info"],
  complete: ["Transcript", "ok"],
  failed: ["Transcript failed", "bad"],
};

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
  const playable = s.state === "complete";

  const thumb = el("button", `thumb${playable ? "" : " muted"}`);
  thumb.append(icon(playable ? "play" : "video"));
  thumb.title = playable ? "Open" : s.title;
  thumb.disabled = !playable;
  thumb.addEventListener("click", () => open(s));

  const info = el("div", "info");
  const title = el("div", "title", s.title);
  const label = stateLabel(s);
  if (label) title.append(el("span", `tag ${label[1]}`, label[0]));
  const transcript = TRANSCRIPT_TAG[transcriptStates[s.id] ?? "none"];
  if (transcript) title.append(el("span", `tag ${transcript[1]}`, transcript[0]));
  info.append(title);

  const started = new Date(s.startedAt);
  const meta = el("div", "meta");
  meta.append(
    metaItem(
      "clock",
      `${started.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}, ${started.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`,
    ),
    metaItem("play", formatDuration(s.durationMs)),
    metaItem("disk", formatBytes(s.bytes)),
    metaItem(s.mode === "audio" ? "mic" : "video", s.mode === "audio" ? "Audio" : `${s.quality ?? "Video"}`),
    ...(s.mic ? [metaItem("mic", "Mic")] : []),
  );
  info.append(meta);
  if (s.error) info.append(el("div", "error-text", s.error));
  const extra: string[] = [];
  if (s.exportedAt) extra.push(`Copied to Downloads/${EXPORT_DIR}/${s.id}/`);
  if (extra.length || s.sha256) {
    const row = el("div", "extra", extra.join(""));
    if (s.sha256) {
      const hash = el("span", "hash", `${extra.length ? " · " : ""}sha256 ${s.sha256.slice(0, 12)}…`);
      hash.title = s.sha256;
      row.append(hash);
    }
    info.append(row);
  }

  const actions = el("div", "actions");
  if (playable) {
    actions.append(
      button("Open", () => open(s), { className: "primary small" }),
      button(s.exportedAt ? "Save to Downloads again" : "Save to Downloads", (b) => void run(() => exportSession(s), b), {
        className: "ghost small",
        iconName: "download",
        iconOnly: true,
      }),
    );
  }
  if (s.id !== activeId) {
    actions.append(button("Delete", (b) => void run(() => remove(s), b), { className: "ghost small", iconName: "trash", iconOnly: true }));
  }

  li.append(thumb, info, actions);
  return li;
}

function render(): void {
  const query = search.value.trim().toLowerCase();
  const shown = sessions.filter((s) => !query || s.title.toLowerCase().includes(query));
  list.replaceChildren(...shown.map(renderItem));
  empty.hidden = sessions.length > 0;
  $<HTMLElement>("count").textContent = sessions.length === 1 ? "1 recording" : `${sessions.length} recordings`;
  if (sessions.length > 0 && shown.length === 0) list.append(el("li", "hint", "No titles match."));
}

async function loadTranscriptStates(): Promise<void> {
  const { [TRANSCRIPTS_KEY]: live } = await chrome.storage.session.get(TRANSCRIPTS_KEY);
  const statuses = (live as Record<string, TranscriptStatus> | undefined) ?? {};
  const entries = await Promise.all(
    sessions.map(async (s) => [s.id, statuses[s.id]?.state ?? (await readTranscript(s.id))?.state] as const),
  );
  transcriptStates = Object.fromEntries(entries);
}

async function refresh(): Promise<void> {
  activeId = await activeSessionId();
  sessions = await listSessions();
  await loadTranscriptStates();
  render();
  await updateUsage();
}

async function main(): Promise<void> {
  hydrateIcons();
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
  // Pick up a recording as soon as it finishes.
  chrome.storage.session.onChanged.addListener((changes) => {
    if (ACTIVE_KEY in changes || TRANSCRIPTS_KEY in changes) void refresh();
  });
}

void main();
