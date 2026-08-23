import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RTP_MTU,
  FU_A_TYPE,
  H264AccessUnitAssembler,
  H264AnnexBParser,
  NAL_TYPE_AUD,
  NAL_TYPE_IDR,
  NAL_TYPE_PPS,
  NAL_TYPE_SPS,
  isKeyFrameNal,
  isVclNal,
  nalUnitType,
  packetizeAccessUnit,
  packetizeNalUnit,
} from "../../../src/features/webrtc/h264";

/** Build a NAL unit whose header encodes the given type, padded to `size`. */
function makeNal(type: number, size: number, fill = 0xab): Buffer {
  const nal = Buffer.alloc(size, fill);
  nal[0] = type & 0x1f; // forbidden_zero_bit=0, nal_ref_idc=0
  return nal;
}

const START_4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);
const START_3 = Buffer.from([0x00, 0x00, 0x01]);

describe("nal helpers", () => {
  test("nalUnitType reads lower 5 bits", () => {
    expect(nalUnitType(Buffer.from([0x67]))).toBe(NAL_TYPE_SPS);
    expect(nalUnitType(Buffer.from([0x68]))).toBe(NAL_TYPE_PPS);
    expect(nalUnitType(Buffer.from([0x65]))).toBe(NAL_TYPE_IDR);
    expect(nalUnitType(Buffer.alloc(0))).toBe(0);
  });

  test("isVclNal / isKeyFrameNal classify coded slices", () => {
    expect(isVclNal(makeNal(1, 4))).toBe(true);
    expect(isVclNal(makeNal(5, 4))).toBe(true);
    expect(isVclNal(makeNal(NAL_TYPE_SPS, 4))).toBe(false);
    expect(isKeyFrameNal(makeNal(5, 4))).toBe(true);
    expect(isKeyFrameNal(makeNal(1, 4))).toBe(false);
  });
});

describe("H264AnnexBParser", () => {
  test("splits NAL units on 3- and 4-byte start codes", () => {
    const parser = new H264AnnexBParser();
    const sps = makeNal(NAL_TYPE_SPS, 5);
    const pps = makeNal(NAL_TYPE_PPS, 4);
    const idr = makeNal(NAL_TYPE_IDR, 8);
    const stream = Buffer.concat([START_4, sps, START_3, pps, START_4, idr]);

    const nals = [...parser.push(stream), ...parser.flush()];

    expect(nals).toHaveLength(3);
    expect(nals[0].equals(sps)).toBe(true);
    expect(nals[1].equals(pps)).toBe(true);
    expect(nals[2].equals(idr)).toBe(true);
  });

  test("reassembles NAL units split across chunk boundaries", () => {
    const parser = new H264AnnexBParser();
    const sps = makeNal(NAL_TYPE_SPS, 6);
    const idr = makeNal(NAL_TYPE_IDR, 10);
    const stream = Buffer.concat([START_4, sps, START_4, idr]);

    const nals: Buffer[] = [];
    // Feed the stream one byte at a time to stress boundary handling.
    for (const byte of stream) {
      nals.push(...parser.push(Buffer.from([byte])));
    }
    nals.push(...parser.flush());

    expect(nals).toHaveLength(2);
    expect(nals[0].equals(sps)).toBe(true);
    expect(nals[1].equals(idr)).toBe(true);
  });

  test("does not emit the trailing NAL until flush", () => {
    const parser = new H264AnnexBParser();
    const first = makeNal(1, 4);
    const second = makeNal(1, 4, 0xcd);

    const afterPush = parser.push(Buffer.concat([START_4, first, START_4, second]));
    expect(afterPush).toHaveLength(1);
    expect(afterPush[0].equals(first)).toBe(true);

    const afterFlush = parser.flush();
    expect(afterFlush).toHaveLength(1);
    expect(afterFlush[0].equals(second)).toBe(true);
  });

  test("identifies a complete header for the buffered trailing NAL without flushing it", () => {
    const parser = new H264AnnexBParser();
    const idr = makeNal(NAL_TYPE_IDR, 4);

    expect(parser.push(Buffer.concat([START_4, idr]))).toEqual([]);
    expect(parser.hasBufferedNalType(NAL_TYPE_IDR)).toBe(true);
    expect(parser.flush()).toEqual([idr]);
  });

  test("drops an unterminated oversized NAL instead of retaining it indefinitely", () => {
    const parser = new H264AnnexBParser(8);

    expect(() => parser.push(Buffer.concat([START_4, Buffer.alloc(5, 0x67)]))).toThrow(
      /buffer exceeded 8 bytes/,
    );
    // The rejected partial NAL cannot contaminate the next capture source.
    expect(parser.push(Buffer.concat([START_4, makeNal(NAL_TYPE_IDR, 2)])).length).toBe(0);
  });
});

