import { describe, expect, it } from "vitest";
import { cues, toSrt, toVtt } from "../src/lib/subtitles";
import type { TranscriptLine } from "../src/lib/transcript";

const lines: TranscriptLine[] = [
  { speaker: "them", startMs: 0, endMs: 2500, text: "Achchha to students, aaj BST padhenge.", name: "Prof. Mehta" },
  { speaker: "me", startMs: 3000, endMs: 3400, text: "Sir, <insertion> ka time?" },
  { speaker: "them", startMs: 2000, endMs: 6000, text: "Good question." },
  { speaker: "them", startMs: 3_725_042, endMs: 3_727_000, text: "  " },
];
const label = (l: TranscriptLine) => l.name ?? (l.speaker === "me" ? "Me" : "");
const text = (l: TranscriptLine) => l.text;

describe("cues", () => {
  it("drops empty lines, stretches short ones, and ends before the same stream's next line", () => {
    const c = cues(lines, label, text);
    expect(c).toHaveLength(3);
    expect(c[0]).toMatchObject({ startMs: 0, endMs: 2000, speaker: "Prof. Mehta" }); // next "them" line at 2000
    expect(c[1]).toMatchObject({ startMs: 3000, endMs: 4000, speaker: "Me" }); // stretched to 1 s
    expect(c[2]).toMatchObject({ startMs: 2000, endMs: 6000, speaker: "" });
  });
});

describe("toSrt", () => {
  it("numbers cues, uses commas in times, and prefixes speakers", () => {
    expect(toSrt(cues(lines, label, text))).toBe(
      "1\n00:00:00,000 --> 00:00:02,000\nProf. Mehta: Achchha to students, aaj BST padhenge.\n\n" +
        "2\n00:00:03,000 --> 00:00:04,000\nMe: Sir, <insertion> ka time?\n\n" +
        "3\n00:00:02,000 --> 00:00:06,000\nGood question.\n",
    );
  });

  it("writes hours", () => {
    expect(toSrt([{ startMs: 3_725_042, endMs: 3_727_000, speaker: "", text: "x" }])).toContain("01:02:05,042 --> 01:02:07,000");
  });
});

describe("toVtt", () => {
  it("starts with the header, uses dots, voice tags, and escapes markup", () => {
    const vtt = toVtt(cues(lines, label, text));
    expect(vtt.startsWith("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n<v Prof. Mehta>Achchha")).toBe(true);
    expect(vtt).toContain("<v Me>Sir, &lt;insertion&gt; ka time?");
    expect(vtt).toContain("00:00:02.000 --> 00:00:06.000\nGood question.\n");
  });
});
