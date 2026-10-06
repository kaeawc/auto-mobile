import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import type { H264CaptureSource } from "../../src/features/webrtc/H264CaptureSource";
import { H264AnnexBParser, nalUnitType } from "../../src/features/webrtc/h264";
import { VideoStreamSocketServer } from "../../src/daemon/videoStreamSocketServer";
import { permissiveDeviceAdmissionGate } from "../../src/daemon/deviceAdmissionGate";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { capturedH264AsDevicePackets } from "../helpers/capturedH264Stream";

/**
 * Issue #10150: the Android persistent encoder delivers one length-framed packet per encoder
 * output and signals each packet end through `onEncodedAccessUnit`. The relay must forward and
 * cache the packet's NALs at that point, not when the encoder's next output starts a new NAL.
 * Packets are CAPTURED encoder output (test/helpers/capturedH264Stream.ts) split at real NAL
 * boundaries: a config packet, an SEI+IDR packet, then one packet per P frame.
 */

const device = { deviceId: "emulator-5554", name: "Pixel", platform: "android" } as BootedDevice;

class FakeAndroidSource implements H264CaptureSource {
  keyFrameRequests = 0;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  requestKeyFrame(): boolean {
    this.keyFrameRequests++;
    return true;
  }
}

class TestVideoServer extends VideoStreamSocketServer {
  async subscribe(socket: FakeSocket): Promise<void> {
    await this.processLine(
      socket,
      JSON.stringify({ action: "subscribe", deviceId: device.deviceId }),
    );
  }
}

function createHarness() {
  const source = new FakeAndroidSource();
  let onData = (_chunk: Buffer): void => {};
  let onEncodedAccessUnit = (): void => {};
  const server = new TestVideoServer(
    {
      createCaptureSource: async (options) => {
        onData = options.onData;
        onEncodedAccessUnit = options.onEncodedAccessUnit ?? (() => {});
        return source;
      },
      resolveDevice: async () => device,
      nowUs: () => 1_000n,
    },
    "/unused/video-stream.sock",
    new FakeTimer(),
    { authorize: () => {} },
    permissiveDeviceAdmissionGate,
  );
  return {
    server,
    source,
    /** One device packet's bytes, exactly as PersistentEncoderH264Source.onData delivers them. */
    deliver: (packet: Buffer, withBoundary: boolean) => {
      onData(packet);
      if (withBoundary) {
        onEncodedAccessUnit();
      }
    },
  };
}

const nalsOf = (packet: Buffer): Buffer[] => {
  const parser = new H264AnnexBParser();
  return [...parser.push(packet), ...parser.flush()];
};

const PACKET_HEADER_BYTES = 12;

/** NALs a subscriber received: every relay write is one framed packet (12-byte header + Annex-B). */
const receivedNals = (socket: FakeSocket): Buffer[] =>
  socket.written
    .filter((entry): entry is Buffer => Buffer.isBuffer(entry))
    .flatMap((packet) => nalsOf(packet.subarray(PACKET_HEADER_BYTES)));

const hasNal = (socket: FakeSocket, nal: Buffer): boolean =>
  receivedNals(socket).some((received) => received.equals(nal));

describe("VideoStreamSocketServer packet boundaries (issue #10150)", () => {
  const [config, idrPacket, ...pPackets] = capturedH264AsDevicePackets();
  const [sps, pps] = nalsOf(config);
  const idr = nalsOf(idrPacket).find((nal) => nalUnitType(nal) === 5) as Buffer;
  const lastP = nalsOf(pPackets[pPackets.length - 1])[0];

  test("without the boundary signal the newest frame stays buffered (the reported lag)", async () => {
    const { server, deliver } = createHarness();
    const viewer = new FakeSocket();
    await server.subscribe(viewer);

    deliver(config, false);
    deliver(idrPacket, false);
    deliver(pPackets[0], false);
    // Each NAL is released only by the NEXT start code, so the newest packet is withheld.
    expect(hasNal(viewer, idr)).toBe(true);
    expect(hasNal(viewer, nalsOf(pPackets[0])[0])).toBe(false);
    await server.close();
  });

  test("each packet is forwarded the moment it ends, including the last frame of a burst", async () => {
    const { server, deliver } = createHarness();
    const viewer = new FakeSocket();
    await server.subscribe(viewer);

    deliver(config, true);
    expect(hasNal(viewer, sps)).toBe(true);
    expect(hasNal(viewer, pps)).toBe(true);

    deliver(idrPacket, true);
    expect(hasNal(viewer, idr)).toBe(true);

    for (const packet of pPackets) {
      deliver(packet, true);
      // The viewer already has this frame; no later packet was needed.
      expect(hasNal(viewer, nalsOf(packet)[0])).toBe(true);
    }
    expect(hasNal(viewer, lastP)).toBe(true);
    await server.close();
  });

  test("forwarded bytes match the boundary-less stream for the whole captured stream", async () => {
    const boundaryless = createHarness();
    const prompt = createHarness();
    const slow = new FakeSocket();
    const fast = new FakeSocket();
    await boundaryless.server.subscribe(slow);
    await prompt.server.subscribe(fast);

    for (const packet of [config, idrPacket, ...pPackets]) {
      boundaryless.deliver(packet, false);
      prompt.deliver(packet, true);
    }
    // The boundary run delivers every captured NAL, in order, unchanged. The boundary-less run is
    // the same stream minus the final NAL, which it still holds.
    // The only SEI precedes the IDR, so it is skipped for a viewer still waiting for its key frame.
    const expected = [config, idrPacket, ...pPackets]
      .flatMap(nalsOf)
      .filter((nal) => nalUnitType(nal) !== 6)
      .map((nal) => nal.toString("hex"));
    expect(receivedNals(fast).map((nal) => nal.toString("hex"))).toEqual(expected);
    expect(receivedNals(slow).map((nal) => nal.toString("hex"))).toEqual(expected.slice(0, -1));
    await boundaryless.server.close();
    await prompt.server.close();
  });

  test("a late joiner gets the parameter sets and the requested IDR with no further encoder output", async () => {
    const { server, source, deliver } = createHarness();
    const first = new FakeSocket();
    await server.subscribe(first);
    deliver(config, true);
    deliver(idrPacket, true);
    deliver(pPackets[0], true);

    const requestsBeforeJoin = source.keyFrameRequests;
    const late = new FakeSocket();
    await server.subscribe(late);
    // Parameter sets were cached at the config packet's end, so the joiner has them at once.
    expect(hasNal(late, sps)).toBe(true);
    expect(hasNal(late, pps)).toBe(true);
    expect(source.keyFrameRequests).toBeGreaterThan(requestsBeforeJoin);
    expect(hasNal(late, idr)).toBe(false);

    // The device answers the key-frame request with one IDR packet; the static screen then goes quiet.
    deliver(idrPacket, true);
    expect(hasNal(late, idr)).toBe(true);
    await server.close();
  });
});
