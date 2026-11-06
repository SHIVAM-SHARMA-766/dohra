import { describe, expect, it } from "vitest";
import { dropEchoes, isEcho } from "../src/lib/echo";
import type { TranscriptLine } from "../src/lib/transcript";

const them: TranscriptLine[] = [
  { speaker: "them", startMs: 10_000, endMs: 16_000, text: "Worst case tab aata hai jab tree skewed ho jaata hai." },
  { speaker: "them", startMs: 20_000, endMs: 24_000, text: "Ab BFS dekhte hain, queue use karke." },
];
const me = (startMs: number, endMs: number, text: string): TranscriptLine => ({ speaker: "me", startMs, endMs, text });

describe("isEcho", () => {
  it("catches the meeting's words picked up again by the microphone", () => {
    expect(isEcho(me(10_400, 15_800, "worst case tab aata hai jab tree skewed"), them)).toBe(true);
    // Chunked differently: slightly before the meeting's line, and partly misheard.
    expect(isEcho(me(9_000, 12_000, "Worst case tab ata hai"), them)).toBe(true);
  });

  it("keeps your own question, even in the middle of the teacher's sentence", () => {
    expect(isEcho(me(12_000, 14_000, "Sir, insertion ka time complexity kya hoga?"), them)).toBe(false);
  });

  it("keeps the same words said at another time", () => {
    expect(isEcho(me(40_000, 43_000, "worst case tab aata hai jab tree skewed"), them)).toBe(false);
  });

  it("keeps one-word replies", () => {
    expect(isEcho(me(21_000, 21_500, "BFS"), them)).toBe(false);
  });
});

describe("dropEchoes", () => {
  it("removes echoed microphone lines only", () => {
    const lines = [them[0]!, me(10_500, 15_500, "tab aata hai jab tree skewed ho jaata hai"), me(17_000, 18_000, "Sir, ek doubt hai"), them[1]!];
    expect(dropEchoes(lines).map((l) => l.text)).toEqual([them[0]!.text, "Sir, ek doubt hai", them[1]!.text]);
  });

  it("leaves a transcript without meeting lines alone", () => {
    const mixed: TranscriptLine[] = [{ speaker: "mixed", startMs: 0, endMs: 1000, text: "a b c" }];
    expect(dropEchoes(mixed)).toBe(mixed);
  });
});
