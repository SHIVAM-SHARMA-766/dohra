import { describe, expect, it } from "vitest";
import { copiesKept, recordingTimeLeft, roughDuration } from "../src/lib/disk";

const GB = 1e9;
const HOUR = 3_600_000;

describe("recordingTimeLeft", () => {
  it("divides the free space by what an hour takes, per copy kept", () => {
    expect(recordingTimeLeft(12 * GB, 1.2 * GB, 1)).toBeCloseTo(10 * HOUR);
    expect(recordingTimeLeft(12 * GB, 1.2 * GB, 2)).toBeCloseTo(5 * HOUR);
  });

  it("never goes below zero, and is unlimited without a rate", () => {
    expect(recordingTimeLeft(-5, 1.2 * GB, 1)).toBe(0);
    expect(recordingTimeLeft(GB, 0, 1)).toBe(Infinity);
  });
});

describe("copiesKept", () => {
  it("counts the Downloads copy only when the browser keeps one too", () => {
    expect(copiesKept({ autoExport: true, keepInBrowser: true })).toBe(2);
    expect(copiesKept({ autoExport: true, keepInBrowser: false })).toBe(1);
    expect(copiesKept({ autoExport: false, keepInBrowser: true })).toBe(1);
  });
});

describe("roughDuration", () => {
  it("reads like a person would say it", () => {
    expect(roughDuration(70 * 60_000)).toBe("1 h 10 min");
    expect(roughDuration(25 * 60_000)).toBe("25 min");
    expect(roughDuration(2 * HOUR)).toBe("2 h");
    expect(roughDuration(5_000)).toBe("1 min");
  });
});
