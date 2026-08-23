import { describe, expect, test } from "bun:test";
import { RtpPacket } from "werift";
import {
  H264_CLOCK_RATE,
  RtpH264TrackWriter,
  type RtpPacketSink,
} from "../../../src/features/webrtc/RtpH264TrackWriter";
import { FakeTimer } from "../../fakes/FakeTimer";

class RecordingSink implements RtpPacketSink {
  readonly packets: RtpPacket[] = [];
  writeRtp(packet: RtpPacket): void {
    // Clone to snapshot header state at write time.
    this.packets.push(packet.clone());
  }
}

function makeNal(type: number, size: number, fill = 0x5a): Buffer {
  const nal = Buffer.alloc(size, fill);
  nal[0] = type & 0x1f;
  // VCL slices need first_mb_in_slice == 0 (MSB of the first RBSP byte) so the
  // access-unit assembler treats each as the start of a new picture.
  if (type >= 1 && type <= 5 && size > 1) {
    nal[1] = 0x80;
  }
  return nal;
}

const START = Buffer.from([0x00, 0x00, 0x00, 0x01]);

function annexB(...nals: Buffer[]): Buffer {
  return Buffer.concat(nals.flatMap((nal) => [START, nal]));
}

describe("RtpH264TrackWriter", () => {
  test("emits one packet per NAL, marking only the last of each access unit", () => {
    const sink = new RecordingSink();
    const timer = new FakeTimer();
    const writer = new RtpH264TrackWriter({
      sink,
      ssrc: 0x11223344,
      timer,
      initialSequenceNumber: 1000,
    });

    // SPS + PPS + IDR = access unit 1 (3 NALs -> 3 packets); a following
    // P-frame is access unit 2 (1 packet).
    writer.writeChunk(annexB(makeNal(7, 4), makeNal(8, 4), makeNal(5, 20)));
    writer.writeChunk(annexB(makeNal(1, 20)));
    writer.flush();

    expect(sink.packets).toHaveLength(4);
    // Sequence numbers increment across every packet.
    expect(sink.packets.map((packet) => packet.header.sequenceNumber)).toEqual([
      1000, 1001, 1002, 1003,
    ]);
    // Marker set only on the last packet of each access unit (IDR, then P).
    expect(sink.packets.map((packet) => packet.header.marker)).toEqual([false, false, true, true]);
    expect(sink.packets[0].header.ssrc).toBe(0x11223344);
    expect(writer.stats.framesWritten).toBe(2);
    expect(writer.stats.sawKeyFrame).toBe(true);
  });

  test("all fragments of a frame share a timestamp; only the last is marked", () => {
    const sink = new RecordingSink();
    const timer = new FakeTimer();
    const writer = new RtpH264TrackWriter({ sink, ssrc: 1, timer, mtu: 12 });

    // Large IDR fragments into multiple FU-A packets within one access unit.
    writer.writeChunk(annexB(makeNal(5, 60)));
    writer.flush();

    expect(sink.packets.length).toBeGreaterThan(1);
    const timestamps = new Set(sink.packets.map((packet) => packet.header.timestamp));
    expect(timestamps.size).toBe(1);
    const markerCount = sink.packets.filter((packet) => packet.header.marker).length;
    expect(markerCount).toBe(1);
    expect(sink.packets[sink.packets.length - 1].header.marker).toBe(true);
  });

  test("RTP timestamps advance with the wall clock at 90kHz", () => {
    const sink = new RecordingSink();
    const timer = new FakeTimer();
    const writer = new RtpH264TrackWriter({ sink, ssrc: 7, timer });

    // Terminate each NAL with a trailing start code so it is consumed promptly
    // (mirrors a continuous byte stream where the next frame's start code has
    // already arrived).
    writer.writeChunk(Buffer.concat([START, makeNal(5, 10), START])); // IDR consumed at t=0
    timer.advanceTime(100); // 100ms later
    writer.writeChunk(Buffer.concat([makeNal(1, 10), START])); // P1 consumed at t=100
    writer.flush();

    expect(sink.packets).toHaveLength(2);
    // The IDR access unit arrived at t=0 -> base timestamp 0.
    expect(sink.packets[0].header.timestamp).toBe(0);
    // The P frame arrived at t=100ms -> 100 * 90 = 9000 ticks.
    expect(sink.packets[1].header.timestamp).toBe(Math.round(100 * (H264_CLOCK_RATE / 1000)));
  });

  test("sequence numbers wrap at 16 bits", () => {
    const sink = new RecordingSink();
    const writer = new RtpH264TrackWriter({ sink, ssrc: 1, initialSequenceNumber: 0xffff });
    writer.writeChunk(annexB(makeNal(5, 8)));
    writer.writeChunk(annexB(makeNal(1, 8)));
    writer.flush();
    expect(sink.packets[0].header.sequenceNumber).toBe(0xffff);
    expect(sink.packets[1].header.sequenceNumber).toBe(0);
  });

  test("re-injects cached SPS/PPS before a later IDR that lacks them", () => {
    const sink = new RecordingSink();
    const writer = new RtpH264TrackWriter({ sink, ssrc: 1 });
    const sps = Buffer.from([0x67, 0x42, 0xe0, 0x2a]);
    const pps = Buffer.from([0x68, 0xce, 0x3c, 0x80]);

    // First keyframe carries parameter sets (as screenrecord/jar emit at start).
    writer.writeChunk(annexB(sps, pps, makeNal(5, 20)));
    writer.writeChunk(annexB(makeNal(1, 20))); // completes the first AU
    // A later bare IDR (no SPS/PPS) — the persistent encoder's steady state.
    writer.writeChunk(annexB(makeNal(5, 20)));
    writer.writeChunk(annexB(makeNal(1, 20))); // completes the bare IDR AU
    writer.flush();

    const nalTypes = sink.packets.map((packet) => packet.payload[0] & 0x1f);
    // Two IDR (type 5) frames were written; each must be preceded by SPS(7)+PPS(8).
    const idrIndices = nalTypes.flatMap((type, index) => (type === 5 ? [index] : []));
    expect(idrIndices).toHaveLength(2);
    for (const idrIndex of idrIndices) {
      expect(nalTypes[idrIndex - 2]).toBe(7);
      expect(nalTypes[idrIndex - 1]).toBe(8);
    }
  });

  test("uses parameter sets captured before this writer was attached", () => {
    const sink = new RecordingSink();
    const writer = new RtpH264TrackWriter({ sink, ssrc: 1 });
    const sps = Buffer.from([0x67, 0x42, 0xe0, 0x2a]);
    const pps = Buffer.from([0x68, 0xce, 0x3c, 0x80]);

    writer.primeParameterSets(sps, pps);
    writer.writeChunk(annexB(makeNal(5, 20)));
    writer.writeChunk(annexB(makeNal(1, 20)));
    writer.flush();

    expect(sink.packets.map((packet) => packet.payload[0] & 0x1f)).toEqual([7, 8, 5, 1]);
  });

  test("does not duplicate parameter sets an IDR access unit already carries", () => {
    const sink = new RecordingSink();
    const writer = new RtpH264TrackWriter({ sink, ssrc: 1 });
    writer.writeChunk(annexB(makeNal(7, 4), makeNal(8, 4), makeNal(5, 20)));
    writer.writeChunk(annexB(makeNal(1, 20)));
    writer.flush();

    const nalTypes = sink.packets.map((packet) => packet.payload[0] & 0x1f);
    // Exactly one SPS and one PPS — no injected duplicates.
    expect(nalTypes.filter((type) => type === 7)).toHaveLength(1);
    expect(nalTypes.filter((type) => type === 8)).toHaveLength(1);
  });

  test("observes an SPS before packetizing its access unit", () => {
    const sink = new RecordingSink();
    const observed: Buffer[] = [];
    const writer = new RtpH264TrackWriter({
      sink,
      ssrc: 1,
      onSps: (sps) => observed.push(Buffer.from(sps)),
    });
    const sps = Buffer.from([0x67, 0x42, 0xe0, 0x2a]);

    writer.writeChunk(annexB(sps, makeNal(5, 8)));
    writer.flush();

    expect(observed).toEqual([sps]);
  });
});
