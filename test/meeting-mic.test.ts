import { describe, expect, it } from "vitest";
import { isMeetingHost, micLabelState } from "../src/lib/meeting-mic";

describe("micLabelState", () => {
  it("reads muted from the meeting's own button", () => {
    for (const label of [
      "Turn on microphone (ctrl + d)", // Meet, muted
      "Unmute (Ctrl+Shift+M)", // Teams
      "unmute my microphone", // Zoom web
      "Unmute mic",
    ]) {
      expect(micLabelState(label), label).toBe(true);
    }
  });

  it("reads live from the opposite labels", () => {
    for (const label of ["Turn off microphone (ctrl + d)", "Mute (Ctrl+Shift+M)", "mute my microphone", "Mute mic"]) {
      expect(micLabelState(label), label).toBe(false);
    }
  });

  it("ignores controls for other people and unrelated buttons", () => {
    for (const label of [
      "Mute all",
      "Ask everyone to unmute",
      "Mute Asha's microphone",
      "Mute participants upon entry",
      "Turn off camera (ctrl + e)",
      "Present now",
      "",
    ]) {
      expect(micLabelState(label), label).toBeNull();
    }
  });
});

describe("isMeetingHost", () => {
  it("knows the meeting sites and nothing else", () => {
    for (const host of ["meet.google.com", "teams.microsoft.com", "teams.live.com", "app.zoom.us", "us02web.zoom.us", "acme.webex.com"]) {
      expect(isMeetingHost(host), host).toBe(true);
    }
    // A video player's "Mute" is not your microphone.
    for (const host of ["www.youtube.com", "zoom.us.example.com", "notmeet.google.com"]) {
      expect(isMeetingHost(host), host).toBe(false);
    }
  });
});
