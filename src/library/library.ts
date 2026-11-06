// The library: lists recordings stored in the extension with their transcript state,
// opens them, exports them to Downloads, deletes them, and finalizes recordings
// that a crash left unfinished.

import { hydrateIcons, icon } from "../lib/icons";
import { ACTIVE_KEY, errorMessage, type ActiveRecording } from "../lib/messages";
import { EXPORT_DIR, FILES, formatBytes, formatDuration, mediaFileName, type SessionMeta } from "../lib/session";
import { deleteSession, importMedia, listSessions, recordingFile, StorageWorker } from "../lib/storage";
import { readBookmarks } from "../lib/bookmarks";
import { downloadsCopy } from "../lib/downloads";
import { matchSession, type SessionMatch } from "../lib/search";
import {
  readTranscript,
  speakerLabel,
  TRANSCRIPTS_KEY,
  type TranscriptLine,
  type TranscriptState,
  type TranscriptStatus,
} from "../lib/transcript";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const list = $<HTMLUListElement>("list");
const empty = $<HTMLElement>("empty");
const notice = $<HTMLParagraphElement>("notice");
const search = $<HTMLInputElement>("search");

let sessions: SessionMeta[] = [];
let activeId: string | null = null;
let transcriptStates: Record<string, TranscriptState | undefined> = {};
let transcriptStatuses: Record<string, TranscriptStatus> = {};
/** Every transcript's lines, for searching inside them. */
let transcriptLines: Record<string, TranscriptLine[]> = {};
let bookmarkCounts: Record<string, number> = {};

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
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  // With unlimitedStorage the quota follows the disk's free space.
  $<HTMLElement>("usage").textContent = `${formatBytes(usage)} used · ${formatBytes(Math.max(0, quota - usage))} free`;
}

// ---- actions ------------------------------------------------------------------------

