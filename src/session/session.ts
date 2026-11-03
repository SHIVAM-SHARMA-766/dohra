// One recording: the player and its transcript. Clicking a line seeks to it; the
// line being played is highlighted and, with "Follow" on, kept in view. The
// transcript reloads as the companion adds lines, so a class still being
// transcribed can be read while it grows.

import { errorMessage, type Reply } from "../lib/messages";
import { formatBytes, formatDuration, mediaFileName, type SessionMeta } from "../lib/session";
import { getSession, recordingFile, StorageWorker } from "../lib/storage";
import {
  floatToPcm,
  lineAt,
  pcmToBase64,
  readTranscript,
  speakerLabel,
  TRANSCRIPTS_KEY,
  type CompanionInfo,
  type Transcript,
  type TranscriptLine,
  type TranscriptStatus,
} from "../lib/transcript";
import { hydrateIcons } from "../lib/icons";
import { hasDevanagari, searchKey, toRoman } from "../lib/translit";

const MODEL_LABEL: Record<string, string> = { small: "Small", medium: "Medium", large: "High" };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const id = new URLSearchParams(location.search).get("id") ?? "";
const media = $<HTMLVideoElement>("media");
const list = $<HTMLOListElement>("lines");
const search = $<HTMLInputElement>("search");
const follow = $<HTMLInputElement>("follow");

let meta: SessionMeta | null = null;
/** While this page decodes and sends a recording: the step and how far it got. */
let preparing: { text: string; fraction: number } | null = null;
let transcript: Transcript | null = null;
let status: TranscriptStatus | undefined;
let roman = false;
let rendered: { line: TranscriptLine; el: HTMLLIElement }[] = [];
let currentIndex = -1;
let lastUserScroll = 0;

function showNotice(text: string | null): void {
  $<HTMLElement>("notice").textContent = text ?? "";
  $<HTMLElement>("notice").hidden = !text;
}

async function request(msg: Record<string, unknown>): Promise<unknown> {
  const reply = (await chrome.runtime.sendMessage({ target: "background", ...msg })) as Reply;
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

// ---- transcript ---------------------------------------------------------------------

function displayText(line: TranscriptLine): string {
  return roman ? toRoman(line.text) : line.text;
}

function highlight(text: string, query: string): Node[] {
  if (!query) return [document.createTextNode(text)];
  const i = text.toLowerCase().indexOf(query);
  if (i < 0) return [document.createTextNode(text)];
  const mark = document.createElement("mark");
  mark.textContent = text.slice(i, i + query.length);
  return [document.createTextNode(text.slice(0, i)), mark, document.createTextNode(text.slice(i + query.length))];
}

function hue(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)!) % 360;
  return h;
}

function renderLines(): void {
  const lines = transcript?.lines ?? [];
  const query = search.value.trim().toLowerCase();
  rendered = [];
  const items: HTMLLIElement[] = [];
  for (const line of lines) {
    if (query && !searchKey(line.text).includes(query)) continue;
    const li = document.createElement("li");
    li.className = "line";
    li.tabIndex = 0;
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = formatDuration(line.startMs);
    const body = document.createElement("span");
    body.className = "body";
    const label = speakerLabel(line);
    if (label) {
      const speaker = document.createElement("span");
      speaker.className = `speaker ${line.speaker}${line.name ? " named" : ""}`;
      speaker.textContent = label;
      // Each person keeps one colour through the transcript.
      if (line.name) speaker.style.setProperty("--hue", String(hue(line.name)));
      body.append(speaker);
    }
    body.append(...highlight(displayText(line), query));
    li.append(time, body);
    const seek = () => {
      media.currentTime = line.startMs / 1000;
      void media.play();
    };
    li.addEventListener("click", seek);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter") seek();
    });
    items.push(li);
    rendered.push({ line, el: li });
  }
  list.replaceChildren(...items);
  if (query && items.length === 0 && lines.length > 0) {
    const none = document.createElement("li");
    none.className = "hint";
    none.style.padding = "8px 12px";
    none.textContent = "No lines match.";
    list.append(none);
  }
  currentIndex = -1;
  updateCurrent();

  $<HTMLElement>("script").hidden = !lines.some((l) => hasDevanagari(l.text));
  $<HTMLButtonElement>("download-txt").hidden = lines.length === 0;
}

