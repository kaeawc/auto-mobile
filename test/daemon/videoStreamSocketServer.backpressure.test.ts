import { createDeviceCaptureRegistry } from "../../src/features/webrtc/deviceCaptureRegistry";
import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import type { H264CaptureSource } from "../../src/features/webrtc/H264CaptureSource";
import { VideoStreamSocketServer } from "../../src/daemon/videoStreamSocketServer";
import { permissiveDeviceAdmissionGate } from "../../src/daemon/deviceAdmissionGate";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";

const device = { deviceId: "emulator-5554", name: "Pixel", platform: "android" } as BootedDevice;
const stallMs = 50;
const idleGraceMs = 3_000;
const frame = Buffer.from([0, 0, 0, 1, 5, 0x42, 0, 0, 0, 1, 1, 0x33, 0, 0, 0, 1, 1]);

class SubscriberSocket extends FakeSocket {
  blockWrites = false;
  destroyCalls = 0;

  override write(data: string | Buffer): boolean {
    super.write(data);
    return !this.blockWrites;
  }

  override destroy(error?: Error): this {
    this.destroyCalls++;
    return super.destroy(error);
  }
}

class CaptureSource implements H264CaptureSource {
  stopped = false;

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

class TestVideoServer extends VideoStreamSocketServer {
  async subscribe(socket: SubscriberSocket): Promise<void> {
    await this.processLine(
      socket,
      JSON.stringify({ action: "subscribe", deviceId: device.deviceId }),
    );
  }
}

function createHarness(): {
  server: TestVideoServer;
  timer: FakeTimer;
  source: CaptureSource;
  emit: (chunk: Buffer) => void;
} {
  const timer = new FakeTimer();
  const source = new CaptureSource();
  let emit = (_chunk: Buffer): void => {};
  const server = new TestVideoServer(
    {
      captureRegistry: createDeviceCaptureRegistry(),
      createCaptureSource: async ({ onData }) => {
        emit = onData;
        return source;
      },
      resolveDevice: async () => device,
      nowUs: () => 1_000n,
      outboundStallTimeoutMs: stallMs,
    },
    "/unused/video-stream.sock",
    timer,
    { authorize: () => {} },
    permissiveDeviceAdmissionGate,
  );
  return { server, timer, source, emit: (chunk) => emit(chunk) };
}

describe("VideoStreamSocketServer outbound stalls", () => {
  test("a subscriber that never drains is destroyed and its last capture stops", async () => {
    const { server, timer, source, emit } = createHarness();
    const socket = new SubscriberSocket();
    socket.blockWrites = true;
    await server.subscribe(socket);

    emit(frame);
    expect(timer.getPendingTimeouts()).toContain(stallMs);
    timer.advanceTime(stallMs - 1);
    expect(server.subscriberCount(device.deviceId)).toBe(1);
    timer.advanceTime(1);
    expect(socket.destroyCalls).toBe(1);
    expect(server.subscriberCount(device.deviceId)).toBe(0);
    expect(source.stopped).toBe(false);
    expect(timer.getPendingTimeouts()).not.toContain(stallMs);

    timer.advanceTime(idleGraceMs);
    expect(source.stopped).toBe(true);
    await server.close();
  });

  test("a dropped stalled subscriber can subscribe again", async () => {
    const { server, timer, emit } = createHarness();
    const stalled = new SubscriberSocket();
    stalled.blockWrites = true;
    await server.subscribe(stalled);

    emit(frame);
    timer.advanceTime(stallMs);
    expect(stalled.destroyCalls).toBe(1);
    expect(server.subscriberCount(device.deviceId)).toBe(0);

    const replacement = new SubscriberSocket();
    await server.subscribe(replacement);
    expect(server.subscriberCount(device.deviceId)).toBe(1);
    const responses = replacement.written
      .filter((data): data is string => typeof data === "string")
      .map((data) => JSON.parse(data) as { success: boolean });
    expect(responses).toHaveLength(1);
    expect(responses[0]?.success).toBe(true);
    expect(replacement.destroyed).toBe(false);

    const before = replacement.written.length;
    emit(frame);
    expect(replacement.written.length).toBeGreaterThan(before);
    await server.close();
  });

  test("draining before the deadline cancels the stall timer", async () => {
    const { server, timer, source, emit } = createHarness();
    const socket = new SubscriberSocket();
    socket.blockWrites = true;
    await server.subscribe(socket);

    emit(frame);
    timer.advanceTime(stallMs - 1);
    socket.blockWrites = false;
    socket.emit("drain");
    expect(timer.getPendingTimeouts()).not.toContain(stallMs);
    timer.advanceTime(stallMs + 1);

    expect(socket.destroyCalls).toBe(0);
    expect(server.subscriberCount(device.deviceId)).toBe(1);
    expect(source.stopped).toBe(false);
    await server.close();
  });

  test("a healthy subscriber keeps receiving after a stalled peer is detached", async () => {
    const { server, timer, source, emit } = createHarness();
    const stalled = new SubscriberSocket();
    stalled.blockWrites = true;
    const healthy = new SubscriberSocket();
    await server.subscribe(stalled);
    await server.subscribe(healthy);

    emit(frame);
    timer.advanceTime(stallMs);
    expect(stalled.destroyCalls).toBe(1);
    expect(server.subscriberCount(device.deviceId)).toBe(1);
    expect(source.stopped).toBe(false);

    const before = healthy.written.length;
    emit(frame);
    expect(healthy.written.length).toBeGreaterThan(before);
    expect(source.stopped).toBe(false);
    await server.close();
  });
});
