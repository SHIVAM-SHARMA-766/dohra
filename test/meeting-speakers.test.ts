import { describe, expect, it } from "vitest";
import {
  ACTIVITY_WINDOW_MS,
  ActivityTracker,
  nameLines,
  pickName,
  sameSpeakers,
  SPEAKING_HOLD_MS,
  type SpeakerEvent,
} from "../src/lib/meeting-speakers";
import type { TranscriptLine } from "../src/lib/transcript";

describe("pickName", () => {
  it("takes the first text that reads like a name", () => {
    expect(pickName(["more_vert", "mic_off", "Asha Verma", "Asha Verma"])).toEqual({ name: "Asha Verma", self: false });
    expect(pickName(["keep", "Rahul K"])).toEqual({ name: "Rahul K", self: false });
  });

  it("trims what meetings add to a name", () => {
    expect(pickName(["Neha (Presenting)"])).toEqual({ name: "Neha", self: false });
    expect(pickName(["Ravi is presenting"])).toEqual({ name: "Ravi", self: false });
    expect(pickName(["Prof. Gupta (Host)"])).toEqual({ name: "Prof. Gupta", self: false });
  });

  it("marks your own tile", () => {
    expect(pickName(["Shivam Sharma (You)"])).toEqual({ name: "Shivam Sharma", self: true });
    expect(pickName(["You", "Shivam Sharma"])).toEqual({ name: "Shivam Sharma", self: true });
  });

  it("finds nothing in a tile without a name", () => {
    expect(pickName(["more_vert", "Presentation", "12", "…", ""])).toBeNull();
    expect(pickName([])).toBeNull();
  });

  it("keeps names in other scripts", () => {
    expect(pickName(["अमित शर्मा"])).toEqual({ name: "अमित शर्मा", self: false });
  });
});

describe("ActivityTracker", () => {
  it("counts a tile as speaking while its indicator keeps changing", () => {
    const t = new ActivityTracker<string>();
    for (let at = 0; at <= 1000; at += 100) t.note("asha", at);
    t.note("rahul", 500); // one hover
    expect([...t.speaking(["asha", "rahul"], 1000)]).toEqual(["asha"]);
  });

  it("holds briefly after the indicator stops, then lets go", () => {
    const t = new ActivityTracker<string>();
    // Sampled every 250 ms, as the meeting page does; the indicator moves until 1000.
    const heard: number[] = [];
    for (let at = 0; at <= 3000; at += 50) {
      if (at <= 1000) t.note("asha", at);
      if (at % 250 === 0 && t.speaking(["asha"], at).has("asha")) heard.push(at);
    }
    const last = heard[heard.length - 1]!;
    expect(heard[0]).toBe(0 + 250); // two changes needed first
    expect(last).toBeGreaterThan(1000);
    expect(last).toBeLessThanOrEqual(1000 + ACTIVITY_WINDOW_MS + SPEAKING_HOLD_MS);
  });
});

const line = (speaker: TranscriptLine["speaker"], startMs: number, endMs: number): TranscriptLine => ({
  speaker,
  startMs,
  endMs,
  text: "…",
});

const asha = { name: "Asha", self: false };
const rahul = { name: "Rahul", self: false };
const me = { name: "Shivam", self: true };

describe("nameLines", () => {
  const timeline: SpeakerEvent[] = [
    { ms: 0, speaking: [], tiles: 3 },
    { ms: 1000, speaking: [asha], tiles: 3 },
    { ms: 6000, speaking: [], tiles: 3 },
    { ms: 7000, speaking: [rahul], tiles: 3 },
    { ms: 9000, speaking: [rahul, asha], tiles: 3 },
    { ms: 9500, speaking: [rahul], tiles: 3 },
    { ms: 12000, speaking: [me], tiles: 3 },
    { ms: 14000, speaking: [], tiles: 3 },
  ];

  it("names each line after whoever spoke most during it", () => {
    expect(nameLines([line("them", 1200, 5800), line("them", 7100, 11800)], timeline)).toEqual(["Asha", "Rahul"]);
  });

  it("leaves lines without a speaker on screen unnamed", () => {
    expect(nameLines([line("them", 20000, 22000)], timeline)).toEqual([undefined]);
  });

  it("never names microphone lines, and skips your tile for the meeting's audio", () => {
    expect(nameLines([line("me", 1200, 5800), line("them", 12600, 13400)], timeline)).toEqual([undefined, undefined]);
  });

  it("calls you Me in a transcript of the mixed recording", () => {
    expect(nameLines([line("mixed", 12200, 13800), line("mixed", 1200, 5800)], timeline)).toEqual(["Me", "Asha"]);
  });

  it("does nothing without a timeline", () => {
    expect(nameLines([line("them", 0, 1000)], [])).toEqual([undefined]);
  });
});

describe("sameSpeakers", () => {
  it("ignores order but not who", () => {
    expect(sameSpeakers([asha, rahul], [rahul, asha])).toBe(true);
    expect(sameSpeakers([asha], [rahul])).toBe(false);
    expect(sameSpeakers([], [])).toBe(true);
    expect(sameSpeakers([me], [{ ...me, self: false }])).toBe(false);
  });
});