function updateCurrent(): void {
  const index = lineAt(
    rendered.map((r) => r.line),
    media.currentTime * 1000,
  );
  if (index === currentIndex) return;
  rendered[currentIndex]?.el.classList.remove("current");
  currentIndex = index;
  const el = rendered[index]?.el;
  if (!el) return;
  el.classList.add("current");
  // Don't fight the user: follow only if they haven't scrolled in the last few seconds.
  if (follow.checked && !media.paused && Date.now() - lastUserScroll > 4000) {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

/** Shows the bar and percent, or hides them with a null fraction. */
function showProgress(fraction: number | null): void {
  const bar = $<HTMLProgressElement>("transcript-progress");
  const percent = $<HTMLElement>("transcript-percent");
  bar.hidden = percent.hidden = fraction === null;
  if (fraction === null) return;
  const f = Math.max(0, Math.min(1, fraction));
  bar.value = f;
  percent.textContent = `${Math.floor(f * 100)}%`;
}

function renderStatus(): void {
  const el = $<HTMLElement>("transcript-status");
  const empty = $<HTMLElement>("empty");
  const lines = transcript?.lines.length ?? 0;
  const state = status?.state ?? transcript?.state;
  const totalMs = meta?.durationMs || status?.receivedMs || 0;

  if (preparing) {
    el.textContent = preparing.text;
    showProgress(null);
  } else if (state === "live" || state === "transcribing") {
    const done = status?.doneMs ?? 0;
    const parts = [
      state === "live" ? "Recording and transcribing" : "Transcribing",
      ...(status && totalMs ? [`${formatDuration(done)} of ${formatDuration(totalMs)}`] : []),
      `${lines} lines so far`,
    ];
    el.textContent = parts.join(" · ");
    if (status?.error) el.textContent += ` (${status.error})`;
    // While recording, the end keeps moving: measure against what has arrived.
    const of = state === "live" ? status?.receivedMs || 0 : totalMs;
    showProgress(of > 0 ? Math.min(0.99, done / of) : 0);
  } else if (state === "failed") {
    el.textContent = `Transcription failed: ${status?.error ?? transcript?.error ?? "unknown error"}`;
    showProgress(null);
  } else if (transcript) {
    const lang = transcript.language === "hinglish" ? ", Hinglish" : transcript.language ? `, ${transcript.language}` : "";
    const model = MODEL_LABEL[transcript.model ?? ""] ?? transcript.model ?? "Whisper";
    el.textContent = `${lines} lines · ${model} model${lang}`;
    showProgress(null);
  } else {
    el.textContent = "";
    showProgress(null);
  }

  const showEmpty = lines === 0 && !preparing && state !== "live" && state !== "transcribing";
  empty.hidden = !showEmpty;
  if (showEmpty) void offerTranscription(state === "failed");
}

async function offerTranscription(failed: boolean): Promise<void> {
  const text = $<HTMLElement>("empty-text");
  const button = $<HTMLButtonElement>("transcribe");
  text.textContent = failed ? "No transcript was produced." : "This recording has no transcript yet.";
  button.textContent = failed ? "Try again" : "Transcribe this recording";
  try {
    const info = (await request({ type: "companion-status" })) as CompanionInfo;
    button.hidden = !info.ready || meta?.state !== "complete";
    if (!info.ready) text.textContent += ` ${info.problems[0] ?? ""}`;
  } catch (e) {
    button.hidden = true;
    text.textContent += ` ${errorMessage(e)}`;
  }
}

async function reloadTranscript(): Promise<void> {
  transcript = await readTranscript(id);
  const { [TRANSCRIPTS_KEY]: all } = await chrome.storage.session.get(TRANSCRIPTS_KEY);
  status = (all as Record<string, TranscriptStatus> | undefined)?.[id];
  renderLines();
  renderStatus();
}

// ---- transcribing a finished recording ------------------------------------------------

const BLOCK_SECONDS = 10;

/**
 * Decodes the recording to 16 kHz mono in the page and streams it to the companion.
 * Decoding a whole recording at once is memory-hungry (about 120 MB per hour of
 * audio, plus the file itself) but simple, and only this page pays for it.
 */
async function transcribeRecording(): Promise<void> {
  if (!meta) return;
  const button = $<HTMLButtonElement>("transcribe");
  button.disabled = true;
  const step = (text: string, fraction = 0) => {
    preparing = { text, fraction };
    renderStatus();
    showProgress(fraction);
  };
  try {
    step("Reading the audio… (keep this page open until the audio is sent)");
    const file = await recordingFile(id, mediaFileName(meta));
    // decodeAudioData returns the whole file whatever this length; it only must be valid.
    const length = Math.ceil((Math.max(meta.durationMs, 1000) / 1000 + 2) * 16000);
    const decoded = await new OfflineAudioContext(1, length, 16000).decodeAudioData(await file.arrayBuffer());
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c));
    if (meta.durationMs === 0) await completeMeta({ durationMs: Math.round(decoded.duration * 1000) });

    await request({ type: "transcribe-start", sessionId: id });
    // Mixed down to mono one block at a time, so the whole recording is not held twice.
    const block = BLOCK_SECONDS * 16000;
    const mono = new Float32Array(block);
    for (let start = 0; start < decoded.length; start += block) {
      const n = Math.min(block, decoded.length - start);
      mono.fill(0);
      for (const data of channels) {
        for (let i = 0; i < n; i++) mono[i]! += data[start + i]! / channels.length;
      }
      const pcm = floatToPcm(mono.subarray(0, n));
      await request({ type: "transcribe-audio", sessionId: id, pcm: pcmToBase64(pcm) });
      step("Sending the audio to the companion… (keep this page open)", (start + n) / decoded.length);
    }
    await request({ type: "transcribe-stop", sessionId: id });
    preparing = null;
    await reloadTranscript();
  } catch (e) {
    preparing = null;
    showNotice(`Could not transcribe: ${errorMessage(e)}`);
    renderStatus();
  } finally {
    button.disabled = false;
  }
}

