// Injected into the recorded tab when it is a meeting: reports who is speaking
// whenever that changes (see lib/meeting-speakers.ts for how it is read). Injecting
// it again (a second recording in the same tab) only re-sends the current state.

import { ActivityTracker, pickName, sameSpeakers, type SpeakingTile } from "../lib/meeting-speakers";

declare global {
  interface Window {
    __dohraMeetingSpeakers?: () => void;
  }
}

const SAMPLE_MS = 250;
// How far up from Teams' voice-level outline its tile's name can be.
const MAX_TILE_DEPTH = 8;

interface Tile {
  el: Element;
  name: string;
  self: boolean;
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width >= 40 && r.height >= 30;
}

/** Texts in an element, in page order, skipping hidden ones and very long runs. */
function texts(el: Element): string[] {
  const out: string[] = [];
  for (const attr of ["data-self-name", "aria-label"]) {
    const v = el.getAttribute(attr);
    if (v) out.push(attr === "aria-label" ? v.split(",")[0]! : v);
  }
  const preferred = el.querySelectorAll('[data-tid*="display-name"], [data-tid*="participant-name"], [data-self-name], .notranslate');
  for (const p of preferred) out.push(p.getAttribute("data-self-name") || p.textContent || "");
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && out.length < 40; n = walker.nextNode()) {
    const t = n.textContent?.trim();
    if (t && t.length <= 80 && n.parentElement?.closest("[aria-hidden='true']") === null) out.push(t);
  }
  return out;
}

function findTiles(): Tile[] {
  const tiles: Tile[] = [];
  const seen = new Set<Element>();
  const add = (el: Element) => {
    if (seen.has(el) || !visible(el)) return;
    // The participants panel lists everyone too; only the video grid shows speaking.
    if (el.closest('[role="list"], [role="listitem"], [role="dialog"]')) return;
    const picked = pickName(texts(el));
    if (!picked) return;
    seen.add(el);
    tiles.push({ el, ...picked });
  };

  // Meet: one element per participant tile; keep the outermost.
  for (const el of document.querySelectorAll("[data-participant-id]")) {
    if (el.parentElement?.closest("[data-participant-id]")) continue;
    add(el);
  }
  // Teams: the voice-level outline sits in each tile; the tile is the nearest
  // ancestor that also holds a name.
  for (const outline of document.querySelectorAll('[data-tid="voice-level-stream-outline"]')) {
    let el: Element | null = outline.parentElement;
    for (let depth = 0; el && depth < MAX_TILE_DEPTH; depth++, el = el.parentElement) {
      if (pickName(texts(el))) {
        add(el);
        break;
      }
    }
  }
  return tiles;
}

function report(speaking: SpeakingTile[], tiles: number): void {
  chrome.runtime.sendMessage({ target: "background", type: "meeting-speakers", speaking, tiles }).catch(() => {});
}

if (window.__dohraMeetingSpeakers) {
  window.__dohraMeetingSpeakers();
} else {
  const tracker = new ActivityTracker<Element>();
  let tiles: Tile[] = [];
  let last: SpeakingTile[] = [];
  let lastCount = -1;

  // Attribute changes inside a tile are its indicator moving (or a hover: rare,
  // brief, and below the threshold).
  new MutationObserver((records) => {
    const now = performance.now();
    const touched = new Set<Element>();
    for (const r of records) {
      const target = r.target instanceof Element ? r.target : r.target.parentElement;
      if (!target) continue;
      for (const t of tiles) {
        if (t.el.contains(target)) touched.add(t.el);
      }
    }
    for (const el of touched) tracker.note(el, now);
  }).observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style"],
  });

  const sample = () => {
    tiles = findTiles();
    const active = tracker.speaking(
      tiles.map((t) => t.el),
      performance.now(),
    );
    const speaking = tiles.filter((t) => active.has(t.el)).map(({ name, self }) => ({ name, self }));
    if (sameSpeakers(speaking, last) && tiles.length === lastCount) return;
    last = speaking;
    lastCount = tiles.length;
    report(speaking, tiles.length);
  };
  window.__dohraMeetingSpeakers = () => report(last, lastCount < 0 ? 0 : lastCount);
  setInterval(sample, SAMPLE_MS);
  sample();
}
