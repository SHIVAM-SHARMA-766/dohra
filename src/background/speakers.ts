// The meeting's speaker timeline for the recording in progress: reports from the
// meeting page (content/meeting-speakers.ts), stamped with recorded time so they
// line up with the transcript, and saved as speakers.json in the session folder.
// Kept in memory and written shortly after each change; read back from the file if
// the service worker restarts mid-recording.

import type { SpeakerEvent, SpeakerTimeline, SpeakingTile } from "../lib/meeting-speakers";
import { readSpeakers, writeSpeakers } from "../lib/transcript";

const WRITE_DELAY_MS = 1_000;

let current: { id: string; events: SpeakerEvent[] } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let writing: Promise<void> = Promise.resolve();

async function load(id: string): Promise<SpeakerEvent[]> {
  if (current?.id !== id) current = { id, events: (await readSpeakers(id))?.events ?? [] };
  return current.events;
}

export async function record(id: string, ms: number, speaking: SpeakingTile[], tiles: number): Promise<void> {
  const events = await load(id);
  events.push({ ms: Math.round(ms), speaking, tiles });
  clearTimeout(timer);
  timer = setTimeout(() => void flush(), WRITE_DELAY_MS);
}

/** Writes what is pending now; called when the recording stops, before the last transcript save. */
export async function flush(): Promise<void> {
  clearTimeout(timer);
  const snapshot = current;
  if (!snapshot || snapshot.events.length === 0) return;
  const timeline: SpeakerTimeline = { schema: 1, events: [...snapshot.events] };
  writing = writing.then(() => writeSpeakers(snapshot.id, timeline)).catch(() => {});
  await writing;
}
