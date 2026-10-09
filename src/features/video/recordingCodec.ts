import { promises as fsPromises } from "node:fs";
import { logger } from "../../utils/logger";

/**
 * Determines the *actual* video codec of a finalized recording file instead of
 * trusting a hard-coded constant. Both capture backends previously reported
 * `codec: "h264"` unconditionally, which mislabeled every iOS simulator
 * recording taken through the fast `-c copy` remux (simctl `recordVideo`
 * defaults to HEVC on modern hardware, and `-c copy` preserves it) — see
 * issue #4965. Narrowed to a single `codec()` method so the backends can be
 * unit-tested with a fake instead of a real file read.
 */
export interface RecordingCodecProbe {
  /**
   * Resolve the recording's video codec (e.g. `"h264"`, `"hevc"`), or
   * `undefined` when it cannot be determined. Callers surface `undefined` as
   * `"unknown"` rather than guessing, so a probe miss never re-introduces a
   * misleading label.
   */
  codec(filePath: string): Promise<string | undefined>;
  /**
   * Resolve the container duration (`mvhd`) of the recording in milliseconds,
   * or `undefined` when it cannot be read. Optional so codec-only fakes stay valid.
   */
  durationMs?(filePath: string): Promise<number | undefined>;
}

// ISO-BMFF (MP4/MOV) container boxes that nest the ones below them. We only ever
// descend into these on the way to `stsd`; everything else (notably the giant
// `mdat` payload) is skipped by its declared size without being read.
const CONTAINER_BOX_TYPES = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

// Sample-entry FourCCs → normalized codec name. `avc1`/`avc3` are H.264;
// `hvc1`/`hev1` are HEVC (H.265). Audio entries (e.g. `mp4a`) are absent on
// purpose so the walker keeps looking for the video track.
const FOURCC_TO_CODEC: Readonly<Record<string, string>> = {
  avc1: "h264",
  avc3: "h264",
  hvc1: "hevc",
  hev1: "hevc",
};

const BOX_HEADER_SIZE = 8;
const LARGE_BOX_HEADER_SIZE = 16;
// version(1) + flags(3) + entry_count(4) precede the sample entries in `stsd`.
const STSD_ENTRIES_OFFSET = 8;

interface BoxHeader {
  readonly size: number;
  readonly type: string;
  readonly headerSize: number;
}

/**
 * Decode the size/type header of a single ISO-BMFF box, resolving the 32-bit
 * size, the 64-bit `largesize` extension (`size === 1`), and the
 * extends-to-end sentinel (`size === 0`). Returns `undefined` when there are
 * not enough bytes for the header or the declared size cannot contain it.
 */
function readBoxHeader(
  view: Buffer,
  offset: number,
  available: number,
  remaining: number,
): BoxHeader | undefined {
  if (available < BOX_HEADER_SIZE) {
    return undefined;
  }
  let size = view.readUInt32BE(offset);
  const type = view.toString("latin1", offset + 4, offset + 8);
  let headerSize = BOX_HEADER_SIZE;

  if (size === 1) {
    // 64-bit `largesize` follows the type field.
    if (available < LARGE_BOX_HEADER_SIZE) {
      return undefined;
    }
    const high = view.readUInt32BE(offset + 8);
    const low = view.readUInt32BE(offset + 12);
    size = high * 2 ** 32 + low;
    headerSize = LARGE_BOX_HEADER_SIZE;
  } else if (size === 0) {
    // A declared size of 0 means "to the end of the enclosing box".
    size = remaining;
  }

  if (size < headerSize) {
    return undefined;
  }
  return { size, type, headerSize };
}

/**
 * Read the first recognized video-codec FourCC out of an in-memory ISO-BMFF
 * buffer. Pure and synchronous so it can be exercised with tiny synthetic
 * fixtures. Returns `undefined` when the buffer is not a recognizable container
 * or carries no known video sample entry.
 */
export function parseMp4VideoCodec(buffer: Buffer): string | undefined {
  return findVideoCodecInBoxes(buffer, 0, buffer.length);
}

function findVideoCodecInBoxes(buffer: Buffer, start: number, end: number): string | undefined {
  let offset = start;
  while (offset + BOX_HEADER_SIZE <= end) {
    const header = readBoxHeader(buffer, offset, end - offset, end - offset);
    if (!header || offset + header.size > end) {
      return undefined;
    }

    const payloadStart = offset + header.headerSize;
    const payloadEnd = offset + header.size;

    if (CONTAINER_BOX_TYPES.has(header.type)) {
      const found = findVideoCodecInBoxes(buffer, payloadStart, payloadEnd);
      if (found) {
        return found;
      }
    } else if (header.type === "stsd") {
      const found = parseSampleDescription(buffer, payloadStart, payloadEnd);
      if (found) {
        return found;
      }
    }

    offset += header.size;
  }
  return undefined;
}

function parseSampleDescription(buffer: Buffer, start: number, end: number): string | undefined {
  let offset = start + STSD_ENTRIES_OFFSET;
  while (offset + BOX_HEADER_SIZE <= end) {
    const entry = readBoxHeader(buffer, offset, end - offset, end - offset);
    if (!entry || offset + entry.size > end) {
      return undefined;
    }
    const codec = FOURCC_TO_CODEC[entry.type.toLowerCase()];
    if (codec) {
      return codec;
    }
    offset += entry.size;
  }
  return undefined;
}

