/**
 * Decoder for the iOS screen-capture-helper wire protocol.
 *
 * Header (24 bytes, little-endian UInt32):
 *   magic(4) | headerChecksum(4) | width(4) | height(4) | bytesPerRow(4) | timestampMs(4)
 *
 * Followed by `height * bytesPerRow` bytes of BGRA pixel data. Audio records
 * reserve width=0: height=8000, bytesPerRow=1, timestampMs=payload length,
 * followed by 8 kHz mono PCM16LE bytes.
 *
 * `magic` is a fixed sync marker ("AMF1" on the wire) and `headerChecksum` is a
 * CRC-32 (IEEE) over the 16 field bytes that follow it. Together they make frame
 * boundaries self-describing (issue #4270): a corrupt or lost stretch of stream
 * is recovered by scanning forward to the next marker whose checksum validates —
 * deterministically, not by inferring boundaries from structural plausibility.
 *
 * Scope of the guarantee: the marker + checksum defeat *random* corruption (the
 * real-world case: a dropped/duplicated pipe chunk) with certainty, and make an
 * accidental false-lock on payload bytes ~2^-64. CRC-32 is not a MAC, so an
 * attacker who controls the captured pixels can still embed a valid header in
 * the payload — closing that needs a keyed digest and a shared secret, which is
 * out of scope here (issue #4270 tracks the format-level follow-up).
 */

/** Sync marker as a little-endian UInt32; on the wire the bytes read "AMF1". */
export const FRAME_MAGIC = 0x3146_4d41;
/** The marker bytes as they appear on the wire (little-endian of FRAME_MAGIC). */
const FRAME_MAGIC_BYTES = Buffer.from([0x41, 0x4d, 0x46, 0x31]);
/** magic(4) + checksum(4) + width(4) + height(4) + bytesPerRow(4) + timestampMs(4). */
export const FRAME_HEADER_SIZE = 24;
/** The checksum covers the field bytes from here to the end of the header. */
const HEADER_FIELDS_OFFSET = 8;

/**
 * Structural bounds used to sanity-check an already-checksum-validated header.
 * A valid checksum means the encoder really wrote these values, so these bounds
 * only guard against an encoder bug (or an astronomically unlikely CRC
 * collision) producing an absurd allocation.
 */
/** Largest plausible display dimension, in pixels. */
const MAX_FRAME_DIMENSION = 16_384;
/**
 * Largest row padding accepted beyond the visible `width * 4` BGRA bytes.
 * `CVPixelBufferGetBytesPerRow` aligns rows to a small boundary (real captures
 * observed at exactly `width * 4`), so a full page of slack is generous.
 */
const MAX_ROW_PADDING_BYTES = 4096;
/** Largest plausible single-frame pixel payload (256 MiB). */
const MAX_FRAME_PAYLOAD_BYTES = 256 * 1024 * 1024;
/** Largest plausible audio record (16 MiB ≈ 17 minutes of 8 kHz PCM16LE). */
const MAX_AUDIO_PAYLOAD_BYTES = 16 * 1024 * 1024;

export interface FrameHeader {
  width: number;
  height: number;
  bytesPerRow: number;
  timestampMs: number;
}

export interface DecodedFrame {
  header: FrameHeader;
  pixels: Buffer;
}

export interface DecodedAudio {
  pcm16le: Buffer;
}

type MalformedFrameReason =
  | "header_magic_mismatch"
  | "header_checksum_mismatch"
  | "header_width_zero"
  | "header_height_zero"
  | "header_bytes_per_row_too_small"
  | "header_bytes_per_row_too_large"
  | "header_dimensions_out_of_range"
  | "header_payload_too_large"
  | "audio_payload_too_large";

