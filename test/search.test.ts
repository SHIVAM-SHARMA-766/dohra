import { describe, expect, it } from "vitest";
import { matchSession } from "../src/lib/search";
import type { TranscriptLine } from "../src/lib/transcript";

const lines: TranscriptLine[] = [
  { speaker: "them", startMs: 0, endMs: 2000, text: "Aaj ham BFS padhenge.", name: "Prof. Mehta" },
  { speaker: "me", startMs: 3000, endMs: 4000, text: "Sir, BFS mein queue kyun?" },
  { speaker: "them", startMs: 5000, endMs: 6000, text: "Queue level by level chalti hai.", name: "Prof. Mehta" },
  { speaker: "them", startMs: 7000, endMs: 8000, text: "हम कल DFS पढ़ेंगे।" },
];

describe("matchSession", () => {
  it("finds lines of the transcript, up to a few, and counts them all", () => {
    const m = matchSession("DSA class", lines, "bfs", 1);
    expect(m?.title).toBe(false);
    expect(m?.total).toBe(2);
    expect(m?.lines.map((l) => l.line.startMs)).toEqual([0]);
  });

  it("needs every word, in any order, within one line", () => {
    expect(matchSession("DSA", lines, "queue bfs")?.lines.map((l) => l.line.startMs)).toEqual([3000]);
    expect(matchSession("DSA", lines, "bfs level")).toBeNull();
  });

  it("matches Devanagari lines with a Roman query", () => {
    expect(matchSession("DSA", lines, "padhenge")?.lines.map((l) => l.line.startMs)).toEqual([0, 7000]);
  });

  it("matches the speaker's name", () => {
    expect(matchSession("DSA", lines, "mehta queue")?.lines.map((l) => l.line.startMs)).toEqual([5000]);
  });

  it("matches titles, with or without a transcript", () => {
    expect(matchSession("DSA class — Graphs", [], "graphs")).toEqual({ title: true, lines: [], total: 0 });
    expect(matchSession("Physics", [], "graphs")).toBeNull();
    expect(matchSession("Physics", lines, "   ")).toBeNull();
  });
});
