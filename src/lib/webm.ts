// Repairs the header of WebM files written by Chrome's MediaRecorder.
//
// 1. Duration. MediaRecorder streams WebM, so it never goes back to write how long the
//    recording was. Without a Duration, players show no length and Chrome cannot seek.
// 2. AlphaMode. Chrome marks VP8 tracks as carrying transparency (AlphaMode = 1) even
//    when they have none. Chrome ignores it, but GStreamer — and so GNOME Videos
//    (Totem) on Linux — routes the stream to an alpha decoder that fails with "Cannot
//    handle streams without an initial alpha buffer", reported to the user as a
//    missing codec.
//
// Both live in the first few hundred bytes (Segment → Info, Segment → Tracks), so this
// works on the start of the file; the caller copies the rest through unchanged.
//
// EBML basics: every element is [ID vint][size vint][data]. A vint's length is given by
// the position of its first set bit. A size whose value bits are all ones means
// "unknown", which is what a streaming muxer writes for the Segment.

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Cluster: 0x1f43b675,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  Video: 0xe0,
  AlphaMode: 0x53c0,
} as const;

const DEFAULT_TIMECODE_SCALE = 1_000_000; // nanoseconds per tick, i.e. 1 tick = 1 ms

export class WebmPatchError extends Error {}

interface Vint {
  value: bigint;
  length: number;
  unknown: boolean; // size vint with all value bits set
}

function readVint(buf: Uint8Array, pos: number, keepMarker: boolean): Vint {
  if (pos >= buf.length) throw new WebmPatchError("unexpected end of data");
  const first = buf[pos]!;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8) throw new WebmPatchError(`invalid vint at ${pos}`);
  if (pos + length > buf.length) throw new WebmPatchError("unexpected end of data");

  let value = BigInt(keepMarker ? first : first & (0xff >> length));
  for (let i = 1; i < length; i++) value = (value << 8n) | BigInt(buf[pos + i]!);
  const allOnes = (1n << BigInt(7 * length)) - 1n;
  return { value, length, unknown: !keepMarker && value === allOnes };
}

