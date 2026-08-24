/**
 * Decoder for the iOS screen-capture-helper wire protocol.
 *
 * Header (24 bytes, little-endian UInt32):
 *   magic(4) | headerChecksum(4) | width(4) | height(4) | bytesPerRow(4) | timestampMs(4)
 *
 * Followed by `height * bytesPerRow` bytes of BGRA pixel data. Audio records
 * reserve width=0: height=8000, bytesPerRow=1, timestampMs=payload length,
 * followed by 8 kHz mono PCM16LE bytes. Encoded-video records (issue #4787) also
 * reserve width=0, with a distinct `height` sentinel — see
 * `ENCODED_VIDEO_HEIGHT_BASE` below.
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

import { BufferQueue } from "../../utils/BufferQueue";

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
/**
 * Largest raw frame retained by the Node handoff. 32 MiB covers current iPhone
 * and iPad BGRA captures while keeping one incomplete frame bounded.
 */
export const MAX_RAW_FRAME_BYTES = 32 * 1024 * 1024;
/** Largest plausible audio record (16 MiB ≈ 17 minutes of 8 kHz PCM16LE). */
const MAX_AUDIO_PAYLOAD_BYTES = 16 * 1024 * 1024;
/**
 * Largest plausible encoded-video record. A single H.264 access unit (even a
 * high-resolution keyframe) is far smaller than a raw BGRA frame; 16 MiB is
 * generous headroom while keeping one buffered record bounded.
 */
const MAX_ENCODED_VIDEO_PAYLOAD_BYTES = 16 * 1024 * 1024;

/**
 * Encoded-video discriminator (issue #4787). The header carries no type field;
 * raw frames and audio are told apart by reserved sentinels in the geometry
 * fields (audio = `width=0, height=8000, bytesPerRow=1`). An encoded-video record
 * reuses `width=0` (a real raw frame always has `width>=1`, so the raw decoder
 * already rejects `width=0`) and puts a reserved constant in `height` whose top
 * 31 bits are fixed and whose low bit carries the keyframe flag:
 *
 *     width       = 0                                  (never a raw frame)
 *     height      = ENCODED_VIDEO_HEIGHT_BASE | keyframeBit
 *     bytesPerRow = encoded H.264 payload length in bytes
 *     timestampMs = presentation timestamp (ms) from the CMSampleBuffer PTS
 *
 * `ENCODED_VIDEO_HEIGHT_BASE` (0xE2640000, mnemonic "E2 64" ≈ encoded H.264) can
 * never equal the audio sentinel's `height` of 8000, so an encoded record is
 * unambiguous against both raw frames (width!=0) and audio (height!=8000). The
 * CRC-32 header checksum still covers all 16 field bytes, so a corrupt encoded
 * header fails validation and drives resync exactly like a raw or audio header.
 */
export const ENCODED_VIDEO_HEIGHT_BASE = 0xe264_0000;
/** All bits of `height` except the low keyframe-flag bit. */
export const ENCODED_VIDEO_HEIGHT_MASK = 0xffff_fffe;
/** Low bit of the encoded-video `height` sentinel: set on keyframes. */
const ENCODED_VIDEO_KEYFRAME_BIT = 0x0000_0001;

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

/**
 * An in-helper-encoded H.264 access unit (issue #4787). Surfaced distinctly from
 * raw BGRA frames and audio. `presentationTimestampMs` is the CMSampleBuffer PTS
 * (not helper wall-clock) so downstream RTP timing is driven by capture time.
 */
export interface DecodedEncodedVideo {
  keyframe: boolean;
  presentationTimestampMs: number;
  payload: Buffer;
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
  | "audio_payload_too_large"
  | "encoded_video_payload_too_large";

export interface MalformedFrameError {
  reason: MalformedFrameReason;
  header: FrameHeader;
}

export class FrameDecoder {
  private readonly buffer = new BufferQueue();
  private pendingHeader: FrameHeader | null = null;
  private highWaterMarkBytes = 0;
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
    onAudio?: (audio: DecodedAudio) => void,
    onFrame?: (frame: DecodedFrame) => void,
    onEncodedVideo?: (video: DecodedEncodedVideo) => void,
  ): DecodedFrame[] {
    const frames: DecodedFrame[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      // Do not retain more than one valid raw frame plus its header, even when
      // a synthetic or unusually coalesced stdout chunk carries many frames.
      const available = FRAME_HEADER_SIZE + MAX_RAW_FRAME_BYTES - this.buffer.length;
      if (available === 0) {
        // Backstop against an unbounded buffer. A corrupt or oversized frame does
        // NOT reach here: `fieldBoundsError` caps a validated payload at
        // MAX_RAW_FRAME_BYTES, and `resynchronize` compacts garbage that carries
        // no validating marker — so every full-buffer state drains, leaving this
        // throw an infinite-loop guard rather than a real teardown path (#4772).
        if (!this.decodeAvailable(frames, onMalformed, onAudio, onFrame, onEncodedVideo)) {
          throw new Error(
            "FrameDecoder reached its raw-frame buffer limit without a complete frame",
          );
        }
        continue;
      }
      const end = Math.min(chunk.length, offset + available);
      this.buffer.append(chunk.subarray(offset, end));
      this.highWaterMarkBytes = Math.max(this.highWaterMarkBytes, this.buffer.length);
      offset = end;
      this.decodeAvailable(frames, onMalformed, onAudio, onFrame, onEncodedVideo);
    }
    return frames;
  }

