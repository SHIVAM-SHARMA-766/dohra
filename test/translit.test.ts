import { describe, expect, it } from "vitest";
import { hasDevanagari, searchKey, toRoman } from "../src/lib/translit";

describe("toRoman", () => {
  it.each([
    ["आज", "aaj"],
    ["हम", "ham"],
    ["पढ़ेंगे", "padhenge"],
    ["नमस्ते", "namaste"],
    ["क्या", "kya"],
    ["समझना", "samajhna"],
    ["किताब", "kitaab"],
    ["ज़रूरी", "zaroori"],
    ["न", "na"],
    ["दो", "do"],
  ])("%s → %s", (input, expected) => {
    expect(toRoman(input)).toBe(expected);
  });

  it("uses spoken spellings for very common words", () => {
    expect(toRoman("यह क्लास में है")).toBe("yeh klaas mein hai");
  });

  it("leaves English and punctuation alone in mixed lines", () => {
    expect(toRoman("आज हम graphs पढ़ेंगे, okay?")).toBe("aaj ham graphs padhenge, okay?");
  });

  it("converts Devanagari digits and the danda", () => {
    expect(toRoman("२०२६ में।")).toBe("2026 mein.");
  });

  it("handles a nukta written as a separate mark", () => {
    expect(toRoman("ज़रूरी")).toBe("zaroori");
  });
});

describe("search helpers", () => {
  it("detects Devanagari", () => {
    expect(hasDevanagari("hello")).toBe(false);
    expect(hasDevanagari("hello दुनिया")).toBe(true);
  });

  it("lets a Roman query find a Devanagari line", () => {
    expect(searchKey("आज हम पढ़ेंगे")).toContain("padhenge");
    expect(searchKey("Graphs")).toBe("graphs");
  });
});