/** Encodes a size vint, using at least `minLength` bytes so existing layouts are kept. */
export function encodeSize(value: number, minLength = 1): Uint8Array {
  let length = Math.max(1, minLength);
  // All-ones is reserved for "unknown", hence the strict comparison.
  while (BigInt(value) >= (1n << BigInt(7 * length)) - 1n) length++;
  if (length > 8) throw new WebmPatchError("size too large");
  const out = new Uint8Array(length);
  let v = BigInt(value) | (1n << BigInt(7 * length));
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

interface Element {
  id: number;
  start: number; // offset of the ID
  sizeStart: number;
  sizeLength: number;
  dataStart: number;
  size: number | null; // null when unknown
}

function readElement(buf: Uint8Array, pos: number): Element {
  const id = readVint(buf, pos, true);
  const size = readVint(buf, pos + id.length, false);
  return {
    id: Number(id.value),
    start: pos,
    sizeStart: pos + id.length,
    sizeLength: size.length,
    dataStart: pos + id.length + size.length,
    size: size.unknown ? null : Number(size.value),
  };
}

function readUint(buf: Uint8Array, start: number, length: number): number {
  let v = 0;
  for (let i = 0; i < length; i++) v = v * 256 + buf[start + i]!;
  return v;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export interface PatchResult {
  /** Bytes that replace the first `consumed` bytes of the file. */
  head: Uint8Array;
  consumed: number;
}

/**
 * Patches the Duration into a WebM file, given its first bytes.
 *
 * `head` must contain the file up to the end of the Segment's Info element; 64 KiB is
 * far more than any MediaRecorder output needs. The returned head replaces the first
 * `consumed` bytes, and everything after that is copied unchanged.
 */
export function patchDuration(head: Uint8Array, durationMs: number): PatchResult {
  const ebml = readElement(head, 0);
  if (ebml.id !== ID.EBML || ebml.size === null) throw new WebmPatchError("not a WebM file");

  const segment = readElement(head, ebml.dataStart + ebml.size);
  if (segment.id !== ID.Segment) throw new WebmPatchError("Segment not found");

  // Find Info among the Segment's first children.
  let info: Element | null = null;
  let pos = segment.dataStart;
  while (pos < head.length) {
    const child = readElement(head, pos);
    if (child.id === ID.Info) {
      info = child;
      break;
    }
    if (child.id === ID.Cluster || child.id === ID.Tracks || child.size === null) break;
    pos = child.dataStart + child.size;
  }
  if (!info || info.size === null) throw new WebmPatchError("Info not found before media data");
  const infoEnd = info.dataStart + info.size;
  if (infoEnd > head.length) throw new WebmPatchError("Info extends past the bytes provided");

  let timecodeScale = DEFAULT_TIMECODE_SCALE;
  let existing: Element | null = null;
  for (let p = info.dataStart; p < infoEnd; ) {
    const child = readElement(head, p);
    if (child.size === null) throw new WebmPatchError("unknown-size element inside Info");
    if (child.id === ID.TimecodeScale) timecodeScale = readUint(head, child.dataStart, child.size);
    if (child.id === ID.Duration) existing = child;
    p = child.dataStart + child.size;
  }

  const ticks = (durationMs * 1_000_000) / timecodeScale;

  // A Duration already exists: overwrite its value in place, sizes unchanged.
  if (existing) {
    const out = head.slice(0, infoEnd);
    const view = new DataView(out.buffer);
    if (existing.size === 8) view.setFloat64(existing.dataStart, ticks);
    else if (existing.size === 4) view.setFloat32(existing.dataStart, ticks);
    else throw new WebmPatchError(`unexpected Duration size ${existing.size}`);
    return { head: out, consumed: infoEnd };
  }

  // Otherwise append a float64 Duration to Info, and grow every size that contains it.
  const duration = new Uint8Array(11);
  duration.set([0x44, 0x89, 0x88]); // ID, then size vint = 8
  new DataView(duration.buffer).setFloat64(3, ticks);

  const newInfoSize = encodeSize(info.size + duration.length, info.sizeLength);
  const grownBy = duration.length + newInfoSize.length - info.sizeLength;

  const segmentSize =
    segment.size === null
      ? head.slice(segment.sizeStart, segment.dataStart) // unknown size stays unknown
      : encodeSize(segment.size + grownBy, segment.sizeLength);

  return {
    head: concat([
      head.slice(0, segment.sizeStart),
      segmentSize,
      head.slice(segment.dataStart, info.sizeStart),
      newInfoSize,
      head.slice(info.dataStart, infoEnd),
      duration,
    ]),
    consumed: infoEnd,
  };
}

/** Zeroes every Tracks → TrackEntry → Video → AlphaMode in `buf[start, end)`, in place. */
function clearAlphaMode(buf: Uint8Array, start: number, end: number, depth = 0): number {
  let cleared = 0;
  for (let pos = start; pos < end; ) {
    const e = readElement(buf, pos);
    if (e.size === null) break;
    if (depth === 0 && e.id === ID.TrackEntry) cleared += clearAlphaMode(buf, e.dataStart, e.dataStart + e.size, 1);
    else if (depth === 1 && e.id === ID.Video) cleared += clearAlphaMode(buf, e.dataStart, e.dataStart + e.size, 2);
    else if (depth === 2 && e.id === ID.AlphaMode && buf.subarray(e.dataStart, e.dataStart + e.size).some((b) => b !== 0)) {
      buf.fill(0, e.dataStart, e.dataStart + e.size);
      cleared++;
    }
    pos = e.dataStart + e.size;
  }
  return cleared;
}

/**
 * Applies every header repair: Duration (see patchDuration) and AlphaMode. Same
 * contract as patchDuration — the returned head replaces the first `consumed` bytes.
 * `head` should hold the file up to the end of Tracks; if Tracks is cut off, only the
 * Duration is fixed.
 */
export function repairHeader(head: Uint8Array, durationMs: number): PatchResult & { alphaCleared: number } {
  const fixed = patchDuration(head, durationMs);

  // Tracks follows Info, possibly after other top-level elements (SeekHead, Void).
  for (let pos = fixed.consumed; pos < head.length; ) {
    let e: Element;
    try {
      e = readElement(head, pos);
    } catch {
      break;
    }
    if (e.id === ID.Cluster || e.size === null) break;
    const end = e.dataStart + e.size;
    if (end > head.length) break;
    if (e.id === ID.Tracks) {
      const rest = head.slice(fixed.consumed, end);
      const offset = e.dataStart - fixed.consumed;
      const alphaCleared = clearAlphaMode(rest, offset, offset + e.size);
      return { head: concat([fixed.head, rest]), consumed: end, alphaCleared };
    }
    pos = end;
  }
  return { ...fixed, alphaCleared: 0 };
}

/** Reads AlphaMode values back, one per video track. Used by tests. */
export function readAlphaModes(head: Uint8Array): number[] {
  const modes: number[] = [];
  const walk = (start: number, end: number, depth: number) => {
    for (let pos = start; pos < end; ) {
      const e = readElement(head, pos);
      if (e.size === null) return;
      const next = e.dataStart + e.size;
      if (depth === 0 && e.id === ID.Tracks) walk(e.dataStart, next, 1);
      else if (depth === 1 && e.id === ID.TrackEntry) walk(e.dataStart, next, 2);
      else if (depth === 2 && e.id === ID.Video) walk(e.dataStart, next, 3);
      else if (depth === 3 && e.id === ID.AlphaMode) modes.push(readUint(head, e.dataStart, e.size));
      if (depth === 0 && e.id === ID.Cluster) return;
      pos = next;
    }
  };
  const ebml = readElement(head, 0);
  const segment = readElement(head, ebml.dataStart + ebml.size!);
  walk(segment.dataStart, head.length, 0);
  return modes;
}

/** Reads the Duration back, in milliseconds. Used by tests and by verification. */
export function readDurationMs(head: Uint8Array): number | null {
  const ebml = readElement(head, 0);
  if (ebml.size === null) return null;
  const segment = readElement(head, ebml.dataStart + ebml.size);
  for (let pos = segment.dataStart; pos < head.length; ) {
    const child = readElement(head, pos);
    if (child.size === null) return null;
    if (child.id === ID.Info) {
      let scale = DEFAULT_TIMECODE_SCALE;
      let ticks: number | null = null;
      for (let p = child.dataStart; p < child.dataStart + child.size; ) {
        const e = readElement(head, p);
        const view = new DataView(head.buffer, head.byteOffset);
        if (e.id === ID.TimecodeScale) scale = readUint(head, e.dataStart, e.size!);
        if (e.id === ID.Duration)
          ticks = e.size === 8 ? view.getFloat64(e.dataStart) : view.getFloat32(e.dataStart);
        p = e.dataStart + e.size!;
      }
      return ticks === null ? null : (ticks * scale) / 1_000_000;
    }
    pos = child.dataStart + child.size;
  }
  return null;
}
