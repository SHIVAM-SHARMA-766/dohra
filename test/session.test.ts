import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, sessionId, slugify } from "../src/lib/session";
import { estimateBytesPerHour } from "../src/lib/settings";

describe("slugify", () => {
  it("makes folder-safe names", () => {
    expect(slugify("DSA Class #12: Graphs & Trees!")).toBe("dsa-class-12-graphs-trees");
    expect(slugify("  Café Résumé  ")).toBe("cafe-resume");
  });

  it("returns empty for scripts it cannot transliterate", () => {
    expect(slugify("डेटा संरचना")).toBe("");
  });

  it("truncates without leaving a trailing dash", () => {
    expect(slugify("a".repeat(39) + " bcd", 40)).toBe("a".repeat(39));
  });
});

describe("sessionId", () => {
  const at = new Date(2026, 9, 6, 19, 5, 9);

  it("starts with a sortable local timestamp", () => {
    expect(sessionId("DSA Class", at)).toBe("2026-10-06_190509_dsa-class");
  });

  it("falls back when the title has no usable characters", () => {
    expect(sessionId("डेटा संरचना", at)).toBe("2026-10-06_190509_session");
  });
});

describe("formatting", () => {
  it("formats durations", () => {
    expect(formatDuration(65_000)).toBe("01:05");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });

  it("estimates an hour of 720p at roughly half a gigabyte", () => {
    const gb = estimateBytesPerHour("video", "720p") / 1e9;
    expect(gb).toBeGreaterThan(0.5);
    expect(gb).toBeLessThan(0.6);
  });
});
