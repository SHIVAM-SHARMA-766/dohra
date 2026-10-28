// Reading the meeting's own microphone button, so Dohra stops recording your
// microphone while you are muted in the meeting.
//
// Dohra captures the microphone itself, not through the meeting, so the meeting's
// mute does not reach it. The meeting page says the state in its mic button's label:
// "Turn on microphone" (Meet), "Unmute" (Teams), "unmute my microphone" (Zoom) mean
// muted; their opposites mean live. Labels are read only on meeting sites: elsewhere
// "Mute" is a video player's sound button, not a microphone.

const MEETING_HOSTS = [
  /^meet\.google\.com$/,
  /^teams\.microsoft\.com$/,
  /^teams\.live\.com$/,
  /^teams\.cloud\.microsoft$/,
  /(^|\.)zoom\.us$/,
  /(^|\.)webex\.com$/,
];

export function isMeetingHost(hostname: string): boolean {
  return MEETING_HOSTS.some((re) => re.test(hostname));
}

/** What a control's label says about your microphone: muted (true), live (false), or nothing (null). */
export function micLabelState(label: string): boolean | null {
  const l = label.toLowerCase().replace(/\s+/g, " ").trim();
  if (!l) return null;
  // Controls for other people: "Mute all", "Mute Asha's microphone", "Ask everyone to unmute".
  if (/\b(all|everyone|others|participants?|attendees?)\b|['’]s\b/.test(l)) return null;
  if (/\b(turn on|unmute|enable)\b.*\b(microphone|mic|audio)\b/.test(l) || /^unmute\b/.test(l)) return true;
  if (/\b(turn off|mute|disable)\b.*\b(microphone|mic|audio)\b/.test(l) || /^mute\b/.test(l)) return false;
  return null;
}

/** Your microphone's state as the meeting page shows it, or null if it cannot tell. */
export function meetingMicState(doc: Document): boolean | null {
  // Meet marks its own buttons with data-is-muted; the label says which is the mic.
  for (const el of doc.querySelectorAll<HTMLElement>("[data-is-muted]")) {
    const label = el.getAttribute("aria-label") ?? "";
    if (/microphone|\bmic\b/i.test(label) && !/['’]s\b|\b(all|everyone)\b/i.test(label)) {
      return el.getAttribute("data-is-muted") === "true";
    }
  }
  for (const el of doc.querySelectorAll<HTMLElement>('button, [role="button"]')) {
    if (el.getClientRects().length === 0) continue; // not shown
    const label = el.getAttribute("aria-label") || el.getAttribute("data-tooltip") || el.getAttribute("title") || "";
    const state = micLabelState(label);
    if (state !== null) return state;
  }
  return null;
}
