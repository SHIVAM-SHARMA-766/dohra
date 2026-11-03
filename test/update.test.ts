import { describe, expect, it } from "vitest";
import { newer } from "../src/lib/update";

describe("newer", () => {
  it("compares numerically, part by part", () => {
    expect(newer("0.6.1", "0.6.0")).toBe(true);
    expect(newer("0.10.0", "0.9.2")).toBe(true);
    expect(newer("1.0.0", "0.99.99")).toBe(true);
    expect(newer("v0.7.0", "0.6.0")).toBe(true);
  });

  it("is false for the same or an older version", () => {
    expect(newer("0.6.0", "0.6.0")).toBe(false);
    expect(newer("0.5.9", "0.6.0")).toBe(false);
  });

  it("never replaces a build from source", () => {
    expect(newer("0.7.0", "dev")).toBe(false);
    expect(newer("dev", "0.1.0")).toBe(false);
    expect(newer("0.7", "0.6.0")).toBe(false);
  });
});