/** Opens a recording, optionally playing from `atMs` with its transcript filtered by `query`. */
function open(s: SessionMeta, atMs?: number, query?: string): void {
  const params = new URLSearchParams({ id: s.id });
  if (atMs !== undefined) params.set("t", String(atMs));
  if (query) params.set("q", query);
  location.href = `session.html?${params}`;
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
  const recording = URL.createObjectURL(await recordingFile(s.id, mediaFileName(s)));
  const json = URL.createObjectURL(
    new Blob([JSON.stringify({ ...s, exportedAt }, null, 2) + "\n"], { type: "application/json" }),
  );
  try {
    await download(recording, `${EXPORT_DIR}/${s.id}/${mediaFileName(s)}`);
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

/**
 * Removes the video from the browser once its Downloads copy is verified, keeping
 * the transcript, bookmarks and details in the library.
 */
async function freeUpSpace(s: SessionMeta): Promise<void> {
  const copy = await downloadsCopy(s);
  if (!copy) {
    throw new Error(
      `No complete copy of "${s.title}" was found in Downloads/${EXPORT_DIR}/. Save it to Downloads first, then try again.`,
    );
  }
  const ok = confirm(
    `Remove the video of "${s.title}" from the browser, freeing ${formatBytes(s.bytes)}?\n\n` +
      `It stays in ${copy.filename}. The transcript and bookmarks stay in Dohra.`,
  );
  if (!ok) return;
  const worker = new StorageWorker();
  try {
    await worker.call({ op: "drop-media", sessionId: s.id });
  } finally {
    worker.terminate();
  }
}

async function showInDownloads(s: SessionMeta): Promise<void> {
  const copy = await downloadsCopy(s);
  if (!copy) throw new Error(`The video is no longer in Downloads/${EXPORT_DIR}/${s.id}/; it may have been moved or deleted.`);
  chrome.downloads.show(copy.id);
}

/** Copies a picked file into the library, then opens it and starts its transcript. */
async function importFile(file: File): Promise<void> {
  const box = $<HTMLElement>("import-progress");
  const bar = $<HTMLProgressElement>("import-bar");
  const button = $<HTMLButtonElement>("import");
  $<HTMLElement>("import-name").textContent = file.name;
  $<HTMLElement>("import-text").textContent = `Copying into Dohra… (${formatBytes(file.size)})`;
  bar.value = 0;
  box.hidden = false;
  button.disabled = true;
  showNotice(null);
  try {
    const meta = await importMedia(file, (f) => (bar.value = f));
    location.href = `session.html?id=${encodeURIComponent(meta.id)}&transcribe=1`;
  } catch (e) {
    box.hidden = true;
    showNotice(`Could not import ${file.name}: ${errorMessage(e)}`);
  } finally {
    button.disabled = false;
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
  if (s.browserCopyRemovedAt) return ["In Downloads only", "info"];
  if (s.endReason === "imported") return ["Imported", "info"];
  if (s.endReason === "tab-closed") return ["Tab closed", "warn"];
  return null;
}

/** The transcript lines that matched a search, under the recording's details. */
function renderMatches(s: SessionMeta, match: SessionMatch, query: string): HTMLElement {
  const box = el("ol", "matches");
  for (const { line } of match.lines) {
    const item = el("li");
    const row = el("button", "match");
    row.title = "Play from here";
    const label = speakerLabel(line);
    row.append(el("span", "match-time", formatDuration(line.startMs)), ...(label ? [el("span", "match-speaker", label)] : []));
    row.append(...highlighted(line.text, query));
    row.addEventListener("click", () => open(s, line.startMs, query));
    item.append(row);
    box.append(item);
  }
  if (match.total > match.lines.length) {
    const more = el("li");
    const link = el("button", "match more", `${match.total - match.lines.length} more in this transcript`);
    link.addEventListener("click", () => open(s, undefined, query));
    more.append(link);
    box.append(more);
  }
  return box;
}

/** Text with the query's first word marked. */
function highlighted(text: string, query: string): Node[] {
  const word = query.split(/\s+/)[0] ?? "";
  const i = word ? text.toLowerCase().indexOf(word) : -1;
  const body = el("span", "match-text");
  if (i < 0) {
    body.textContent = text;
    return [body];
  }
  body.append(text.slice(0, i), el("mark", undefined, text.slice(i, i + word.length)), text.slice(i + word.length));
  return [body];
}

function renderItem(s: SessionMeta, match?: SessionMatch, query = ""): HTMLLIElement {
  const li = el("li", "item");
  const inBrowser = !s.browserCopyRemovedAt;
  const playable = s.state === "complete" && inBrowser;

  const thumb = el("button", `thumb${playable ? "" : " muted"}`);
  thumb.append(icon(playable ? "play" : inBrowser ? "video" : "text"));
  thumb.title = playable ? "Open" : inBrowser ? s.title : "Open the transcript";
  thumb.disabled = s.state !== "complete";
  thumb.addEventListener("click", () => open(s));

  const info = el("div", "info");
  const title = el("div", "title", s.title);
  const label = stateLabel(s);
  if (label) title.append(el("span", `tag ${label[1]}`, label[0]));
  const tState = transcriptStates[s.id] ?? "none";
  const transcript = TRANSCRIPT_TAG[tState];
  if (transcript) {
    let text = transcript[0];
    const st = transcriptStatuses[s.id];
    if ((tState === "transcribing" || tState === "live") && st && s.durationMs > 0) {
      text += ` ${Math.min(99, Math.floor((100 * st.doneMs) / s.durationMs))}%`;
    }
    title.append(el("span", `tag ${transcript[1]}`, text));
  }
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
    ...(bookmarkCounts[s.id] ? [metaItem("bookmark", `${bookmarkCounts[s.id]} bookmarked`)] : []),
  );
  info.append(meta);
  if (s.error) info.append(el("div", "error-text", s.error));
  if (match && match.lines.length > 0) info.append(renderMatches(s, match, query));
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
    if (s.exportedAt) {
      actions.append(
        button("Free up space: keep the video only in Downloads", (b) => void run(() => freeUpSpace(s), b), {
          className: "ghost small",
          iconName: "disk",
          iconOnly: true,
        }),
      );
    }
  } else if (s.state === "complete") {
    actions.append(
      button("Open", () => open(s), { className: "primary small" }),
      button("Show in Downloads", (b) => void run(() => showInDownloads(s), b), {
        className: "ghost small",
        iconName: "folder",
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
  const items: HTMLLIElement[] = [];
  let lineHits = 0;
  for (const s of sessions) {
    if (!query) {
      items.push(renderItem(s));
      continue;
    }
    const match = matchSession(s.title, transcriptLines[s.id] ?? [], query);
    if (!match) continue;
    lineHits += match.total;
    items.push(renderItem(s, match, query));
  }
  list.replaceChildren(...items);
  empty.hidden = sessions.length > 0;
  $<HTMLElement>("count").textContent = query
    ? `${items.length} of ${sessions.length} recordings · ${lineHits} matching ${lineHits === 1 ? "line" : "lines"}`
    : sessions.length === 1
      ? "1 recording"
      : `${sessions.length} recordings`;
  if (sessions.length > 0 && items.length === 0) list.append(el("li", "hint", "Nothing matches, in titles or transcripts."));
}

async function loadTranscriptStates(): Promise<void> {
  const { [TRANSCRIPTS_KEY]: live } = await chrome.storage.session.get(TRANSCRIPTS_KEY);
  const statuses = (live as Record<string, TranscriptStatus> | undefined) ?? {};
  transcriptStatuses = statuses;
  const transcripts = await Promise.all(sessions.map(async (s) => [s.id, await readTranscript(s.id)] as const));
  transcriptStates = Object.fromEntries(transcripts.map(([id, t]) => [id, statuses[id]?.state ?? t?.state]));
  transcriptLines = Object.fromEntries(transcripts.map(([id, t]) => [id, t?.lines ?? []]));
  bookmarkCounts = Object.fromEntries(await Promise.all(sessions.map(async (s) => [s.id, (await readBookmarks(s.id)).length] as const)));
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
  // Before the slow part below, so a file picked while the list loads is not missed.
  const picker = $<HTMLInputElement>("import-file");
  $<HTMLButtonElement>("import").addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    picker.value = "";
    if (file) void importFile(file);
  });
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
