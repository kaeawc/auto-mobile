import { createDeviceCaptureRegistry } from "../../src/features/webrtc/deviceCaptureRegistry";
import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import type { H264CaptureSource } from "../../src/features/webrtc/H264CaptureSource";
import { VideoStreamSocketServer } from "../../src/daemon/videoStreamSocketServer";
import { permissiveDeviceAdmissionGate } from "../../src/daemon/deviceAdmissionGate";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";

const device = { deviceId: "emulator-5554", name: "Pixel", platform: "android" } as BootedDevice;
const oldMedia = Buffer.from([
  0, 0, 0, 1, 7, 0x11, 0, 0, 0, 1, 8, 0x12, 0, 0, 0, 1, 5, 0x13, 0, 0, 0, 1, 1, 0x14,
]);
const newMedia = Buffer.from([
  0, 0, 0, 1, 7, 0x21, 0, 0, 0, 1, 8, 0x22, 0, 0, 0, 1, 5, 0x23, 0, 0, 0, 1, 1, 0x24,
]);

class CaptureSource implements H264CaptureSource {
  stopped = false;
  stopCalls = 0;
  keyFrameRequests = 0;
  stopGate: Promise<void> | null = null;
  failNextStop = false;
  async start(): Promise<void> {}
  async stop(): Promise<void> {
    this.stopCalls++;
    if (this.failNextStop) {
      this.failNextStop = false;
      throw new Error("replacement failed");
    }
    await this.stopGate;
    this.stopped = true;
  }
  requestKeyFrame(): boolean {
    this.keyFrameRequests++;
    return true;
  }
}

class TestVideoServer extends VideoStreamSocketServer {
  async subscribe(socket: FakeSocket, hints: Record<string, unknown> = {}): Promise<void> {
    await this.processLine(
      socket,
      JSON.stringify({ action: "subscribe", deviceId: device.deviceId, ...hints }),
    );
  }
}

function packets(socket: FakeSocket): Buffer[] {
  const binary = Buffer.concat(
    socket.written.filter((item): item is Buffer => Buffer.isBuffer(item)),
  );
  const result: Buffer[] = [];
  for (let offset = 12; offset + 12 <= binary.length;) {
    const length = binary.readInt32BE(offset + 8);
    result.push(binary.subarray(offset + 12, offset + 12 + length));
    offset += 12 + length;
  }
  return result;
}

function hasNal(socket: FakeSocket, type: number, marker: number): boolean {
  return packets(socket).some((packet) => packet.includes(Buffer.from([0, 0, 0, 1, type, marker])));
}

function createHarness(resolveDevice: () => Promise<BootedDevice> = async () => device) {
  const timer = new FakeTimer();
  const sources: CaptureSource[] = [];
  const hints: Array<{ quality?: string; fps: number; bitrateBps?: number }> = [];
  const emitters: Array<(chunk: Buffer) => void> = [];
  const server = new TestVideoServer(
    {
      captureRegistry: createDeviceCaptureRegistry(),
      createCaptureSource: async (options) => {
        hints.push({ quality: options.quality, fps: options.fps, bitrateBps: options.bitrateBps });
        emitters.push(options.onData);
        const source = new CaptureSource();
        sources.push(source);
        return source;
      },
      resolveDevice,
      nowUs: () => 1_000n,
    },
    "/unused/video-stream.sock",
    timer,
    { authorize: () => {} },
    permissiveDeviceAdmissionGate,
  );
  return {
    server,
    timer,
    sources,
    hints,
    emit: (index: number, media: Buffer) => emitters[index](media),
  };
}

