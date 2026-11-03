// Who is speaking in the meeting, read from the meeting page, so transcript lines
// can carry real names instead of "Them".
//
// Dohra records the meeting's mixed audio, which cannot tell voices apart; the
// meeting page can. Its tiles show a speaking indicator (Meet's sound bars, Teams'
// voice-level outline) that keeps changing while that person talks. The class names
// behind it are generated and change between versions, so instead of naming them,
// a tile counts as speaking while its subtree keeps changing: the indicator animates,
// a still video tile does not. Tiles are found through the attributes the meetings
// have kept stable: data-participant-id (Meet) and the voice-level outline (Teams).
//
// The pure parts (names, activity, matching lines) live here; the injected script
// (content/meeting-speakers.ts) does the DOM watching and reports changes.

import type { TranscriptLine } from "./transcript";

/** One person on the meeting's screen. */
export interface SpeakingTile {
  name: string;
  /** Your own tile: speaking there is you, already in the microphone's lines. */
  self: boolean;
}

/** Who was speaking from recording time `ms` until the next event. */
export interface SpeakerEvent {
  ms: number;
  speaking: SpeakingTile[];
  /** Participant tiles found on the page; 0 means Dohra could not read this meeting. */
  tiles: number;
}

/** speakers.json in a session folder. */
export interface SpeakerTimeline {
  schema: 1;
  events: SpeakerEvent[];
}

// ---- names ------------------------------------------------------------------------

// Words on tiles that are not names: icon-font ligatures (mic_off, more_vert) are
// filtered by shape below; these are the rest.
const NOT_NAMES = /^(you|me|presentation|presenting|pin|unpin|more options|mute|unmute|muted|host|guest|external|organi[sz]er|camera off|video off|speaking|\.\.\.)$/i;
const SELF = /\((you|me)\)|^(you|me)$/i;

/**
 * A display name from a tile's texts, in the order they appear: the first one that
 * reads like a name, with "(Presenting)", "(You)" and the like trimmed.
 */
export function pickName(texts: string[]): { name: string; self: boolean } | null {
  let self = false;
  for (const raw of texts) {
    const text = raw.replace(/\s+/g, " ").trim();
    if (SELF.test(text)) self = true;
    const name = text
      .replace(/\s*\([^)]*\)\s*/g, " ")
      .replace(/\s+is presenting$/i, "")
      .trim();
    if (name.length < 2 || name.length > 60) continue;
    if (/^[a-z_]+$/.test(name) && name.includes("_")) continue; // mic_off, more_vert
    if (/^[a-z]+$/.test(name) && name.length <= 12 && ICON_WORDS.has(name)) continue;
    if (NOT_NAMES.test(name) || /^\d+$/.test(name) || /^[\p{P}\p{S}\s]+$/u.test(name)) continue;
    return { name, self };
  }
  return null;
}

// Single-word icon ligatures Meet shows in tiles.
const ICON_WORDS = new Set(["mic", "keep", "close", "visibility", "fullscreen", "pip", "person", "check"]);

// ---- activity ---------------------------------------------------------------------

/** A tile counts as speaking while it changed at least this often in the last window. */
export const ACTIVITY_WINDOW_MS = 700;
export const ACTIVITY_MIN_CHANGES = 2;
/** How long a tile stays "speaking" after its indicator stops: bridges short gaps. */
export const SPEAKING_HOLD_MS = 600;

/**
 * Counts changes per tile and says who is speaking. Keys are whatever identifies a
 * tile to the caller (an element in the page, a string in tests).
 */
export class ActivityTracker<K> {
  private changes = new Map<K, number[]>();
  private lastSpeaking = new Map<K, number>();

  note(tile: K, at: number): void {
    const list = this.changes.get(tile) ?? [];
    list.push(at);
    this.changes.set(tile, list);
  }

  speaking(tiles: Iterable<K>, at: number): Set<K> {
    const out = new Set<K>();
    for (const tile of tiles) {
      const list = (this.changes.get(tile) ?? []).filter((t) => at - t <= ACTIVITY_WINDOW_MS);
      this.changes.set(tile, list);
      if (list.length >= ACTIVITY_MIN_CHANGES) this.lastSpeaking.set(tile, at);
      const last = this.lastSpeaking.get(tile);
      if (last !== undefined && at - last <= SPEAKING_HOLD_MS) out.add(tile);
    }
    return out;
  }
}

// ---- naming lines -----------------------------------------------------------------

/** Lines are matched to speakers with this much slack, for the transcript's timing. */
const LINE_SLACK_MS = 500;

/**
 * The name of whoever spoke most during each line, or undefined where nobody on the
 * meeting's screen was speaking. Lines from your microphone ("me") keep their label;
 * for the meeting's audio ("them") your own tile is ignored, since your voice is not
 * in it; a transcript made later from the mixed recording may name you "Me".
 */
export function nameLines(lines: TranscriptLine[], timeline: SpeakerEvent[]): (string | undefined)[] {
  const events = [...timeline].sort((a, b) => a.ms - b.ms);
  return lines.map((line) => {
    if (line.speaker === "me" || events.length === 0) return undefined;
    const from = line.startMs - LINE_SLACK_MS;
    const to = line.endMs + LINE_SLACK_MS;
    const total = new Map<string, number>();
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      const end = events[i + 1]?.ms ?? Math.max(e.ms, to);
      const overlap = Math.min(end, to) - Math.max(e.ms, from);
      if (overlap <= 0) continue;
      for (const s of e.speaking) {
        if (s.self && line.speaker === "them") continue;
        const key = s.self ? "Me" : s.name;
        total.set(key, (total.get(key) ?? 0) + overlap);
      }
    }
    let best: string | undefined;
    let most = 0;
    for (const [name, ms] of total) {
      if (ms > most) [best, most] = [name, ms];
    }
    return best;
  });
}

/** Whether two reports name the same people, so only changes are recorded. */
export function sameSpeakers(a: SpeakingTile[], b: SpeakingTile[]): boolean {
  if (a.length !== b.length) return false;
  const key = (s: SpeakingTile) => `${s.self ? 1 : 0}${s.name}`;
  const set = new Set(a.map(key));
  return b.every((s) => set.has(key(s)));
}