describe("H264AccessUnitAssembler", () => {
  test("groups parameter sets with the following VCL slice", () => {
    const assembler = new H264AccessUnitAssembler();
    const sps = makeNal(NAL_TYPE_SPS, 4);
    const pps = makeNal(NAL_TYPE_PPS, 4);
    const idr = makeNal(NAL_TYPE_IDR, 6);
    const pFrame = makeNal(1, 6);

    const completed: Buffer[][] = [];
    completed.push(...assembler.push(sps));
    completed.push(...assembler.push(pps));
    completed.push(...assembler.push(idr));
    // The P-frame VCL begins a new access unit, flushing the IDR AU.
    completed.push(...assembler.push(pFrame));
    completed.push(...assembler.flush());

    expect(completed).toHaveLength(2);
    expect(completed[0]).toEqual([sps, pps, idr]);
    expect(completed[1]).toEqual([pFrame]);
  });

  test("parameter sets after a VCL frame begin the next access unit (segment restart)", () => {
    const assembler = new H264AccessUnitAssembler();
    const pFrame = makeNal(1, 6);
    const sps = makeNal(NAL_TYPE_SPS, 4);
    const pps = makeNal(NAL_TYPE_PPS, 4);
    const idr = makeNal(NAL_TYPE_IDR, 8);

    const completed: Buffer[][] = [];
    // Sequence a screenrecord segment boundary produces: trailing P frame, then
    // the new segment's SPS/PPS/IDR keyframe.
    completed.push(...assembler.push(pFrame));
    completed.push(...assembler.push(sps));
    completed.push(...assembler.push(pps));
    completed.push(...assembler.push(idr));
    completed.push(...assembler.flush());

    // The P frame is its own AU; SPS+PPS+IDR stay together as the keyframe AU.
    expect(completed).toHaveLength(2);
    expect(completed[0]).toEqual([pFrame]);
    expect(completed[1]).toEqual([sps, pps, idr]);
  });

  test("keeps multiple slices of one picture in the same access unit", () => {
    const assembler = new H264AccessUnitAssembler();
    // fill 0x80 -> MSB set -> first_mb_in_slice == 0 (new picture);
    // fill 0x00 -> MSB clear -> first_mb_in_slice > 0 (continuation slice).
    const pic1Slice1 = makeNal(1, 6, 0x80);
    const pic1Slice2 = makeNal(1, 6, 0x00);
    const pic2Slice1 = makeNal(1, 6, 0x80);

    const completed: Buffer[][] = [];
    completed.push(...assembler.push(pic1Slice1));
    completed.push(...assembler.push(pic1Slice2)); // same picture
    completed.push(...assembler.push(pic2Slice1)); // next picture
    completed.push(...assembler.flush());

    expect(completed).toHaveLength(2);
    expect(completed[0]).toEqual([pic1Slice1, pic1Slice2]);
    expect(completed[1]).toEqual([pic2Slice1]);
  });

  test("access unit delimiter starts a new access unit", () => {
    const assembler = new H264AccessUnitAssembler();
    const aud1 = makeNal(NAL_TYPE_AUD, 2);
    const frame1 = makeNal(1, 4);
    const aud2 = makeNal(NAL_TYPE_AUD, 2);
    const frame2 = makeNal(1, 4);

    const completed: Buffer[][] = [];
    completed.push(...assembler.push(aud1));
    completed.push(...assembler.push(frame1));
    completed.push(...assembler.push(aud2));
    completed.push(...assembler.push(frame2));
    completed.push(...assembler.flush());

    expect(completed).toHaveLength(2);
    expect(completed[0]).toEqual([aud1, frame1]);
    expect(completed[1]).toEqual([aud2, frame2]);
  });
});

