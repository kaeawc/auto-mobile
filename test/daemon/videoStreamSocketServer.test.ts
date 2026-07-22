import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultTimer } from "../../src/utils/SystemTimer";
import type { BootedDevice } from "../../src/models";
import type { H264CaptureSource } from "../../src/features/webrtc/H264CaptureSource";
import { VideoStreamSocketServer } from "../../src/daemon/videoStreamSocketServer";
import { CODEC_ID_H264 } from "../../src/daemon/videoStreamFraming";

const DEVICE: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
} as BootedDevice;

/** A capture source that never touches adb; tests push chunks by hand. */
class FakeCaptureSource implements H264CaptureSource {
  started = false;
  stopped = false;
  startError: Error | null = null;

  async start(): Promise<void> {
    if (this.startError) {
      throw this.startError;
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

interface Harness {
  server: VideoStreamSocketServer;
  socketPath: string;
  sources: FakeCaptureSource[];
  emit: (chunk: Buffer) => void;
  cleanup: () => Promise<void>;
}

const harnesses: Harness[] = [];

async function startHarness(
  options: { startError?: Error; resolveError?: Error } = {}
): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "amvs-"));
  const socketPath = path.join(dir, "video-stream.sock");
  const sources: FakeCaptureSource[] = [];
  let onData: ((chunk: Buffer) => void) | null = null;

  const server = new VideoStreamSocketServer(
    {
      resolveDevice: async () => {
        if (options.resolveError) {
          throw options.resolveError;
        }
        return DEVICE;
      },
      createCaptureSource: async opts => {
        onData = opts.onData;
        const source = new FakeCaptureSource();
        source.startError = options.startError ?? null;
        sources.push(source);
        return source;
      },
      nowUs: () => 1_000n,
    },
    socketPath
  );
  await server.start();

  const harness: Harness = {
    server,
    socketPath,
    sources,
    emit: chunk => onData?.(chunk),
    cleanup: async () => {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  harnesses.push(harness);
  return harness;
}

/** Connects, subscribes, and resolves with the ack line plus a reader for subsequent binary. */
async function subscribe(
  socketPath: string,
  request: Record<string, unknown> = { action: "subscribe", deviceId: DEVICE.deviceId }
): Promise<{ socket: net.Socket; ack: Record<string, unknown>; binary: () => Buffer }> {
  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });

  const chunks: Buffer[] = [];
  socket.on("data", data => chunks.push(data));
  socket.write(`${JSON.stringify(request)}\n`);

  // Wait for the newline-terminated acknowledgement.
  const deadline = Date.now() + 2000;
  let ackLine = "";
  while (Date.now() < deadline) {
    const combined = Buffer.concat(chunks);
    const newlineIndex = combined.indexOf(0x0a);
    if (newlineIndex !== -1) {
      ackLine = combined.subarray(0, newlineIndex).toString("utf8");
      // Keep whatever followed the ack for binary assertions.
      const rest = combined.subarray(newlineIndex + 1);
      chunks.length = 0;
      if (rest.length > 0) {
        chunks.push(rest);
      }
      break;
    }
    await defaultTimer.sleep(10);
  }

  return {
    socket,
    ack: ackLine ? (JSON.parse(ackLine) as Record<string, unknown>) : {},
    binary: () => Buffer.concat(chunks),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await defaultTimer.sleep(10);
  }
  throw new Error("Timed out waiting for condition");
}

afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()?.cleanup();
  }
});

