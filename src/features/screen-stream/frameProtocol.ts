/**
 * Decoder for the iOS screen-capture-helper wire protocol.
 *
 * Header (16 bytes, little-endian UInt32):
 *   width(4) | height(4) | bytesPerRow(4) | timestampMs(4)
 *
 * Followed by `height * bytesPerRow` bytes of BGRA pixel data. Audio records
 * reserve width=0: height=8000, bytesPerRow=1, timestampMs=payload length,
 * followed by 8 kHz mono PCM16LE bytes.
 *
 * The decoder buffers incoming chunks and emits complete frames as soon as
 * enough bytes have arrived. It tolerates arbitrary chunking from the helper's
 * stdout pipe.
 *
 * Corrupt headers are the interesting case. A corrupt header carries no usable
 * payload length, so the decoder cannot know where the damaged frame ends.
 * Skipping only the 16 header bytes would walk the payload as if it were a
 * sequence of headers, amplifying one bad frame on the wire into thousands of
 * downstream callbacks. Instead the decoder enters a resynchronizing state:
 * it reports the corruption exactly once, then scans forward byte by byte for
 * the next structurally plausible header and resumes there.
 */

export const FRAME_HEADER_SIZE = 16;

/**
 * Structural bounds used to decide whether 16 bytes are a plausible header.
 * These are not protocol limits — they are the sanity envelope that makes
 * resynchronization reliable. Without them roughly one in eight arbitrary
 * offsets in a payload satisfies the header rules, so a forward scan would
 * re-lock onto garbage almost immediately.
 */
/** Largest plausible display dimension, in pixels. */
const MAX_FRAME_DIMENSION = 16_384;
/**
 * Largest row padding accepted beyond the visible `width * 4` BGRA bytes.
 * `CVPixelBufferGetBytesPerRow` aligns rows to a small boundary (real captures
 * observed at exactly `width * 4`), so a full page of slack is generous. This
 * is the constraint that does most of the work during resynchronization: it
 * ties two of the four header words together, which arbitrary payload bytes
 * almost never satisfy.
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
   * True while the decoder has lost frame alignment and is scanning for the
   * next plausible header. Malformed callbacks are suppressed in this state so
   * one corrupt frame produces one report, not one per 16 discarded bytes.
   */
  private resynchronizing: boolean = false;

  /**
   * Append bytes from the helper's stdout stream and return any frames that
   * have completed. A malformed header is surfaced via `onMalformed` exactly
   * once; the decoder then discards bytes until it finds the next plausible
   * header and resumes decoding there.
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
   * Consume the next header from the front of the buffer. On a malformed
   * header the bytes are deliberately left in place — the decoder switches to
   * resynchronizing and the forward scan steps past them itself — and the
   * corruption is reported once.
   */
  private takeHeader(
    onMalformed?: (error: MalformedFrameError) => void
  ): FrameHeader | "starved" | "malformed" {
    if (this.buffer.length < FRAME_HEADER_SIZE) {return "starved";}
    const header = parseHeader(this.buffer, 0);
    const malformed = headerError(header);
    if (malformed) {
      this.resynchronizing = true;
      onMalformed?.({ reason: malformed, header });
      return "malformed";
    }
    this.buffer = this.buffer.subarray(FRAME_HEADER_SIZE);
    return header;
  }

  /**
   * Scan forward for the next frame boundary. Returns true when alignment is
   * recovered (the buffer now starts at that header), false when the buffered
   * bytes do not yet settle the question — in which case bytes that can no
   * longer contain a boundary are discarded and the scan resumes on the next
   * chunk.
   *
   * A structurally valid header alone is not enough: payload bytes shifted by
   * one can spell a perfectly plausible header. Each candidate is corroborated
   * by checking that whatever follows its payload is itself a valid header (or
   * that the payload runs exactly to the end of what has arrived).
   */
  private resynchronize(): boolean {
    const lastOffset = this.buffer.length - FRAME_HEADER_SIZE;
    let firstUnsettled = -1;

    for (let offset = 0; offset <= lastOffset; offset++) {
      const header = parseHeader(this.buffer, offset);
      if (headerError(header) !== null) {continue;}
      const verdict = this.corroborate(offset, header);
      if (verdict === "accept") {
        this.buffer = this.buffer.subarray(offset);
        this.resynchronizing = false;
        return true;
      }
      if (verdict === "unsettled" && firstUnsettled < 0) {firstUnsettled = offset;}
    }

    // A corroborated candidate outranks an earlier unproven one — payload
    // bytes one byte before a real boundary can spell a valid header, and only
    // corroboration tells the two apart. So the scan runs to the end before
    // falling back to the earliest candidate more bytes could still confirm;
    // failing that, keep only what could be a header straddling the chunk
    // boundary. The retained region is rescanned when the next chunk arrives,
    // which is bounded in practice: post-validation a random offset is a
    // plausible header with probability ~2^-38, so the fallback is virtually
    // always the genuine next frame, settled as soon as its payload lands.
    const keepFrom =
      firstUnsettled >= 0
        ? firstUnsettled
        : Math.max(0, this.buffer.length - (FRAME_HEADER_SIZE - 1));
    if (keepFrom > 0) {
      // Copy so the discarded chunk allocation can be freed.
      this.buffer = Buffer.from(this.buffer.subarray(keepFrom));
    }
    return false;
  }

  /**
   * Decide whether a candidate header at `offset` really is a frame boundary.
   * "unsettled" means the buffered bytes cannot answer yet — the caller keeps
   * the candidate and re-asks once more data arrives. Retention is bounded by
   * the same payload ceiling that bounds normal decoding.
   */
  private corroborate(offset: number, header: FrameHeader): "accept" | "unsettled" | "reject" {
    const end = offset + FRAME_HEADER_SIZE + payloadSize(header);
    const trailing = this.buffer.length - end;
    if (trailing < 0) {return "unsettled";}
    if (trailing === 0) {return "accept";}
    if (trailing < FRAME_HEADER_SIZE) {return "unsettled";}
    return headerError(parseHeader(this.buffer, end)) === null ? "accept" : "reject";
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

function parseHeader(buffer: Buffer, offset: number): FrameHeader {
  return {
    width: buffer.readUInt32LE(offset),
    height: buffer.readUInt32LE(offset + 4),
    bytesPerRow: buffer.readUInt32LE(offset + 8),
    timestampMs: buffer.readUInt32LE(offset + 12),
  };
}

/** Returns the reason these 16 bytes are not a usable header, or null. */
function headerError(header: FrameHeader): MalformedFrameReason | null {
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
