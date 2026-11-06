// Without headphones, the microphone also hears the class from the speakers, so
// the meeting's words come back a second time as "me" lines. A "me" line is such an
// echo when it overlaps a "them" line in time and most of its words are in that
// line: your own question in the middle of the teacher's sentence shares few words
// with it.

import type { TranscriptLine } from "./transcript";

/** Slack around a "them" line: the two streams are chunked and timed separately. */
const OVERLAP_SLACK_MS = 1_500;
/** Share of a "me" line's words that must be in the overlapping "them" lines. */
const ECHO_SHARE = 0.6;
/** A single word ("haan", "ok") is too little to call an echo. */
const MIN_WORDS = 2;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Whether a "me" line repeats what the meeting said at the same time. */
export function isEcho(me: TranscriptLine, them: TranscriptLine[]): boolean {
  const mine = words(me.text);
  if (mine.length < MIN_WORDS) return false;
  const heard = new Set<string>();
  for (const t of them) {
    if (t.endMs + OVERLAP_SLACK_MS < me.startMs || t.startMs - OVERLAP_SLACK_MS > me.endMs) continue;
    for (const w of words(t.text)) heard.add(w);
  }
  if (heard.size === 0) return false;
  const shared = mine.filter((w) => heard.has(w)).length;
  return shared / mine.length >= ECHO_SHARE;
}

/** The transcript without "me" lines that echo the meeting. Other lines are kept as they are. */
export function dropEchoes(lines: TranscriptLine[]): TranscriptLine[] {
  const them = lines.filter((l) => l.speaker === "them");
  if (them.length === 0) return lines;
  return lines.filter((l) => l.speaker !== "me" || !isEcho(l, them));
}
