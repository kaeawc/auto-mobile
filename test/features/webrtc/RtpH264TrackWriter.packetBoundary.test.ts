import { describe, expect, test } from "bun:test";
import { RtpPacket } from "werift";
import { H264AnnexBParser } from "../../../src/features/webrtc/h264";
import {
  H264_CLOCK_RATE,
  RtpH264TrackWriter,
  type RtpPacketSink,
} from "../../../src/features/webrtc/RtpH264TrackWriter";
import { FakeTimer } from "../../fakes/FakeTimer";
import { capturedH264AsDevicePackets } from "../../helpers/capturedH264Stream";

/**
 * Issue #10150: the Android video-server frames each encoder output as one
 * length-delimited packet. These tests replay a CAPTURED elementary stream
 * (test/helpers/capturedH264Stream.ts) split at its real NAL boundaries into
 * the device's packet shape: one config packet, then one packet per frame.
 */

class RecordingSink implements RtpPacketSink {
  readonly packets: RtpPacket[] = [];
  writeRtp(packet: RtpPacket): void {
    this.packets.push(packet.clone());
  }
}

const FRAME_INTERVAL_MS = 33;
const START = Buffer.from([0, 0, 0, 1]);

/** Feed the captured stream one device packet at a time, optionally signalling each end. */
function replayCaptured(signalBoundary: boolean, splitBytes?: number) {
  const sink = new RecordingSink();
  const timer = new FakeTimer();
  const writer = new RtpH264TrackWriter({ sink, ssrc: 7, timer });
  const framesAfterPacket: number[] = [];
  const arrivalMs: number[] = [];
  for (const packet of capturedH264AsDevicePackets()) {
    timer.advanceTime(FRAME_INTERVAL_MS);
    arrivalMs.push(timer.now());
    if (splitBytes === undefined) {
      writer.writeChunk(packet);
    } else {
      for (let offset = 0; offset < packet.length; offset += splitBytes) {
        writer.writeChunk(packet.subarray(offset, offset + splitBytes));
      }
    }
    if (signalBoundary) {
      writer.endOfPacket();
    }
    framesAfterPacket.push(writer.stats.framesWritten);
  }
  return { sink, writer, framesAfterPacket, arrivalMs };
}

const wire = (sink: RecordingSink) =>
  sink.packets.map((packet) => ({
    seq: packet.header.sequenceNumber,
    marker: packet.header.marker,
    payload: packet.payload.toString("hex"),
  }));

describe("RtpH264TrackWriter packet boundaries (issue #10150)", () => {
  test("without a boundary the newest frames wait for later packets (the reported lag)", () => {
    const { framesAfterPacket } = replayCaptured(false);
    // 11 packets: config, IDR, P1..P9 (10 frames). The writer is two packets behind.
    expect(framesAfterPacket).toHaveLength(11);
    expect(framesAfterPacket.at(-1)).toBe(8);
  });

  test("with a boundary every frame is sent when its packet ends, with no later packet needed", () => {
    const { framesAfterPacket, writer } = replayCaptured(true);
    // The config packet sends nothing (SPS/PPS wait for their IDR); each frame packet sends one frame.
    expect(framesAfterPacket).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Nothing is left for end-of-stream: the last frame was already delivered.
    writer.flush();
    expect(writer.stats.framesWritten).toBe(10);
  });

  test("emits the same RTP payloads, markers and sequence numbers as the boundary-less path", () => {
    const legacy = replayCaptured(false);
    legacy.writer.flush();
    const prompt = replayCaptured(true);
    prompt.writer.flush();
    expect(wire(prompt.sink)).toEqual(wire(legacy.sink));
    expect(prompt.sink.packets.length).toBeGreaterThan(10);
  });

  test("timestamps follow each frame's own arrival instead of lagging a packet", () => {
    const { sink, arrivalMs } = replayCaptured(true);
    const frameTimestamps = [...new Set(sink.packets.map((packet) => packet.header.timestamp))];
    // AU 1 (config + IDR) starts when the config packet arrived; later AUs at their own packet.
    const starts = [arrivalMs[0], ...arrivalMs.slice(2)];
    expect(frameTimestamps).toEqual(
      starts.map((ms) => Math.round((ms - starts[0]) * (H264_CLOCK_RATE / 1000))),
    );
  });

  test("keeps SPS+PPS with the IDR and never sends a parameter-set-only access unit", () => {
    const [config, idr] = capturedH264AsDevicePackets();
    const sink = new RecordingSink();
    const writer = new RtpH264TrackWriter({ sink, ssrc: 1, timer: new FakeTimer() });
    writer.writeChunk(config);
    writer.endOfPacket();
    expect(sink.packets).toHaveLength(0);

    writer.writeChunk(idr);
    writer.endOfPacket();
    const types = sink.packets.map((packet) => packet.payload[0] & 0x1f);
    expect(types.slice(0, 2)).toEqual([7, 8]);
    expect(sink.packets.filter((packet) => packet.header.marker)).toHaveLength(1);
    expect(sink.packets.at(-1)?.header.marker).toBe(true);
  });

  test("a NAL split across transport chunks is released only at the packet end, intact", () => {
    const whole = replayCaptured(true);
    const split = replayCaptured(true, 13);
    expect(wire(split.sink)).toEqual(wire(whole.sink));
    expect(split.framesAfterPacket).toEqual(whole.framesAfterPacket);

    // Mid-packet, before the boundary, nothing may leave early.
    const [config, idr] = capturedH264AsDevicePackets();
    const sink = new RecordingSink();
    const writer = new RtpH264TrackWriter({ sink, ssrc: 1, timer: new FakeTimer() });
    writer.writeChunk(config);
    writer.endOfPacket();
    const half = Math.floor(idr.length / 2);
    writer.writeChunk(idr.subarray(0, half));
    expect(sink.packets).toHaveLength(0);
    writer.writeChunk(idr.subarray(half));
    writer.endOfPacket();
    expect(writer.stats.framesWritten).toBe(1);
  });

  test("a late joiner's IDR is sent immediately with the primed parameter sets", () => {
    const packets = capturedH264AsDevicePackets();
    const [sps, pps] = new H264AnnexBParser().push(Buffer.concat([packets[0], START]));
    const sink = new RecordingSink();
    const writer = new RtpH264TrackWriter({ sink, ssrc: 1, timer: new FakeTimer() });
    writer.primeParameterSets(sps, pps);

    writer.writeChunk(packets[1]);
    expect(writer.stats.framesWritten).toBe(0);
    writer.endOfPacket();

    expect(writer.stats.framesWritten).toBe(1);
    expect(writer.stats.sawKeyFrame).toBe(true);
    expect(sink.packets[0].payload[0] & 0x1f).toBe(7);
    expect(sink.packets.at(-1)?.header.marker).toBe(true);
  });
});