  getMetrics(): FrameDecoderMetrics {
    return {
      bufferedBytes: this.buffer.length,
      highWaterMarkBytes: this.highWaterMarkBytes,
      maxBufferedBytes: FRAME_HEADER_SIZE + MAX_RAW_FRAME_BYTES,
    };
  }

  private decodeAvailable(
    frames: DecodedFrame[],
    onMalformed?: (error: MalformedFrameError) => void,
    onAudio?: (audio: DecodedAudio) => void,
    onFrame?: (frame: DecodedFrame) => void,
    onEncodedVideo?: (video: DecodedEncodedVideo) => void,
  ): boolean {
    let madeProgress = false;
    while (true) {
      if (this.resynchronizing && !this.resynchronize()) {
        return madeProgress;
      }

      if (this.pendingHeader === null) {
        const outcome = this.takeHeader(onMalformed);
        if (outcome === "starved") {
          return madeProgress;
        }
        if (outcome === "malformed") {
          madeProgress = true;
          continue;
        }
        this.pendingHeader = outcome;
        madeProgress = true;
      }

      const pending = this.pendingHeader;
      const expected = payloadSize(pending);
      if (this.buffer.length < expected) {
        return madeProgress;
      }

      // A single copy detaches the emitted frame from stdout chunks. The queue
      // avoids the former concatenate-on-every-chunk behavior while retaining
      // no more than this one completed payload.
      const payload = this.buffer.takeDetached(expected);
      this.emitRecord(pending, payload, frames, onAudio, onFrame, onEncodedVideo);
      this.pendingHeader = null;
      madeProgress = true;
    }
  }

  /** Route a completed payload to the callback for its record kind. */
  private emitRecord(
    header: FrameHeader,
    payload: Buffer,
    frames: DecodedFrame[],
    onAudio?: (audio: DecodedAudio) => void,
    onFrame?: (frame: DecodedFrame) => void,
    onEncodedVideo?: (video: DecodedEncodedVideo) => void,
  ): void {
    if (isAudioHeader(header)) {
      onAudio?.({ pcm16le: payload });
      return;
    }
    if (isEncodedVideoHeader(header)) {
      onEncodedVideo?.({
        keyframe: (header.height & ENCODED_VIDEO_KEYFRAME_BIT) !== 0,
        presentationTimestampMs: header.timestampMs,
        payload,
      });
      return;
    }
    const frame = { header, pixels: payload };
    if (onFrame) {
      onFrame(frame);
    } else {
      frames.push(frame);
    }
  }

  /**
   * Consume the next header from the front of the buffer. When the front 24
   * bytes are not a valid marker+checksum (or carry implausible fields), the
   * bytes are left in place — the forward scan steps past them itself — and the
   * corruption is reported once as the decoder switches to resynchronizing.
   */
  private takeHeader(
    onMalformed?: (error: MalformedFrameError) => void,
  ): FrameHeader | "starved" | "malformed" {
    if (this.buffer.length < FRAME_HEADER_SIZE) {
      return "starved";
    }
    const bytes = this.buffer.peek(FRAME_HEADER_SIZE);
    const reason = headerErrorAt(bytes, 0);
    if (reason) {
      this.resynchronizing = true;
      onMalformed?.({ reason, header: parseFields(bytes, 0) });
      return "malformed";
    }
    const header = parseFields(bytes, 0);
    this.buffer.discard(FRAME_HEADER_SIZE);
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
    const buffer = this.buffer.toBuffer();
    let searchFrom = 0;
    while (searchFrom <= buffer.length - FRAME_MAGIC_BYTES.length) {
      const index = buffer.indexOf(FRAME_MAGIC_BYTES, searchFrom);
      if (index < 0) {
        break;
      }
      if (index + FRAME_HEADER_SIZE > buffer.length) {
        // Marker present but the full header has not arrived yet: keep from here
        // and wait for more bytes before validating.
        this.replaceBuffer(buffer.subarray(index));
        return false;
      }
      if (headerErrorAt(buffer, index) === null) {
        this.replaceBuffer(buffer.subarray(index));
        this.resynchronizing = false;
        return true;
      }
      searchFrom = index + 1;
    }
    // No validating marker in what has arrived. Keep only a possible marker
    // prefix straddling the chunk boundary; discard the rest so the retained
    // buffer never grows without bound during sustained garbage.
    this.replaceBuffer(
      buffer.subarray(Math.max(0, buffer.length - (FRAME_MAGIC_BYTES.length - 1))),
    );
    return false;
  }