/**
 * Read only the `moov` box out of a recording file, seeking past the
 * (potentially very large) `mdat` payload rather than loading the whole file
 * into memory. Both capture backends write `-movflags +faststart`, so `moov`
 * precedes `mdat`, but this walker does not rely on that ordering — it scans
 * top-level boxes until it finds `moov`. Returns the box and its header size.
 */
async function readMoovBox(
  filePath: string,
): Promise<{ moov: Buffer; headerSize: number } | undefined> {
  const handle = await fsPromises.open(filePath, "r");
  try {
    const { size: fileSize } = await handle.stat();
    const header = Buffer.alloc(LARGE_BOX_HEADER_SIZE);
    let position = 0;

    while (position + BOX_HEADER_SIZE <= fileSize) {
      const { bytesRead } = await handle.read(header, 0, LARGE_BOX_HEADER_SIZE, position);
      const box = readBoxHeader(header, 0, bytesRead, fileSize - position);
      if (!box) {
        return undefined;
      }

      if (box.type === "moov") {
        const available = Math.min(box.size, fileSize - position);
        const moov = Buffer.alloc(available);
        await handle.read(moov, 0, available, position);
        return { moov, headerSize: box.headerSize };
      }

      position += box.size;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

async function readRecordingVideoCodec(filePath: string): Promise<string | undefined> {
  const box = await readMoovBox(filePath);
  return box && findVideoCodecInBoxes(box.moov, box.headerSize, box.moov.length);
}

// mvhd payload: version(1) + flags(3), then creation/modification times
// (4 bytes each in v0, 8 in v1), timescale(4), duration (4 bytes in v0, 8 in v1).
const MVHD_FULLBOX_PREAMBLE = 4;

function readMvhdDurationMs(buffer: Buffer, start: number, end: number): number | undefined {
  const version = buffer[start];
  const timesSize = version === 1 ? 16 : 8;
  const timescaleAt = start + MVHD_FULLBOX_PREAMBLE + timesSize;
  const durationAt = timescaleAt + 4;
  const durationSize = version === 1 ? 8 : 4;
  if (durationAt + durationSize > end) {
    return undefined;
  }
  const timescale = buffer.readUInt32BE(timescaleAt);
  const duration =
    version === 1
      ? buffer.readUInt32BE(durationAt) * 2 ** 32 + buffer.readUInt32BE(durationAt + 4)
      : buffer.readUInt32BE(durationAt);
  if (timescale === 0) {
    return undefined;
  }
  return Math.round((duration / timescale) * 1000);
}

/**
 * Read the movie duration (`moov` > `mvhd`) of an in-memory ISO-BMFF buffer in
 * milliseconds. Header-only: no sample tables are walked. Returns `undefined`
 * when there is no `mvhd` or its timescale is zero.
 */
export function parseMp4DurationMs(buffer: Buffer): number | undefined {
  return findDurationInBoxes(buffer, 0, buffer.length);
}

function findDurationInBoxes(buffer: Buffer, start: number, end: number): number | undefined {
  let offset = start;
  while (offset + BOX_HEADER_SIZE <= end) {
    const header = readBoxHeader(buffer, offset, end - offset, end - offset);
    if (!header || offset + header.size > end) {
      return undefined;
    }
    const payloadStart = offset + header.headerSize;
    const payloadEnd = offset + header.size;
    if (header.type === "moov") {
      const found = findDurationInBoxes(buffer, payloadStart, payloadEnd);
      if (found !== undefined) {
        return found;
      }
    } else if (header.type === "mvhd") {
      return readMvhdDurationMs(buffer, payloadStart, payloadEnd);
    }
    offset += header.size;
  }
  return undefined;
}

async function readRecordingDurationMs(filePath: string): Promise<number | undefined> {
  const box = await readMoovBox(filePath);
  return box && findDurationInBoxes(box.moov, box.headerSize, box.moov.length);
}

/** Container duration via an optional probe capability; `undefined` when unsupported or unreadable. */
export function probeDurationMs(
  probe: RecordingCodecProbe,
  filePath: string,
): Promise<number | undefined> {
  return probe.durationMs?.(filePath) ?? Promise.resolve(undefined);
}

export const defaultRecordingCodecProbe: RecordingCodecProbe = {
  async codec(filePath: string): Promise<string | undefined> {
    try {
      return await readRecordingVideoCodec(filePath);
    } catch (error) {
      // Best-effort metadata: the recording itself is valid and already
      // persisted. A probe failure yields `undefined` (surfaced as "unknown"),
      // never a guessed codec. Warn so a systematic parse failure is visible.
      logger.warn(`[RecordingCodec] Failed to probe codec for ${filePath}: ${error}`, error);
      return undefined;
    }
  },
  async durationMs(filePath: string): Promise<number | undefined> {
    try {
      return await readRecordingDurationMs(filePath);
    } catch (error) {
      // Best-effort metadata, same contract as codec(): the recording is already
      // persisted, so a probe miss yields undefined rather than a guessed duration.
      logger.warn(`[RecordingCodec] Failed to probe duration for ${filePath}: ${error}`, error);
      return undefined;
    }
  },
};
