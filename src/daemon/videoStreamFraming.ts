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

/**
 * Bit 61 of `ptsAndFlags`: ROTATION_PRESENT (issue #4786). Set on a CONFIG packet whose bits 60-59
 * carry an attested display rotation. This layer has no REPLAYED flag, so bit 61 is free — it is a
 * presence marker distinct from the device-side protocol's bit 61 (REPLAYED). A relay whose source
 * cannot attest rotation (screenrecord, iOS) leaves this bit clear, and the desktop reads `null`
 * (control fails closed).
 */
export const PACKET_FLAG_ROTATION_PRESENT = 1n << 61n;
/**
 * A zero-payload telemetry packet carries the source encoder's cumulative dropped-frame count in
 * its low 59 bits. It shares bit 61 with rotation presence only when CONFIG is clear.
 */
export const PACKET_FLAG_DROPPED_FRAMES = 1n << 61n;

/** Attested display rotation (0..3) occupies bits 60-59 of a CONFIG packet (issue #4786). */
export const ROTATION_SHIFT = 59n;
export const ROTATION_MASK = 0b11n << ROTATION_SHIFT;

/**
 * Bits 0-58 carry the presentation timestamp. Narrowed from bits 0-61 to make room for the rotation
 * presence bit and field; backward compatible because a real microsecond PTS never reaches bit 59
 * (~18 000 years), so older streams wrote 0 there and older parsers read them as zero PTS.
 */
export const PTS_MASK = (1n << ROTATION_SHIFT) - 1n;

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
  {
    isConfig = false,
    isKeyFrame = false,
    rotation = null,
  }: { isConfig?: boolean; isKeyFrame?: boolean; rotation?: number | null } = {},
): bigint {
  let ptsAndFlags = presentationTimeUs & PTS_MASK;
  if (isConfig) {
    ptsAndFlags |= PACKET_FLAG_CONFIG;
    // Attest rotation ONLY on config packets, and only when the source proved it; a null rotation
    // (screenrecord/iOS) leaves the presence bit clear so the desktop reads `null` (issue #4786).
    if (rotation !== null) {
      ptsAndFlags |= PACKET_FLAG_ROTATION_PRESENT;
      ptsAndFlags |= (BigInt(rotation) & 0b11n) << ROTATION_SHIFT;
    }
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

/** Encode source-side encoder-drop telemetry without injecting bytes into the H.264 decoder. */
export function encodeDroppedFrames(droppedFrames: number): Buffer {
  return encodePacket(
    PACKET_FLAG_DROPPED_FRAMES | (BigInt(droppedFrames) & PTS_MASK),
    Buffer.alloc(0),
  );
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