export interface MalformedFrameError {
  reason: MalformedFrameReason;
  header: FrameHeader;
}

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private pendingHeader: FrameHeader | null = null;
  /**
   * True while the decoder has lost frame alignment and is scanning for the next
   * valid marker. Malformed callbacks are suppressed in this state so one
   * corruption episode produces one report, not one per discarded byte.
   */
  private resynchronizing: boolean = false;

  /**
   * Append bytes from the helper's stdout stream and return any frames that have
   * completed. A malformed header is surfaced via `onMalformed` exactly once per
   * corruption episode; the decoder then discards bytes until it finds the next
   * marker whose checksum validates and resumes decoding there.
   */
  push(
    chunk: Buffer,
    onMalformed?: (error: MalformedFrameError) => void,
    onAudio?: (audio: DecodedAudio) => void
  ): DecodedFrame[] {
    if (chunk.length > 0) {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    }

    const frames: DecodedFrame[] = [];

    while (true) {
      if (this.resynchronizing && !this.resynchronize()) {break;}

      if (this.pendingHeader === null) {
        const outcome = this.takeHeader(onMalformed);
        if (outcome === "starved") {break;}
        if (outcome === "malformed") {continue;}
        this.pendingHeader = outcome;
      }

      const pending = this.pendingHeader;
      const expected = payloadSize(pending);
      if (this.buffer.length < expected) {break;}

      // Copy pixels to release the underlying chunk allocation; otherwise
      // every emitted frame pins the entire upstream buffer in memory.
      const payload = Buffer.from(this.buffer.subarray(0, expected));
      this.buffer = this.buffer.subarray(expected);
      if (isAudioHeader(pending)) {
        onAudio?.({ pcm16le: payload });
      } else {
        frames.push({ header: pending, pixels: payload });
      }
      this.pendingHeader = null;
    }

    return frames;
  }

  /**
   * Consume the next header from the front of the buffer. When the front 24
   * bytes are not a valid marker+checksum (or carry implausible fields), the
   * bytes are left in place — the forward scan steps past them itself — and the
   * corruption is reported once as the decoder switches to resynchronizing.
   */
  private takeHeader(
    onMalformed?: (error: MalformedFrameError) => void
  ): FrameHeader | "starved" | "malformed" {
    if (this.buffer.length < FRAME_HEADER_SIZE) {return "starved";}
    const reason = headerErrorAt(this.buffer, 0);
    if (reason) {
      this.resynchronizing = true;
      onMalformed?.({ reason, header: parseFields(this.buffer, 0) });
      return "malformed";
    }
    const header = parseFields(this.buffer, 0);
    this.buffer = this.buffer.subarray(FRAME_HEADER_SIZE);
    return header;
  }

  /**
   * Scan forward for the next valid frame marker. Returns true when alignment is
   * recovered (the buffer now starts at that header), false when the buffered
   * bytes do not yet contain a validating marker — in which case bytes that can
   * no longer begin one are discarded and the scan resumes on the next chunk.
   *
   * Uses `Buffer.indexOf` to jump between marker candidates, then validates each
   * with its checksum + field bounds. Unlike a marker-less format, this needs no
   * successor-corroboration: the checksum is the corroboration, so a recovered
   * frame is accepted on its own merits (and never dropped just because another
   * corrupt header follows it).
   */
  private resynchronize(): boolean {
    let searchFrom = 0;
    while (searchFrom <= this.buffer.length - FRAME_MAGIC_BYTES.length) {
      const index = this.buffer.indexOf(FRAME_MAGIC_BYTES, searchFrom);
      if (index < 0) {break;}
      if (index + FRAME_HEADER_SIZE > this.buffer.length) {
        // Marker present but the full header has not arrived yet: keep from here
        // and wait for more bytes before validating.
        this.trimTo(index);
        return false;
      }
      if (headerErrorAt(this.buffer, index) === null) {
        this.trimTo(index);
        this.resynchronizing = false;
        return true;
      }
      searchFrom = index + 1;
    }
    // No validating marker in what has arrived. Keep only a possible marker
    // prefix straddling the chunk boundary; discard the rest so the retained
    // buffer never grows without bound during sustained garbage.
    this.trimTo(Math.max(0, this.buffer.length - (FRAME_MAGIC_BYTES.length - 1)));
    return false;
  }

  /** Drop `offset` leading bytes, copying so the discarded allocation is freed. */
  private trimTo(offset: number): void {
    if (offset > 0) {
      this.buffer = Buffer.from(this.buffer.subarray(offset));
    }
  }
}

