import { describe, expect, it } from "vitest";
import { floatToPcm, lineAt, pcmToBase64, type TranscriptLine } from "../src/lib/transcript";

const line = (startMs: number): TranscriptLine => ({ speaker: "them", startMs, endMs: startMs + 1000, text: "" });

describe("lineAt", () => {
  const lines = [line(0), line(2000), line(5000)];

  it("finds the line that has started most recently", () => {
    expect(lineAt(lines, 0)).toBe(0);
    expect(lineAt(lines, 1999)).toBe(0);
    expect(lineAt(lines, 2000)).toBe(1);
    expect(lineAt(lines, 99_000)).toBe(2);
  });

  it("returns -1 before the first line", () => {
    expect(lineAt([line(500)], 100)).toBe(-1);
    expect(lineAt([], 100)).toBe(-1);
  });
});

describe("PCM encoding", () => {
  it("clamps and scales floats to int16", () => {
    expect([...floatToPcm(Float32Array.from([0, 1, -1, 2, -2, 0.5]))]).toEqual([0, 32767, -32768, 32767, -32768, 16383]);
  });

  it("encodes little-endian bytes as base64", () => {
    // 1 → 01 00, -1 → ff ff
    expect(pcmToBase64(Int16Array.from([1, -1]))).toBe(btoa("\x01\x00\xff\xff"));
  });

  it("handles buffers larger than one String.fromCharCode batch", () => {
    const big = new Int16Array(40_000).fill(257); // bytes 01 01
    expect(atob(pcmToBase64(big)).length).toBe(80_000);
  });
});
