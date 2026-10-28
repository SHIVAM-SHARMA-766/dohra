// Injected into the recorded tab when it is a meeting: reports whenever your
// microphone is muted or unmuted in the meeting. Injecting it again (a second
// recording in the same tab) only re-sends the current state.

import { meetingMicState } from "../lib/meeting-mic";

declare global {
  interface Window {
    __dohraMeetingMic?: () => void;
  }
}

function report(muted: boolean | null): void {
  chrome.runtime.sendMessage({ target: "background", type: "meeting-mic", muted }).catch(() => {});
}

if (window.__dohraMeetingMic) {
  window.__dohraMeetingMic();
} else {
  let last: boolean | null | undefined;
  const check = () => {
    const state = meetingMicState(document);
    if (state === last) return;
    last = state;
    report(state);
  };
  window.__dohraMeetingMic = () => report((last = meetingMicState(document)));
  new MutationObserver(check).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-label", "data-is-muted", "data-tooltip", "title", "aria-pressed"],
  });
  // Mutations cover nearly everything; the timer catches what they miss.
  setInterval(check, 1_000);
  check();
}