describe("VideoStreamSocketServer", () => {
  test("acknowledges a subscribe and announces the framing", async () => {
    const h = await startHarness();

    const { ack } = await subscribe(h.socketPath);

    expect(ack.success).toBe(true);
    expect(ack.type).toBe("video_stream_response");
    expect(ack.deviceId).toBe(DEVICE.deviceId);
    expect(ack.framing).toBe("h264");
  });

  test("sends the stream header immediately after the ack", async () => {
    const h = await startHarness();

    const { binary } = await subscribe(h.socketPath);
    await waitFor(() => binary().length >= 12);

    const header = binary().subarray(0, 12);
    expect(header.readInt32BE(0)).toBe(CODEC_ID_H264);
  });

  test("starts exactly one capture and forwards framed packets", async () => {
    const h = await startHarness();
    const { binary } = await subscribe(h.socketPath);
    await waitFor(() => binary().length >= 12);

    h.emit(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x01, 0xaa, 0xbb, 0x00, 0x00, 0x00, 0x01, 0x01]));
    await waitFor(() => binary().length > 12);

    expect(h.sources).toHaveLength(1);
    expect(h.sources[0].started).toBe(true);

    const packet = binary().subarray(12);
    expect(packet.readInt32BE(8)).toBe(7); // payload length
    expect(packet.subarray(12, 19)).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x01, 0xaa, 0xbb]));
  });

  test("does not mistake arbitrary source chunks for complete H.264 NAL units", async () => {
    const h = await startHarness();
    const { binary } = await subscribe(h.socketPath);
    await waitFor(() => binary().length >= 12);

    h.emit(Buffer.from([0x00, 0x00]));
    h.emit(Buffer.from([0x00, 0x01, 0x05, 0xaa, 0xbb, 0x00, 0x00, 0x00, 0x01, 0x01]));
    await waitFor(() => binary().length > 12);

    const packet = binary().subarray(12);
    expect(packet.readInt32BE(8)).toBe(7);
    expect(packet.subarray(12, 19)).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x05, 0xaa, 0xbb]));
    expect(packet.readBigInt64BE(0) & (1n << 62n)).toBe(1n << 62n); // IDR sets key-frame.
  });

  test("a second viewer of the same device shares the capture", async () => {
    const h = await startHarness();

    await subscribe(h.socketPath);
    await waitFor(() => h.server.subscriberCount(DEVICE.deviceId) === 1);
    await subscribe(h.socketPath);
    await waitFor(() => h.server.subscriberCount(DEVICE.deviceId) === 2);

    expect(h.sources).toHaveLength(1);
  });

  test("uses the shared capture dimensions for every viewer", async () => {
    const h = await startHarness();
    await subscribe(h.socketPath, {
      action: "subscribe",
      deviceId: DEVICE.deviceId,
      size: { width: 640, height: 360 },
    });
    const later = await subscribe(h.socketPath, {
      action: "subscribe",
      deviceId: DEVICE.deviceId,
      size: { width: 1920, height: 1080 },
    });
    await waitFor(() => later.binary().length >= 12);

    expect(later.binary().readInt32BE(4)).toBe(640);
    expect(later.binary().readInt32BE(8)).toBe(360);
  });

  test("both viewers receive the same packet", async () => {
    const h = await startHarness();
    const first = await subscribe(h.socketPath);
    const second = await subscribe(h.socketPath);
    await waitFor(() => first.binary().length >= 12 && second.binary().length >= 12);

    h.emit(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x05, 0x42, 0x00, 0x00, 0x00, 0x01, 0x01]));
    await waitFor(() => first.binary().length > 12 && second.binary().length > 12);

    expect(first.binary().subarray(12)).toEqual(second.binary().subarray(12));
  });

  test("the capture stops only when the last viewer leaves", async () => {
    const h = await startHarness();
    const first = await subscribe(h.socketPath);
    const second = await subscribe(h.socketPath);
    await waitFor(() => h.server.subscriberCount(DEVICE.deviceId) === 2);

    first.socket.destroy();
    await waitFor(() => h.server.subscriberCount(DEVICE.deviceId) === 1);
    expect(h.sources[0].stopped).toBe(false);

    second.socket.destroy();
    await waitFor(() => h.server.activeDeviceIds().length === 0);
    expect(h.sources[0].stopped).toBe(true);
  });

  test("a late joiner is replayed the parameter sets", async () => {
    const h = await startHarness();
    await subscribe(h.socketPath);
    await waitFor(() => h.server.subscriberCount(DEVICE.deviceId) === 1);

    // SPS arrives before the second viewer connects.
    const sps = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x07, 0x64, 0x00]);
    h.emit(Buffer.concat([sps, Buffer.from([0x00, 0x00, 0x00, 0x01, 0x08])]));

    const late = await subscribe(h.socketPath);
    await waitFor(() => late.binary().length > 12);

    // Header, then a replayed CONFIG packet carrying the SPS.
    const packet = late.binary().subarray(12);
    expect(packet.readInt32BE(8)).toBe(sps.length);
    expect(packet.subarray(12, 12 + sps.length)).toEqual(sps);
    expect(packet.readBigInt64BE(0)).toBeLessThan(0n); // CONFIG flag is bit 63
  });

  test("a failed capture start is reported and starts nothing", async () => {
    const h = await startHarness({ startError: new Error("adb: device offline") });

    const { ack } = await subscribe(h.socketPath);

    expect(ack.success).toBe(false);
    expect(String(ack.error)).toContain("adb: device offline");
    expect(h.server.activeDeviceIds()).toHaveLength(0);
  });

  test("an unresolvable device is reported without starting a capture", async () => {
    const h = await startHarness({ resolveError: new Error("No devices connected") });

    const { ack } = await subscribe(h.socketPath);

    expect(ack.success).toBe(false);
    expect(String(ack.error)).toContain("No devices connected");
    expect(h.sources).toHaveLength(0);
  });

  test("an unknown action is rejected by name", async () => {
    const h = await startHarness();

    const { ack } = await subscribe(h.socketPath, { action: "teleport" });

    expect(ack.success).toBe(false);
    expect(String(ack.error)).toContain("teleport");
  });

  test("malformed JSON is rejected rather than crashing the server", async () => {
    const h = await startHarness();
    const socket = net.createConnection(h.socketPath);
    await new Promise<void>(resolve => socket.once("connect", () => resolve()));

    const chunks: Buffer[] = [];
    socket.on("data", data => chunks.push(data));
    socket.write("{not json\n");
    await waitFor(() => Buffer.concat(chunks).includes("\n"));

    expect(Buffer.concat(chunks).toString()).toContain("Invalid JSON");
    // The server is still serving.
    const { ack } = await subscribe(h.socketPath);
    expect(ack.success).toBe(true);
  });

  test("close stops every capture", async () => {
    const h = await startHarness();
    await subscribe(h.socketPath);
    await waitFor(() => h.server.activeDeviceIds().length === 1);

    await h.server.close();

    expect(h.sources[0].stopped).toBe(true);
    expect(h.server.activeDeviceIds()).toHaveLength(0);
  });
});
