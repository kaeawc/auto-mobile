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
 */

export const FRAME_HEADER_SIZE = 16;

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

export interface MalformedFrameError {
  reason: "header_width_zero" | "header_height_zero" | "header_bytes_per_row_too_small";
  header: FrameHeader;
}

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private pendingHeader: FrameHeader | null = null;

  /**
   * Append bytes from the helper's stdout stream and return any frames that
   * have completed. Malformed headers are surfaced via `onMalformed`; the
   * decoder discards the offending bytes and continues parsing.
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
      if (this.pendingHeader === null) {
        if (this.buffer.length < FRAME_HEADER_SIZE) {break;}
        const header = parseHeader(this.buffer);
        this.buffer = this.buffer.subarray(FRAME_HEADER_SIZE);
        if (isAudioHeader(header)) {
          this.pendingHeader = header;
          continue;
        }
        const malformed = validateHeader(header);
        if (malformed) {
          onMalformed?.({ reason: malformed, header });
          continue;
        }
        this.pendingHeader = header;
      }

      const expected = isAudioHeader(this.pendingHeader)
        ? this.pendingHeader.timestampMs
        : this.pendingHeader.height * this.pendingHeader.bytesPerRow;
      if (this.buffer.length < expected) {break;}

      // Copy pixels to release the underlying chunk allocation; otherwise
      // every emitted frame pins the entire upstream buffer in memory.
      const payload = Buffer.from(this.buffer.subarray(0, expected));
      this.buffer = this.buffer.subarray(expected);
      if (isAudioHeader(this.pendingHeader)) {
        onAudio?.({ pcm16le: payload });
      } else {
        frames.push({ header: this.pendingHeader, pixels: payload });
      }
      this.pendingHeader = null;
    }

    return frames;
  }
}

function isAudioHeader(header: FrameHeader): boolean {
  return header.width === 0 && header.height === 8_000 && header.bytesPerRow === 1;
}

function parseHeader(buffer: Buffer): FrameHeader {
  return {
    width: buffer.readUInt32LE(0),
    height: buffer.readUInt32LE(4),
    bytesPerRow: buffer.readUInt32LE(8),
    timestampMs: buffer.readUInt32LE(12),
  };
}

function validateHeader(header: FrameHeader): MalformedFrameError["reason"] | null {
  if (header.width === 0) {return "header_width_zero";}
  if (header.height === 0) {return "header_height_zero";}
  // BGRA is 4 bytes per pixel; bytesPerRow may include padding but must fit
  // at least the visible pixels.
  if (header.bytesPerRow < header.width * 4) {return "header_bytes_per_row_too_small";}
  return null;
}