  /** Compact retained corrupt-stream bytes so discarded chunks can be released. */
  private replaceBuffer(bytes: Buffer): void {
    this.buffer.replace(bytes.length === 0 ? Buffer.alloc(0) : Buffer.from(bytes));
  }
}

export interface FrameDecoderMetrics {
  bufferedBytes: number;
  highWaterMarkBytes: number;
  maxBufferedBytes: number;
}

function isAudioHeader(header: FrameHeader): boolean {
  return header.width === 0 && header.height === 8_000 && header.bytesPerRow === 1;
}

/**
 * True when the header is an encoded-video record (issue #4787): `width=0` (never
 * a raw frame) and `height` masked to its reserved sentinel base. Cannot collide
 * with the audio sentinel because `ENCODED_VIDEO_HEIGHT_BASE` (0xE2640000) is not
 * 8000, so audio and encoded records are mutually exclusive.
 */
function isEncodedVideoHeader(header: FrameHeader): boolean {
  // `& ` yields a signed int32 in JS; `>>> 0` coerces back to the unsigned value
  // so the high-bit sentinel base (0xE2640000) compares equal.
  return (
    header.width === 0 &&
    (header.height & ENCODED_VIDEO_HEIGHT_MASK) >>> 0 === ENCODED_VIDEO_HEIGHT_BASE
  );
}

function payloadSize(header: FrameHeader): number {
  if (isAudioHeader(header)) {
    return header.timestampMs;
  }
  if (isEncodedVideoHeader(header)) {
    return header.bytesPerRow;
  }
  return header.height * header.bytesPerRow;
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
  if (buffer.readUInt32LE(offset) !== FRAME_MAGIC) {
    return "header_magic_mismatch";
  }
  const stored = buffer.readUInt32LE(offset + 4);
  if (
    stored !== crc32(buffer.subarray(offset + HEADER_FIELDS_OFFSET, offset + FRAME_HEADER_SIZE))
  ) {
    return "header_checksum_mismatch";
  }
  return fieldBoundsError(parseFields(buffer, offset));
}

/** Returns why an already-checksum-valid header's fields are implausible, or null. */
function fieldBoundsError(header: FrameHeader): MalformedFrameReason | null {
  if (isAudioHeader(header)) {
    return header.timestampMs > MAX_AUDIO_PAYLOAD_BYTES ? "audio_payload_too_large" : null;
  }
  // Encoded video is checked before the `width===0` raw rejection: it too
  // reserves `width===0`, so it must be classified before that guard fires.
  if (isEncodedVideoHeader(header)) {
    return header.bytesPerRow > MAX_ENCODED_VIDEO_PAYLOAD_BYTES
      ? "encoded_video_payload_too_large"
      : null;
  }
  if (header.width === 0) {
    return "header_width_zero";
  }
  if (header.height === 0) {
    return "header_height_zero";
  }
  // BGRA is 4 bytes per pixel; bytesPerRow may include padding but must fit
  // at least the visible pixels.
  if (header.bytesPerRow < header.width * 4) {
    return "header_bytes_per_row_too_small";
  }
  if (header.width > MAX_FRAME_DIMENSION || header.height > MAX_FRAME_DIMENSION) {
    return "header_dimensions_out_of_range";
  }
  if (header.bytesPerRow > header.width * 4 + MAX_ROW_PADDING_BYTES) {
    return "header_bytes_per_row_too_large";
  }
  if (header.height * header.bytesPerRow > MAX_RAW_FRAME_BYTES) {
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

export interface EncodedVideoHeaderFields {
  payloadLength: number;
  keyframe: boolean;
  presentationTimestampMs: number;
}

/**
 * Encode an encoded-video record header (issue #4787). Mirrors
 * `FrameProtocol.encodeEncodedVideoHeader` in the Swift helper; the shared golden
 * vectors pin the two byte for byte. See `ENCODED_VIDEO_HEIGHT_BASE` for the
 * discriminator rationale.
 */
export function encodeEncodedVideoHeader(fields: EncodedVideoHeaderFields): Buffer {
  return encodeFrameHeader({
    width: 0,
    height: (ENCODED_VIDEO_HEIGHT_BASE | (fields.keyframe ? ENCODED_VIDEO_KEYFRAME_BIT : 0)) >>> 0,
    bytesPerRow: fields.payloadLength,
    timestampMs: fields.presentationTimestampMs,
  });
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