function isAudioHeader(header: FrameHeader): boolean {
  return header.width === 0 && header.height === 8_000 && header.bytesPerRow === 1;
}

function payloadSize(header: FrameHeader): number {
  return isAudioHeader(header)
    ? header.timestampMs
    : header.height * header.bytesPerRow;
}

function parseFields(buffer: Buffer, offset: number): FrameHeader {
  return {
    width: buffer.readUInt32LE(offset + 8),
    height: buffer.readUInt32LE(offset + 12),
    bytesPerRow: buffer.readUInt32LE(offset + 16),
    timestampMs: buffer.readUInt32LE(offset + 20),
  };
}

/**
 * Returns why the 24 bytes at `offset` are not a usable header, or null. Assumes
 * the caller has ensured `offset + FRAME_HEADER_SIZE <= buffer.length`. Checks
 * the marker and checksum first (a mismatch there means these bytes are not a
 * header at all), then the field bounds.
 */
function headerErrorAt(buffer: Buffer, offset: number): MalformedFrameReason | null {
  if (buffer.readUInt32LE(offset) !== FRAME_MAGIC) {return "header_magic_mismatch";}
  const stored = buffer.readUInt32LE(offset + 4);
  if (stored !== crc32(buffer.subarray(offset + HEADER_FIELDS_OFFSET, offset + FRAME_HEADER_SIZE))) {
    return "header_checksum_mismatch";
  }
  return fieldBoundsError(parseFields(buffer, offset));
}

/** Returns why an already-checksum-valid header's fields are implausible, or null. */
function fieldBoundsError(header: FrameHeader): MalformedFrameReason | null {
  if (isAudioHeader(header)) {
    return header.timestampMs > MAX_AUDIO_PAYLOAD_BYTES ? "audio_payload_too_large" : null;
  }
  if (header.width === 0) {return "header_width_zero";}
  if (header.height === 0) {return "header_height_zero";}
  // BGRA is 4 bytes per pixel; bytesPerRow may include padding but must fit
  // at least the visible pixels.
  if (header.bytesPerRow < header.width * 4) {return "header_bytes_per_row_too_small";}
  if (header.width > MAX_FRAME_DIMENSION || header.height > MAX_FRAME_DIMENSION) {
    return "header_dimensions_out_of_range";
  }
  if (header.bytesPerRow > header.width * 4 + MAX_ROW_PADDING_BYTES) {
    return "header_bytes_per_row_too_large";
  }
  if (header.height * header.bytesPerRow > MAX_FRAME_PAYLOAD_BYTES) {
    return "header_payload_too_large";
  }
  return null;
}

/**
 * Encode a frame header (marker + checksum + fields). Mirrors
 * `FrameProtocol.encodeHeader` in the Swift helper; the two must agree byte for
 * byte, which the shared CRC-32 check vector pins on both sides.
 */
export function encodeFrameHeader(header: FrameHeader): Buffer {
  const buffer = Buffer.alloc(FRAME_HEADER_SIZE);
  buffer.writeUInt32LE(FRAME_MAGIC, 0);
  buffer.writeUInt32LE(header.width >>> 0, 8);
  buffer.writeUInt32LE(header.height >>> 0, 12);
  buffer.writeUInt32LE(header.bytesPerRow >>> 0, 16);
  buffer.writeUInt32LE(header.timestampMs >>> 0, 20);
  buffer.writeUInt32LE(crc32(buffer.subarray(HEADER_FIELDS_OFFSET, FRAME_HEADER_SIZE)), 4);
  return buffer;
}

const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

/**
 * CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320) — the standard CRC used
 * by zip/gzip/PNG. Implemented here because no CRC-32 primitive is shared across
 * the TypeScript and Swift runtimes (Swift Foundation has none), and both sides
 * must produce identical checksums for the marker to validate.
 */
export function crc32(data: Buffer): number {
  let crc = 0xffff_ffff;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}
