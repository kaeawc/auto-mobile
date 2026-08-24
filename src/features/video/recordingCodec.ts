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
 * Read only the `moov` box out of a recording file to determine its video
 * codec, seeking past the (potentially very large) `mdat` payload rather than
 * loading the whole file into memory. Both capture backends write
 * `-movflags +faststart`, so `moov` precedes `mdat`, but this walker does not
 * rely on that ordering — it scans top-level boxes until it finds `moov`.
 */
async function readRecordingVideoCodec(filePath: string): Promise<string | undefined> {
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
        return findVideoCodecInBoxes(moov, box.headerSize, available);
      }

      position += box.size;
    }
    return undefined;
  } finally {
    await handle.close();
  }
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
};
