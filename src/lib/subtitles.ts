// Transcripts as subtitles, so a recording plays with captions in VLC, mpv or any
// player that reads a .srt or .vtt beside the video. Speakers' names go in front of
// the text in SRT, and in WebVTT's voice tag (<v Name>), which players show or style.

import type { TranscriptLine } from "./transcript";

/** A cue shorter than this is stretched, so it stays on screen long enough to read. */
const MIN_CUE_MS = 1_000;

export interface Cue {
  startMs: number;
  endMs: number;
  speaker: string; // "" when unknown
  text: string;
}

/**
 * Cues from transcript lines: empty lines dropped, each ending before the next line
 * by the same stream starts, and lasting at least MIN_CUE_MS.
 */
export function cues(lines: TranscriptLine[], label: (l: TranscriptLine) => string, text: (l: TranscriptLine) => string): Cue[] {
  const kept = lines.filter((l) => text(l).trim() !== "");
  return kept.map((l, i) => {
    const next = kept.slice(i + 1).find((n) => n.speaker === l.speaker);
    let endMs = Math.max(l.endMs, l.startMs + MIN_CUE_MS);
    if (next && next.startMs > l.startMs) endMs = Math.min(endMs, next.startMs);
    return { startMs: l.startMs, endMs, speaker: label(l), text: text(l).trim() };
  });
}

function stamp(ms: number, sep: "," | "."): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor(t / 60_000) % 60;
  const s = Math.floor(t / 1000) % 60;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(t % 1000, 3)}`;
}

export function toSrt(list: Cue[]): string {
  return list
    .map((c, i) => `${i + 1}\n${stamp(c.startMs, ",")} --> ${stamp(c.endMs, ",")}\n${c.speaker ? `${c.speaker}: ` : ""}${c.text}\n`)
    .join("\n");
}

/** WebVTT text must not contain "-->" or start a tag with "<". */
function escapeVtt(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function toVtt(list: Cue[]): string {
  const body = list
    .map((c) => {
      const voice = c.speaker ? `<v ${escapeVtt(c.speaker)}>` : "";
      return `${stamp(c.startMs, ".")} --> ${stamp(c.endMs, ".")}\n${voice}${escapeVtt(c.text)}\n`;
    })
    .join("\n");
  return `WEBVTT\n\n${body}`;
}
