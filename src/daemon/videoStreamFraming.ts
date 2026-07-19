/**
 * Encoders for the `VideoStreamProtocol` framing, mirroring
 * `android/video-server/src/main/kotlin/dev/jasonpearson/automobile/video/VideoStreamProtocol.kt`.
 *
 * The capture sources normalize both the persistent encoder and `screenrecord` down to a raw
 * Annex-B elementary stream, which drops the on-device framing. The relay re-applies it so every
 * client sees one stable format regardless of which source produced the bytes.
 */

/** "h264" as a big-endian int. */
export const CODEC_ID_H264 = 0x68323634;

/** Bit 63 of `ptsAndFlags`: codec configuration data. */
export const PACKET_FLAG_CONFIG = 1n << 63n;

/** Bit 62 of `ptsAndFlags`: key frame. */
export const PACKET_FLAG_KEY_FRAME = 1n << 62n;

/** Bits 0-61 carry the presentation timestamp. */
export const PTS_MASK = (1n << 62n) - 1n;

/**
 * The 12-byte stream header: codec id, then width and height.
 *
 * Zero dimensions are legitimate here — the capture sources do not report them, and every decoder
 * takes the true dimensions from the in-band SPS. A caller that knows the size may pass it so a
 * client can size its surface before the first key frame arrives.
 */
export function encodeStreamHeader(width: number = 0, height: number = 0): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.writeInt32BE(CODEC_ID_H264, 0);
  header.writeInt32BE(width, 4);
  header.writeInt32BE(height, 8);
  return header;
}

export function encodePtsAndFlags(
  presentationTimeUs: bigint,
  { isConfig = false, isKeyFrame = false }: { isConfig?: boolean; isKeyFrame?: boolean } = {}
): bigint {
  let ptsAndFlags = presentationTimeUs & PTS_MASK;
  if (isConfig) {
    ptsAndFlags |= PACKET_FLAG_CONFIG;
  }
  if (isKeyFrame) {
    ptsAndFlags |= PACKET_FLAG_KEY_FRAME;
  }
  return ptsAndFlags;
}

/** The 12-byte per-packet header: `ptsAndFlags`, then payload length. */
export function encodePacketHeader(ptsAndFlags: bigint, size: number): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.writeBigInt64BE(BigInt.asIntN(64, ptsAndFlags), 0);
  header.writeInt32BE(size, 8);
  return header;
}

/** A framed packet: header followed by the Annex-B payload. */
export function encodePacket(ptsAndFlags: bigint, payload: Buffer): Buffer {
  return Buffer.concat([encodePacketHeader(ptsAndFlags, payload.length), payload]);
}

/**
 * True when an Annex-B chunk starts with a parameter-set NAL (SPS=7, PPS=8), which is what the
 * CONFIG flag marks. Callers use this so a decoder can find the parameter sets without parsing.
 */
export function isParameterSetChunk(chunk: Buffer): boolean {
  const nalType = firstNalUnitType(chunk);
  return nalType === 7 || nalType === 8;
}

/** True when the chunk carries an IDR NAL (type 5), i.e. a key frame. */
export function isKeyFrameChunk(chunk: Buffer): boolean {
  return firstNalUnitType(chunk) === 5;
}

/**
 * Type of the first NAL unit in an Annex-B chunk, or null when no start code is found.
 *
 * Start codes are 3 or 4 bytes (`00 00 01` / `00 00 00 01`); the low 5 bits of the byte after the
 * start code are the NAL type.
 */
function firstNalUnitType(chunk: Buffer): number | null {
  for (let i = 0; i + 3 < chunk.length; i++) {
    if (chunk[i] !== 0x00 || chunk[i + 1] !== 0x00) {
      continue;
    }
    if (chunk[i + 2] === 0x01) {
      return chunk[i + 3] & 0x1f;
    }
    if (chunk[i + 2] === 0x00 && i + 4 < chunk.length && chunk[i + 3] === 0x01) {
      return chunk[i + 4] & 0x1f;
    }
  }
  return null;
}