async function flushSwap(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

async function finishSwap(timer: FakeTimer): Promise<void> {
  timer.advanceTime(200);
  await flushSwap();
}

describe("shared video capture reconfigure priming", () => {
  test("only the changed joiner waits while the original viewer receives old media through debounce", async () => {
    const h = createHarness();
    const a = new FakeSocket();
    await h.server.subscribe(a, { quality: "low" });
    h.emit(0, oldMedia);
    const b = new FakeSocket();
    await h.server.subscribe(b, { quality: "high", fps: 15, bitrateKbps: 6000 });
    const before = packets(a).length;
    h.emit(0, oldMedia);
    expect(packets(a).length).toBeGreaterThan(before);
    expect(packets(b)).toHaveLength(0);
    expect(a.destroyed).toBe(false);
    await finishSwap(h.timer);
    expect(h.sources).toHaveLength(2);
    h.emit(1, newMedia);
    expect(hasNal(b, 7, 0x21)).toBe(true);
    expect(hasNal(b, 8, 0x22)).toBe(true);
    expect(hasNal(b, 5, 0x23)).toBe(true);
    expect(hasNal(b, 7, 0x11)).toBe(false);
    expect(hasNal(a, 5, 0x23)).toBe(true);
    await h.server.close();
  });

  test("unchanged join is primed immediately from the existing configuration cache", async () => {
    const h = createHarness();
    await h.server.subscribe(new FakeSocket(), { quality: "low" });
    h.emit(0, oldMedia);
    const b = new FakeSocket();
    await h.server.subscribe(b, { quality: "low" });
    expect(hasNal(b, 7, 0x11)).toBe(true);
    expect(hasNal(b, 8, 0x12)).toBe(true);
    expect(h.sources).toHaveLength(1);
    await h.server.close();
  });

  test("unchanged join during a pending change also waits for the replacement", async () => {
    const h = createHarness();
    await h.server.subscribe(new FakeSocket(), { quality: "low" });
    h.emit(0, oldMedia);
    const b = new FakeSocket();
    await h.server.subscribe(b, { quality: "high" });
    const c = new FakeSocket();
    await h.server.subscribe(c);
    h.emit(0, oldMedia);
    expect(packets(b)).toHaveLength(0);
    expect(packets(c)).toHaveLength(0);
    await finishSwap(h.timer);
    h.emit(1, newMedia);
    for (const joiner of [b, c]) {
      expect(hasNal(joiner, 7, 0x21)).toBe(true);
      expect(hasNal(joiner, 5, 0x23)).toBe(true);
    }
    await h.server.close();
  });

  test("revert during debounce cancels the swap and immediately primes waiting viewers", async () => {
    const h = createHarness();
    await h.server.subscribe(new FakeSocket(), { quality: "low" });
    h.emit(0, oldMedia);
    const b = new FakeSocket();
    await h.server.subscribe(b, { quality: "high" });
    expect(packets(b)).toHaveLength(0);
    await h.server.subscribe(new FakeSocket(), { quality: "low" });
    expect(hasNal(b, 7, 0x11)).toBe(true);
    expect(hasNal(b, 8, 0x12)).toBe(true);
    await finishSwap(h.timer);
    expect(h.sources).toHaveLength(1);
    await h.server.close();
  });

  test("revert without a cached keyframe requests one from the surviving source", async () => {
    const h = createHarness();
    await h.server.subscribe(new FakeSocket(), { quality: "low" });
    const b = new FakeSocket();
    await h.server.subscribe(b, { quality: "high" });
    const before = h.sources[0].keyFrameRequests;
    await h.server.subscribe(new FakeSocket(), { quality: "low" });
    expect(h.sources[0].keyFrameRequests).toBeGreaterThan(before);
    expect(packets(b)).toHaveLength(0);
    await finishSwap(h.timer);
    expect(h.sources).toHaveLength(1);
    await h.server.close();
  });

  test("several decisions within one debounce window use the latest hints once", async () => {
    const h = createHarness();
    await h.server.subscribe(new FakeSocket(), { quality: "low" });
    await h.server.subscribe(new FakeSocket(), { quality: "high" });
    h.timer.advanceTime(100);
    await h.server.subscribe(new FakeSocket(), { fps: 15 });
    h.timer.advanceTime(100);
    expect(h.sources).toHaveLength(1);
    await h.server.subscribe(new FakeSocket(), { bitrateKbps: 6000 });
    await finishSwap(h.timer);
    expect(h.sources).toHaveLength(2);
    expect(h.hints[1]).toMatchObject({ quality: "high", fps: 15, bitrateBps: 6_000_000 });
    h.timer.advanceTime(200);
    await flushSwap();
    expect(h.sources).toHaveLength(2);
    await h.server.close();
  });

  test("decision during an in-flight swap queues a follow-up for the latest hints", async () => {
    const h = createHarness();
    await h.server.subscribe(new FakeSocket(), { quality: "low" });
    let releaseStop = () => {};
    h.sources[0].stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const b = new FakeSocket();
    await h.server.subscribe(b, { quality: "high" });
    h.timer.advanceTime(200);
    const c = new FakeSocket();
    await h.server.subscribe(c, { quality: "medium" });
    expect(packets(c)).toHaveLength(0);
    releaseStop();
    await flushSwap();
    expect(h.sources).toHaveLength(2);
    await finishSwap(h.timer);
    expect(h.sources).toHaveLength(3);
    expect(h.hints[2].quality).toBe("medium");
    h.emit(2, newMedia);
    expect(hasNal(b, 7, 0x21)).toBe(true);
    expect(hasNal(c, 5, 0x23)).toBe(true);
    expect(hasNal(c, 7, 0x11)).toBe(false);
    await h.server.close();
  });

  test("failed swap closes the capture and leaves no pending replacement", async () => {
    const h = createHarness();
    const a = new FakeSocket();
    await h.server.subscribe(a, { quality: "low" });
    h.sources[0].failNextStop = true;
    const b = new FakeSocket();
    await h.server.subscribe(b, { quality: "high" });
    await finishSwap(h.timer);
    expect(h.server.subscriberCount(device.deviceId)).toBe(0);
    expect(a.destroyed).toBe(true);
    expect(b.destroyed).toBe(true);
    expect(h.sources[0].stopCalls).toBe(2);
    h.timer.advanceTime(200);
    await flushSwap();
    expect(h.sources).toHaveLength(1);
    await h.server.close();
  });

  test("late output from the retired source is neither forwarded nor cached", async () => {
    const h = createHarness();
    const a = new FakeSocket();
    await h.server.subscribe(a, { quality: "low" });
    h.emit(0, oldMedia);
    const b = new FakeSocket();
    await h.server.subscribe(b, { quality: "high" });
    await finishSwap(h.timer);
    const before = packets(a).length;
    h.emit(0, Buffer.from([0, 0, 0, 1, 7, 0x31, 0, 0, 0, 1, 8, 0x32, 0, 0, 0, 1, 1]));
    expect(packets(a)).toHaveLength(before);
    expect(packets(b)).toHaveLength(0);
    const c = new FakeSocket();
    await h.server.subscribe(c);
    expect(packets(c)).toHaveLength(0);
    await h.server.close();
  });

  test("an IDR without replacement config cannot release the gate before the deadline", async () => {
    const h = createHarness();
    await h.server.subscribe(new FakeSocket(), { quality: "low" });
    h.emit(0, oldMedia);
    const b = new FakeSocket();
    await h.server.subscribe(b, { quality: "high" });
    await finishSwap(h.timer);
    h.emit(1, Buffer.from([0, 0, 0, 1, 5, 0x41, 0, 0, 0, 1, 1, 0x42]));
    expect(packets(b)).toHaveLength(0);
    h.timer.advanceTime(15_000);
    await flushSwap();
    expect(b.destroyed).toBe(true);
    expect(h.server.subscriberCount(device.deviceId)).toBe(0);
    await h.server.close();
  });

  test("a change decided while a join resolves cannot replay the old cache", async () => {
    let releaseJoin = () => {};
    const joinGate = new Promise<void>((resolve) => {
      releaseJoin = resolve;
    });
    let resolutions = 0;
    const h = createHarness(async () => {
      resolutions++;
      if (resolutions === 2) {
        await joinGate;
      }
      return device;
    });
    await h.server.subscribe(new FakeSocket(), { quality: "low" });
    h.emit(0, oldMedia);
    const b = new FakeSocket();
    const joining = h.server.subscribe(b);
    await Promise.resolve();
    await h.server.subscribe(new FakeSocket(), { quality: "high" });
    releaseJoin();
    await joining;
    expect(packets(b)).toHaveLength(0);
    await h.server.close();
  });
});
