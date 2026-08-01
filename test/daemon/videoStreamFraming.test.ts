import { describe, expect, test } from "bun:test";
import {
  CODEC_ID_H264,
  encodePacket,
  encodePacketHeader,
  encodePtsAndFlags,
  encodeStreamHeader,
  isKeyFrameChunk,
  isParameterSetChunk,
  PACKET_FLAG_CONFIG,
  PACKET_FLAG_KEY_FRAME,
  PACKET_FLAG_ROTATION_PRESENT,
  PTS_MASK,
  ROTATION_MASK,
  ROTATION_SHIFT,
} from "../../src/daemon/videoStreamFraming";

/** Annex-B chunk with a 4-byte start code and the given NAL type. */
function annexB(nalType: number, payload: number[] = [0x00]): Buffer {
  return Buffer.from([0x00, 0x00, 0x00, 0x01, nalType & 0x1f, ...payload]);
}

describe("videoStreamFraming", () => {
  describe("stream header", () => {
    test("carries the h264 codec id and dimensions", () => {
      const header = encodeStreamHeader(1080, 2400);

      expect(header.length).toBe(12);
      expect(header.readInt32BE(0)).toBe(CODEC_ID_H264);
      expect(header.readInt32BE(4)).toBe(1080);
      expect(header.readInt32BE(8)).toBe(2400);
    });

    test("defaults to zero dimensions, which decoders take from the SPS instead", () => {
      const header = encodeStreamHeader();

      expect(header.readInt32BE(4)).toBe(0);
      expect(header.readInt32BE(8)).toBe(0);
    });

    test("the codec id matches the on-device encoder's constant", () => {
      // "h264" big-endian, per VideoStreamProtocol.CODEC_ID_H264.
      expect(CODEC_ID_H264).toBe(0x68323634);
      expect(Buffer.from("h264", "ascii").readInt32BE(0)).toBe(CODEC_ID_H264);
    });
  });

  describe("pts and flags", () => {
    test("a plain frame carries only the timestamp", () => {
      expect(encodePtsAndFlags(12345n)).toBe(12345n);
    });

    test("config and key-frame bits sit above the timestamp", () => {
      const ptsAndFlags = encodePtsAndFlags(12345n, { isConfig: true, isKeyFrame: true });

      expect(ptsAndFlags & PACKET_FLAG_CONFIG).toBe(PACKET_FLAG_CONFIG);
      expect(ptsAndFlags & PACKET_FLAG_KEY_FRAME).toBe(PACKET_FLAG_KEY_FRAME);
      expect(ptsAndFlags & ((1n << 62n) - 1n)).toBe(12345n);
    });

    test("a timestamp wider than 62 bits is masked rather than corrupting the flags", () => {
      const ptsAndFlags = encodePtsAndFlags((1n << 63n) | 7n);

      expect(ptsAndFlags & PACKET_FLAG_CONFIG).toBe(0n);
      expect(ptsAndFlags).toBe(7n);
    });

    // --- Rotation attestation (issue #4786), layer 2 ---

    test("a config packet attests rotation with the presence bit and a 2-bit field", () => {
      for (const rotation of [0, 1, 2, 3]) {
        const ptsAndFlags = encodePtsAndFlags(1000n, { isConfig: true, rotation });

        expect(ptsAndFlags & PACKET_FLAG_ROTATION_PRESENT).toBe(PACKET_FLAG_ROTATION_PRESENT);
        expect((ptsAndFlags & ROTATION_MASK) >> ROTATION_SHIFT).toBe(BigInt(rotation));
        // The rotation field must not leak into the timestamp.
        expect(ptsAndFlags & PTS_MASK).toBe(1000n);
      }
    });

    test("a null rotation leaves the presence bit clear so the desktop reads unknown", () => {
      const ptsAndFlags = encodePtsAndFlags(1000n, { isConfig: true, rotation: null });

      expect(ptsAndFlags & PACKET_FLAG_ROTATION_PRESENT).toBe(0n);
      expect(ptsAndFlags & ROTATION_MASK).toBe(0n);
    });

    test("rotation is ignored on a non-config packet", () => {
      const ptsAndFlags = encodePtsAndFlags(1000n, { isKeyFrame: true, rotation: 3 });

      expect(ptsAndFlags & PACKET_FLAG_ROTATION_PRESENT).toBe(0n);
      expect(ptsAndFlags & ROTATION_MASK).toBe(0n);
      expect(ptsAndFlags & PTS_MASK).toBe(1000n);
    });
  });

  describe("packet header", () => {
    test("is 12 bytes of ptsAndFlags then size", () => {
      const header = encodePacketHeader(42n, 1024);

      expect(header.length).toBe(12);
      expect(header.readBigInt64BE(0)).toBe(42n);
      expect(header.readInt32BE(8)).toBe(1024);
    });

    test("the config flag survives the round trip as a negative int64", () => {
      // Bit 63 set means the signed 64-bit read comes back negative; the client masks it off.
      const header = encodePacketHeader(encodePtsAndFlags(1n, { isConfig: true }), 0);

      expect(header.readBigInt64BE(0)).toBeLessThan(0n);
      expect(BigInt.asUintN(64, header.readBigInt64BE(0)) & PACKET_FLAG_CONFIG).toBe(
        PACKET_FLAG_CONFIG
      );
    });

    test("a packet is its header followed by the payload verbatim", () => {
      const payload = Buffer.from([1, 2, 3, 4, 5]);

      const packet = encodePacket(7n, payload);

      expect(packet.length).toBe(12 + payload.length);
      expect(packet.readInt32BE(8)).toBe(payload.length);
      expect(packet.subarray(12)).toEqual(payload);
    });
  });

  describe("NAL classification", () => {
    test("SPS and PPS are parameter sets", () => {
      expect(isParameterSetChunk(annexB(7))).toBe(true);
      expect(isParameterSetChunk(annexB(8))).toBe(true);
    });

    test("an IDR NAL is a key frame and not a parameter set", () => {
      expect(isKeyFrameChunk(annexB(5))).toBe(true);
      expect(isParameterSetChunk(annexB(5))).toBe(false);
    });

    test("a non-IDR slice is neither", () => {
      expect(isKeyFrameChunk(annexB(1))).toBe(false);
      expect(isParameterSetChunk(annexB(1))).toBe(false);
    });

    test("three-byte start codes are recognized too", () => {
      expect(isParameterSetChunk(Buffer.from([0x00, 0x00, 0x01, 0x07, 0x10]))).toBe(true);
    });

    test("a chunk with no start code classifies as neither rather than throwing", () => {
      expect(isKeyFrameChunk(Buffer.from([0xaa, 0xbb, 0xcc]))).toBe(false);
      expect(isParameterSetChunk(Buffer.from([]))).toBe(false);
    });

    test("leading padding before the start code is skipped", () => {
      const padded = Buffer.concat([Buffer.from([0xff, 0xfe]), annexB(7)]);

      expect(isParameterSetChunk(padded)).toBe(true);
    });
  });
});