describe("packetizeNalUnit", () => {
  test("small NAL units are sent as a single packet unchanged", () => {
    const nal = makeNal(NAL_TYPE_IDR, 20);
    const packets = packetizeNalUnit(nal, DEFAULT_RTP_MTU);
    expect(packets).toHaveLength(1);
    expect(packets[0].equals(nal)).toBe(true);
  });

  test("large NAL units are fragmented into FU-A packets", () => {
    const mtu = 10;
    const nal = makeNal(NAL_TYPE_IDR, 25); // nal_ref_idc bits are 0 here
    const packets = packetizeNalUnit(nal, mtu);

    // 24 payload bytes / (10 - 2) = 3 fragments.
    expect(packets).toHaveLength(3);

    for (const packet of packets) {
      expect(packet.length).toBeLessThanOrEqual(mtu);
      expect(packet[0] & 0x1f).toBe(FU_A_TYPE);
    }

    // Start bit on first, end bit on last, neither in the middle.
    expect(packets[0][1] & 0x80).toBe(0x80);
    expect(packets[0][1] & 0x40).toBe(0x00);
    expect(packets[1][1] & 0xc0).toBe(0x00);
    expect(packets[2][1] & 0x40).toBe(0x40);

    // Reassembled fragment payloads reconstruct the original (minus NAL header).
    const reassembled = Buffer.concat(packets.map((packet) => packet.subarray(2)));
    expect(reassembled.equals(nal.subarray(1))).toBe(true);
    // Original NAL type is preserved in the FU header.
    expect(packets[0][1] & 0x1f).toBe(NAL_TYPE_IDR);
  });

  test("preserves nal_ref_idc bits in the FU indicator", () => {
    const nal = Buffer.alloc(30, 0x11);
    nal[0] = 0x65; // nal_ref_idc=3, type=5 (IDR)
    const packets = packetizeNalUnit(nal, 10);
    for (const packet of packets) {
      expect(packet[0] & 0xe0).toBe(0x60); // nal_ref_idc preserved
      expect(packet[0] & 0x1f).toBe(FU_A_TYPE);
    }
  });

  test("empty NAL yields no packets", () => {
    expect(packetizeNalUnit(Buffer.alloc(0))).toEqual([]);
  });

  // A non-advancing MTU would make the FU-A fragment loop spin forever on a
  // NAL larger than the MTU, wedging the daemon (issue #4170). The guard must
  // reject any MTU that leaves no room for a payload byte past the 2-byte
  // FU-A header, and any non-finite MTU that would silently truncate the NAL.
  test.each([
    [2, "MTU equal to the FU-A header leaves zero payload room"],
    [1, "MTU below the FU-A header cannot advance"],
    [0, "zero MTU cannot advance"],
    [-1, "negative MTU cannot advance"],
    [Number.NaN, "NaN MTU would truncate the NAL to an empty fragment"],
  ])("throws instead of looping when a NAL exceeds a non-advancing mtu %p", (mtu, _why) => {
    const nal = makeNal(NAL_TYPE_IDR, 40);
    expect(() => packetizeNalUnit(nal, mtu)).toThrow(/MTU/);
  });

  test("an infinite mtu sends the whole NAL as one packet (not a defect)", () => {
    const nal = makeNal(NAL_TYPE_IDR, 40);
    const packets = packetizeNalUnit(nal, Number.POSITIVE_INFINITY);
    expect(packets).toHaveLength(1);
    expect(packets[0].equals(nal)).toBe(true);
  });
});

describe("packetizeAccessUnit", () => {
  test("marks only the final packet of the access unit", () => {
    const sps = makeNal(NAL_TYPE_SPS, 4);
    const idr = makeNal(NAL_TYPE_IDR, 40); // will fragment at mtu 10
    const units = packetizeAccessUnit([sps, idr], 10);

    expect(units.length).toBeGreaterThan(2);
    const markers = units.map((unit) => unit.marker);
    expect(markers.filter(Boolean)).toHaveLength(1);
    expect(units[units.length - 1].marker).toBe(true);
    expect(units[0].marker).toBe(false);
  });
});
