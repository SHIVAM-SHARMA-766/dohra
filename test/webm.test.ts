import { describe, expect, it } from "vitest";
import { encodeSize, patchDuration, readDurationMs, WebmPatchError } from "../src/lib/webm";

const bytes = (...parts: (number[] | Uint8Array)[]) =>
  Uint8Array.from(parts.flatMap((p) => Array.from(p)));

function el(id: number[], data: Uint8Array | number[], size?: Uint8Array): Uint8Array {
  const body = Uint8Array.from(data);
  return bytes(id, size ?? encodeSize(body.length), body);
}

const UNKNOWN_SEGMENT_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const ebmlHeader = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], [...new TextEncoder().encode("webm")]));
const muxingApp = el([0x4d, 0x80], [...new TextEncoder().encode("Chrome")]);
const timecodeScale = el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]); // 1,000,000
const tracks = el([0x16, 0x54, 0xae, 0x6b], [0xae, 0x80]);
const cluster = bytes([0x1f, 0x43, 0xb6, 0x75], UNKNOWN_SEGMENT_SIZE, [0xe7, 0x81, 0x00]);

/** Shaped like Chrome's MediaRecorder output: unknown Segment size, Info without Duration. */
function mediaRecorderFile(): Uint8Array {
  const info = el([0x15, 0x49, 0xa9, 0x66], bytes(timecodeScale, muxingApp));
  return bytes(ebmlHeader, [0x18, 0x53, 0x80, 0x67], UNKNOWN_SEGMENT_SIZE, info, tracks, cluster);
}

function applyPatch(file: Uint8Array, durationMs: number): Uint8Array {
  const { head, consumed } = patchDuration(file, durationMs);
  return bytes(head, file.slice(consumed));
}

describe("encodeSize", () => {
  it("uses the smallest width, never the reserved all-ones value", () => {
    expect([...encodeSize(5)]).toEqual([0x85]);
    expect([...encodeSize(126)]).toEqual([0xfe]);
    expect([...encodeSize(127)]).toEqual([0x40, 0x7f]); // 0xff would mean "unknown"
  });

  it("keeps a requested minimum width", () => {
    expect([...encodeSize(5, 4)]).toEqual([0x10, 0x00, 0x00, 0x05]);
  });
});

describe("patchDuration", () => {
  it("adds a Duration to MediaRecorder-style output", () => {
    const file = mediaRecorderFile();
    expect(readDurationMs(file)).toBeNull();

    const patched = applyPatch(file, 3_723_456);
    expect(readDurationMs(patched)).toBeCloseTo(3_723_456, 3);
  });

  it("leaves everything after Info byte-identical", () => {
    const file = mediaRecorderFile();
    const patched = applyPatch(file, 1000);
    const tail = bytes(tracks, cluster);
    expect([...patched.slice(patched.length - tail.length)]).toEqual([...tail]);
    expect(patched.length).toBe(file.length + 11);
  });

  it("respects a non-default TimecodeScale", () => {
    const scale = el([0x2a, 0xd7, 0xb1], [0x00, 0x00, 0x03, 0xe8]); // 1000 ns per tick
    const info = el([0x15, 0x49, 0xa9, 0x66], bytes(scale, muxingApp));
    const file = bytes(ebmlHeader, [0x18, 0x53, 0x80, 0x67], UNKNOWN_SEGMENT_SIZE, info, tracks);
    expect(readDurationMs(applyPatch(file, 2500))).toBeCloseTo(2500, 6);
  });

  it("grows a known Segment size along with Info", () => {
    const info = el([0x15, 0x49, 0xa9, 0x66], bytes(timecodeScale, muxingApp));
    const body = bytes(info, tracks);
    const file = bytes(ebmlHeader, el([0x18, 0x53, 0x80, 0x67], body, encodeSize(body.length, 8)));

    const patched = applyPatch(file, 42);
    const sizeAt = ebmlHeader.length + 4;
    const segmentSize = patched.slice(sizeAt, sizeAt + 8).reduce((v, b, i) => (i === 0 ? b & 0 : v * 256 + b), 0);
    expect(segmentSize).toBe(body.length + 11);
    expect(readDurationMs(patched)).toBeCloseTo(42, 6);
  });

  it("overwrites an existing Duration in place", () => {
    const old = new Uint8Array(8);
    new DataView(old.buffer).setFloat64(0, 1);
    const info = el([0x15, 0x49, 0xa9, 0x66], bytes(timecodeScale, el([0x44, 0x89], old)));
    const file = bytes(ebmlHeader, [0x18, 0x53, 0x80, 0x67], UNKNOWN_SEGMENT_SIZE, info, tracks);

    const patched = applyPatch(file, 9999);
    expect(patched.length).toBe(file.length);
    expect(readDurationMs(patched)).toBeCloseTo(9999, 6);
  });

  it("widens the Info size field when the new size no longer fits", () => {
    const filler = el([0x4d, 0x80], new Uint8Array(110)); // Info body 116 + 11 > 126
    const info = el([0x15, 0x49, 0xa9, 0x66], bytes(timecodeScale, filler));
    expect(info[4]! & 0x80).toBe(0x80); // one-byte size before patching
    const file = bytes(ebmlHeader, [0x18, 0x53, 0x80, 0x67], UNKNOWN_SEGMENT_SIZE, info, tracks);

    const patched = applyPatch(file, 77);
    expect(patched.length).toBe(file.length + 12);
    expect(readDurationMs(patched)).toBeCloseTo(77, 6);
  });

  it("rejects input that is not WebM", () => {
    expect(() => patchDuration(new TextEncoder().encode("hello world"), 1)).toThrow(WebmPatchError);
  });

  it("rejects a head that stops inside Info", () => {
    const file = mediaRecorderFile();
    expect(() => patchDuration(file.slice(0, ebmlHeader.length + 14), 1)).toThrow(WebmPatchError);
  });
});