function downloadText(): void {
  if (!transcript || !meta) return;
  const header = `${meta.title}\n${new Date(meta.startedAt).toLocaleString()}\n\n`;
  const body = transcript.lines
    .map((l) => {
      const label = speakerLabel(l);
      return `[${formatDuration(l.startMs)}] ${label ? `${label}: ` : ""}${displayText(l)}`;
    })
    .join("\n");
  const url = URL.createObjectURL(new Blob([header + body + "\n"], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${id}${roman ? "-roman" : ""}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---- page ---------------------------------------------------------------------------

function renderDetails(): void {
  if (!meta) return;
  const started = new Date(meta.startedAt);
  $<HTMLElement>("details").textContent = [
    started.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    formatDuration(meta.durationMs),
    formatBytes(meta.bytes),
    meta.mode === "audio" ? "audio" : `video ${meta.quality ?? ""}`.trim(),
  ].join(" · ");
}

/** Fills in what an import could not read up front: length and picture size. */
async function completeMeta(patch: Partial<SessionMeta>): Promise<void> {
  if (!meta) return;
  meta = { ...meta, ...patch };
  renderDetails();
  const worker = new StorageWorker();
  try {
    meta = await worker.call({ op: "update", sessionId: id, patch });
  } finally {
    worker.terminate();
  }
}

async function main(): Promise<void> {
  hydrateIcons();
  meta = await getSession(id);
  if (!meta) {
    $<HTMLElement>("title").textContent = "Recording not found";
    showNotice(`There is no recording "${id}" in this browser.`);
    return;
  }
  document.title = `${meta.title} — Dohra`;
  $<HTMLElement>("title").textContent = meta.title;
  renderDetails();

  if (meta.state === "complete") {
    media.classList.toggle("audio-only", meta.mode === "audio");
    media.addEventListener("loadedmetadata", () => {
      if (!meta || meta.durationMs > 0 || !Number.isFinite(media.duration)) return;
      void completeMeta({
        durationMs: Math.round(media.duration * 1000),
        ...(media.videoWidth > 0 ? { quality: `${media.videoWidth}x${media.videoHeight}`, mode: "video" as const } : {}),
      });
    });
    media.src = URL.createObjectURL(await recordingFile(id, mediaFileName(meta)));
  } else {
    showNotice("This recording is not finished yet. Open the Library to recover it.");
  }

  await reloadTranscript();

  media.addEventListener("timeupdate", updateCurrent);
  media.addEventListener("seeked", () => {
    lastUserScroll = 0;
    updateCurrent();
  });
  list.addEventListener("wheel", () => (lastUserScroll = Date.now()), { passive: true });
  list.addEventListener("touchmove", () => (lastUserScroll = Date.now()), { passive: true });
  search.addEventListener("input", renderLines);
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="script"]')) {
    radio.addEventListener("change", () => {
      roman = radio.value === "roman" && radio.checked;
      renderLines();
    });
  }
  $<HTMLButtonElement>("transcribe").addEventListener("click", () => void transcribeRecording());
  $<HTMLButtonElement>("download-txt").addEventListener("click", downloadText);
  chrome.storage.session.onChanged.addListener((changes) => {
    if (TRANSCRIPTS_KEY in changes) void reloadTranscript();
  });

  // Arriving from an import: start the transcript straight away.
  if (new URLSearchParams(location.search).get("transcribe") === "1") {
    history.replaceState(null, "", `session.html?id=${encodeURIComponent(id)}`);
    const state = status?.state ?? transcript?.state;
    if (!transcript?.lines.length && state !== "live" && state !== "transcribing") {
      const info = (await request({ type: "companion-status" })) as CompanionInfo;
      if (info.ready) await transcribeRecording();
    }
  }
}

void main().catch((e) => showNotice(errorMessage(e)));
