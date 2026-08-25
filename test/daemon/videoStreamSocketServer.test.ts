import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { connectBounded } from "./helpers/socketRequest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultTimer, type Timer } from "../../src/utils/SystemTimer";
import { FakeTimer } from "../fakes/FakeTimer";
import type { BootedDevice } from "../../src/models";
import type { H264CaptureSource } from "../../src/features/webrtc/H264CaptureSource";
import { VideoStreamSocketServer } from "../../src/daemon/videoStreamSocketServer";
import { ScreenRecordingPermissionError } from "../../src/features/webrtc";
import {
  SessionScopedStreamAuthenticator,
  type StreamAuthSessionManager,
  type StreamSocketAuthenticator,
} from "../../src/daemon/streamSocketAuth";
import { CODEC_ID_H264 } from "../../src/daemon/videoStreamFraming";
import { SIMULATOR_FPS_DEFAULT } from "../../src/features/screen-stream/IOSScreenCaptureHelper";
import { WEBRTC_IOS_SIMULATOR_FPS_DEFAULT } from "../../src/features/webrtc/webrtcStreamingConfig";

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
  startGate: Promise<void> | null = null;
  onStart: (() => void) | null = null;
  keyFrameRequests = 0;
  // When > 0, requestKeyFrame() reports the source is throttling (returns false) this many times
  // before it honors one — modeling the real Android/iOS key-frame rate limiter.
  keyFrameRejectionsRemaining = 0;

  async start(): Promise<void> {
    await this.startGate;
    this.onStart?.();
    if (this.startError) {
      throw this.startError;
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  requestKeyFrame(): boolean {
    this.keyFrameRequests++;
    if (this.keyFrameRejectionsRemaining > 0) {
      this.keyFrameRejectionsRemaining--;
      return false;
    }
    return true;
  }
}

interface Harness {
  server: VideoStreamSocketServer;
  socketPath: string;
  sources: FakeCaptureSource[];
  captureOptions: Array<{ fps?: number; quality?: string }>;
  emit: (chunk: Buffer) => void;
  /** Simulates the source attesting a display rotation (issue #4786). */
  emitRotation: (rotation: number) => void;
  /** Simulates a cumulative encoder-side dropped-frame measurement. */
  emitDroppedFrames: (droppedFrames: number) => void;
  cleanup: () => Promise<void>;
}

const harnesses: Harness[] = [];

/** Accepts every request; auth enforcement is exercised in dedicated tests below. */
const allowAllAuthenticator: StreamSocketAuthenticator = { authorize: () => {} };

async function startHarness(
  options: {
    startError?: Error;
    startGate?: Promise<void>;
    startData?: Buffer;
    resolveError?: Error;
    authenticator?: StreamSocketAuthenticator;
    timer?: Timer;
    /** Pre-arms each created source to throttle this many key-frame requests. */
    keyFrameRejections?: number;
  } = {},
): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "amvs-"));
  const socketPath = path.join(dir, "video-stream.sock");
  const sources: FakeCaptureSource[] = [];
  let onData: ((chunk: Buffer) => void) | null = null;
  let onRotation: ((rotation: number) => void) | null = null;
  let onDroppedFrames: ((droppedFrames: number) => void) | null = null;
  const captureOptions: Array<{ fps?: number; quality?: string }> = [];

  const server = new VideoStreamSocketServer(
    {
      resolveDevice: async () => {
        if (options.resolveError) {
          throw options.resolveError;
        }
        return DEVICE;
      },
      createCaptureSource: async (opts) => {
        onData = opts.onData;
        onRotation = opts.onRotation ?? null;
        onDroppedFrames = opts.onDroppedFrames ?? null;
        captureOptions.push(opts);
        const source = new FakeCaptureSource();
        source.startError = options.startError ?? null;
        source.startGate = options.startGate ?? null;
        source.keyFrameRejectionsRemaining = options.keyFrameRejections ?? 0;
        source.onStart = () => {
          if (options.startData) {
            onData?.(options.startData);
          }
        };
        sources.push(source);
        return source;
      },
      nowUs: () => 1_000n,
    },
    socketPath,
    options.timer ?? defaultTimer,
    options.authenticator ?? allowAllAuthenticator,
  );
  await server.start();

  const harness: Harness = {
    server,
    socketPath,
    sources,
    captureOptions,
    emit: (chunk) => onData?.(chunk),
    emitRotation: (rotation) => onRotation?.(rotation),
    emitDroppedFrames: (droppedFrames) => onDroppedFrames?.(droppedFrames),
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
  request: Record<string, unknown> = { action: "subscribe", deviceId: DEVICE.deviceId },
): Promise<{ socket: net.Socket; ack: Record<string, unknown>; binary: () => Buffer }> {
  const socket = new net.Socket();
  await connectBounded(socket, socketPath);

  const chunks: Buffer[] = [];
  socket.on("data", (data) => chunks.push(data));
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

  test("pins the observation capture rate rather than inheriting the WebRTC default", async () => {
    const h = await startHarness();

    await subscribe(h.socketPath);

    // This relay borrows the WebRTC capture sources. Leaving fps unset would
    // silently adopt whatever the interactive WHEP default happens to be.
    expect(h.captureOptions[0].fps).toBe(SIMULATOR_FPS_DEFAULT);
    expect(SIMULATOR_FPS_DEFAULT).not.toBe(WEBRTC_IOS_SIMULATOR_FPS_DEFAULT);
  });

  test("forwards client quality and fps hints to the capture source", async () => {
    const h = await startHarness();

    // A farm viewer lowers per-stream decode cost by requesting a preset and
    // rate; the client hint must win over the pinned observation default.
    await subscribe(h.socketPath, {
      action: "subscribe",
      deviceId: DEVICE.deviceId,
      quality: "low",
      fps: 15,
    });

    expect(h.captureOptions[0].quality).toBe("low");
    expect(h.captureOptions[0].fps).toBe(15);
  });

  test("refuses a subscribe carrying an unknown quality instead of NaN-ing the capture", async () => {
    const h = await startHarness();

    const { ack } = await subscribe(h.socketPath, {
      action: "subscribe",
      deviceId: DEVICE.deviceId,
      quality: "ultra",
    });

    expect(ack.success).toBe(false);
    expect(String(ack.error)).toContain('Unsupported quality "ultra"');
    expect(h.captureOptions).toHaveLength(0);
  });

  test("refuses non-positive or absurd fps and bitrate hints", async () => {
    const h = await startHarness();

    const zeroFps = await subscribe(h.socketPath, {
      action: "subscribe",
      deviceId: DEVICE.deviceId,
      fps: 0,
    });
    expect(zeroFps.ack.success).toBe(false);
    expect(String(zeroFps.ack.error)).toContain("Invalid fps");

    const negativeBitrate = await subscribe(h.socketPath, {
      action: "subscribe",
      deviceId: DEVICE.deviceId,
      bitrateKbps: -5,
    });
    expect(negativeBitrate.ack.success).toBe(false);
    expect(String(negativeBitrate.ack.error)).toContain("Invalid bitrateKbps");

    expect(h.captureOptions).toHaveLength(0);
  });

  test("refuses a malformed size hint", async () => {
    const h = await startHarness();

    const { ack } = await subscribe(h.socketPath, {
      action: "subscribe",
      deviceId: DEVICE.deviceId,
      size: { width: 0, height: "tall" },
    });

    expect(ack.success).toBe(false);
    expect(String(ack.error)).toContain("Invalid size");
    expect(h.captureOptions).toHaveLength(0);
  });

  test("refuses an fps outside the backends' shared 5-60 range", async () => {
    const h = await startHarness();

    // 2 fps passes a naive positivity check but throws at iOS Simulator capture
    // (the helper enforces [5, 60]); 90 fps exceeds every backend.
    for (const fps of [2, 90]) {
      const { ack } = await subscribe(h.socketPath, {
        action: "subscribe",
        deviceId: DEVICE.deviceId,
        fps,
      });
      expect(ack.success).toBe(false);
      expect(String(ack.error)).toContain("Invalid fps");
    }
    expect(h.captureOptions).toHaveLength(0);
  });

  test("refuses a bitrate that would lose integer precision after the kbps->bps conversion", async () => {
    const h = await startHarness();

    // A huge-but-finite kbps passes Number.isInteger yet overflows past
    // MAX_SAFE_INTEGER once multiplied by 1000 downstream.
    const { ack } = await subscribe(h.socketPath, {
      action: "subscribe",
      deviceId: DEVICE.deviceId,
      bitrateKbps: 9_000_000_000_000,
    });
    expect(ack.success).toBe(false);
    expect(String(ack.error)).toContain("Invalid bitrateKbps");
    expect(h.captureOptions).toHaveLength(0);
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

    h.emit(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x05, 0xaa, 0xbb, 0x00, 0x00, 0x00, 0x01, 0x01]));
    await waitFor(() => binary().length > 12);

    expect(h.sources).toHaveLength(1);
    expect(h.sources[0].started).toBe(true);

    const packet = binary().subarray(12);
    expect(packet.readInt32BE(8)).toBe(7); // payload length
    expect(packet.subarray(12, 19)).toEqual(
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x05, 0xaa, 0xbb]),
    );
  });

  test("relays cumulative encoder drops as a zero-payload telemetry packet", async () => {
    const h = await startHarness();
    const { binary } = await subscribe(h.socketPath);
    await waitFor(() => binary().length >= 12);

    h.emitDroppedFrames(42);
    await waitFor(() => binary().length >= 24);

    const packet = binary().subarray(12, 24);
    expect(packet.readBigInt64BE(0) & ((1n << 61n) - 1n)).toBe(42n);
    expect(packet.readBigInt64BE(0) & (1n << 61n)).toBe(1n << 61n);
    expect(packet.readInt32BE(8)).toBe(0);
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
    expect(packet.subarray(12, 19)).toEqual(
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x05, 0xaa, 0xbb]),
    );
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

  test("keeps startup media behind every pending subscriber acknowledgement", async () => {
    let releaseStart: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const h = await startHarness({
      startGate,
      // Two NALs flush the IDR through the incremental parser while start() is still pending.
      startData: Buffer.from([0, 0, 0, 1, 0x05, 0xaa, 0xbb, 0, 0, 0, 1, 0x01]),
    });

    const first = subscribe(h.socketPath);
    await waitFor(() => h.sources.length === 1);
    const second = subscribe(h.socketPath);
    await waitFor(() => h.server.subscriberCount(DEVICE.deviceId) === 2);
    releaseStart!();

    const responses = await Promise.all([first, second]);
    for (const response of responses) {
      expect(response.ack.success).toBe(true);
      await waitFor(() => response.binary().length >= 12);
      expect(response.binary().readInt32BE(0)).toBe(CODEC_ID_H264);
    }
  });

  test("gates the initial subscriber until a post-ack keyframe after startup media", async () => {
    const sps = Buffer.from([0, 0, 0, 1, 0x07, 0x64]);
    const pps = Buffer.from([0, 0, 0, 1, 0x08, 0xee]);
    const startupIdr = Buffer.from([0, 0, 0, 1, 0x05, 0xaa]);
    const interFrame = Buffer.from([0, 0, 0, 1, 0x01, 0xbb]);
    const freshIdr = Buffer.from([0, 0, 0, 1, 0x05, 0xcc]);
    const h = await startHarness({
      // All three NALs flush during source.start(), before the acknowledgement is written.
      startData: Buffer.concat([sps, pps, startupIdr, Buffer.from([0, 0, 0, 1, 0x01])]),
    });

    const client = await subscribe(h.socketPath);
    await waitFor(() => client.binary().length >= 12);

    expect(h.sources[0].keyFrameRequests).toBe(1);
    expect(client.binary().includes(startupIdr)).toBe(false);

    h.emit(Buffer.concat([interFrame, freshIdr, Buffer.from([0, 0, 0, 1, 0x01])]));
    await waitFor(() => client.binary().includes(freshIdr));

    expect(client.binary().includes(interFrame)).toBe(false);
  });

  test("stops a capture source that resolves after its only subscriber disconnects", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "amvs-late-source-"));
    const socketPath = path.join(dir, "video-stream.sock");
    const source = new FakeCaptureSource();
    let resolveSource: ((source: H264CaptureSource) => void) | undefined;
    const sourceCreated = new Promise<void>((resolve) => {
      const server = new VideoStreamSocketServer(
        {
          resolveDevice: async () => DEVICE,
          createCaptureSource: async () => {
            resolve();
            return await new Promise<H264CaptureSource>((sourceResolve) => {
              resolveSource = sourceResolve;
            });
          },
          nowUs: () => 1_000n,
        },
        socketPath,
        defaultTimer,
        allowAllAuthenticator,
      );
      void server.start().then(() => {
        harnesses.push({
          server,
          socketPath,
          sources: [source],
          emit: () => {},
          emitRotation: () => {},
          cleanup: async () => {
            await server.close();
            rmSync(dir, { recursive: true, force: true });
          },
        });
      });
    });

    await waitFor(() => harnesses.some((h) => h.socketPath === socketPath));
    const harness = harnesses.find((h) => h.socketPath === socketPath)!;
    const socket = new net.Socket();
    await connectBounded(socket, socketPath);
    socket.write(`${JSON.stringify({ action: "subscribe", deviceId: DEVICE.deviceId })}\n`);
    await sourceCreated;
    socket.destroy();
    await waitFor(() => harness.server.activeDeviceIds().length === 0);
    resolveSource?.(source);

    await waitFor(() => source.stopped);
    expect(source.started).toBe(false);
  });

  test("keeps a replacement capture when an abandoned startup later fails", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "amvs-replacement-capture-"));
    const socketPath = path.join(dir, "video-stream.sock");
    const abandonedSource = new FakeCaptureSource();
    const replacementSource = new FakeCaptureSource();
    let resolveAbandonedSource: ((source: H264CaptureSource) => void) | undefined;
    let sourceCalls = 0;
    const server = new VideoStreamSocketServer(
      {
        resolveDevice: async () => DEVICE,
        createCaptureSource: async () => {
          sourceCalls++;
          if (sourceCalls === 1) {
            return await new Promise<H264CaptureSource>((resolve) => {
              resolveAbandonedSource = resolve;
            });
          }
          return replacementSource;
        },
        nowUs: () => 1_000n,
      },
      socketPath,
      defaultTimer,
      allowAllAuthenticator,
    );
    await server.start();
    harnesses.push({
      server,
      socketPath,
      sources: [abandonedSource, replacementSource],
      emit: () => {},
      emitRotation: () => {},
      cleanup: async () => {
        await server.close();
        rmSync(dir, { recursive: true, force: true });
      },
    });

    const abandonedSocket = new net.Socket();
    await connectBounded(abandonedSocket, socketPath);
    abandonedSocket.write(
      `${JSON.stringify({ action: "subscribe", deviceId: DEVICE.deviceId })}\n`,
    );
    await waitFor(() => resolveAbandonedSource !== undefined);
    abandonedSocket.destroy();
    await waitFor(() => server.activeDeviceIds().length === 0);

    const replacement = await subscribe(socketPath);
    expect(replacement.ack.success).toBe(true);
    expect(server.activeDeviceIds()).toEqual([DEVICE.deviceId]);

    resolveAbandonedSource?.(abandonedSource);
    await waitFor(() => abandonedSource.stopped);
    expect(server.activeDeviceIds()).toEqual([DEVICE.deviceId]);
    expect(server.subscriberCount(DEVICE.deviceId)).toBe(1);
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

  test("attests the source's rotation on a config packet and its replay (issue #4786)", async () => {
    const ROTATION_PRESENT = 1n << 61n;
    const ROTATION_SHIFT = 59n;
    const h = await startHarness();
    const first = await subscribe(h.socketPath);
    await waitFor(() => first.binary().length >= 12);

    // The source attests rotation 3, then emits SPS: the config packet must carry it.
    h.emitRotation(3);
    const sps = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x07, 0x64, 0x00]);
    h.emit(Buffer.concat([sps, Buffer.from([0x00, 0x00, 0x00, 0x01, 0x08])]));
    await waitFor(() => first.binary().length > 12);

    const flags = BigInt.asUintN(64, first.binary().subarray(12).readBigInt64BE(0));
    expect(flags & ROTATION_PRESENT).toBe(ROTATION_PRESENT);
    expect((flags >> ROTATION_SHIFT) & 0b11n).toBe(3n);

    // A late joiner is replayed the parameter sets and must see the current rotation there too.
    const late = await subscribe(h.socketPath);
    await waitFor(() => late.binary().length > 12);
    const replayFlags = BigInt.asUintN(64, late.binary().subarray(12).readBigInt64BE(0));
    expect(replayFlags & ROTATION_PRESENT).toBe(ROTATION_PRESENT);
    expect((replayFlags >> ROTATION_SHIFT) & 0b11n).toBe(3n);
  });

  test("leaves the rotation-present bit clear when the source never attests rotation", async () => {
    const ROTATION_PRESENT = 1n << 61n;
    const h = await startHarness();
    const client = await subscribe(h.socketPath);
    await waitFor(() => client.binary().length >= 12);

    // No emitRotation call: a screenrecord/iOS source. The config packet must not claim a rotation.
    // The trailing start code flushes the SPS NAL through the incremental Annex-B parser.
    h.emit(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x07, 0x64, 0x00, 0x00, 0x00, 0x00, 0x01, 0x08]));
    await waitFor(() => client.binary().length > 12);

    const flags = BigInt.asUintN(64, client.binary().subarray(12).readBigInt64BE(0));
    expect(flags & ROTATION_PRESENT).toBe(0n);
  });

  test("forwards a PPS that arrives after a late viewer's replayed SPS", async () => {
    const h = await startHarness();
    await subscribe(h.socketPath);
    const sps = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x07, 0x64]);
    const pps = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x08, 0xee]);
    const idr = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x05, 0xaa]);
    h.emit(Buffer.concat([sps, pps]));

    const late = await subscribe(h.socketPath);
    h.emit(Buffer.concat([idr, Buffer.from([0x00, 0x00, 0x00, 0x01, 0x01])]));
    await waitFor(() => late.binary().includes(pps) && late.binary().includes(idr));

    expect(late.binary().includes(pps)).toBe(true);
    expect(late.binary().includes(idr)).toBe(true);
  });

  test("a drained backpressured subscriber is handed an immediate key frame, not a GOP-long freeze", async () => {
    const h = await startHarness();
    const client = await subscribe(h.socketPath);
    await waitFor(() => h.sources.length > 0);
    const source = h.sources[0];

    // A fresh subscriber starts waiting-for-key-frame, so inter frames are skipped until an IDR
    // arrives. Send one so the subscriber is actually streaming and the inter-frame flood below can
    // reach write() and trigger backpressure.
    h.emit(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x05, 0xaa, 0x00, 0x00, 0x00, 0x01, 0x01]));
    await waitFor(() => client.binary().includes(Buffer.from([0x05, 0xaa])));

    // Stop reading so the server's write buffer fills and the subscriber is marked "behind".
    client.socket.pause();

    // Emit far more than any socket high-water mark, as large inter (non-key) frames, so a
    // write() reports backpressure and the subscriber is parked waiting for the next key frame.
    // Each NAL is flushed by the leading start code of the following emit; a trailing start code
    // flushes the last.
    const frame = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x01]),
      Buffer.alloc(64 * 1024, 0xab),
    ]);
    for (let i = 0; i < 40; i++) {
      h.emit(frame);
    }
    h.emit(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x01]));

    // Baseline AFTER the subscribe-time IDR request: while the subscriber is still stuck (no drain
    // yet) the count must not climb further.
    const before = source.keyFrameRequests;

    // Resume reading: the socket drains, and the drain handler asks the encoder for an immediate IDR
    // rather than leaving this subscriber frozen until the next natural key frame (a whole GOP away).
    client.socket.resume();
    await waitFor(() => source.keyFrameRequests > before);

    expect(source.keyFrameRequests).toBeGreaterThan(before);
  });

  test("a key frame throttled at subscribe time is retried until the source honors one", async () => {
    // The subscribe-ack path asks the source for an immediate IDR so a (re)joining subscriber never
    // starts on an undecodable inter-frame. When that request lands inside the source's throttle
    // window (~3s on Android/raw-iOS) a bare call is silently rejected and the subscriber sits in
    // waitingForKeyFrame until the natural GOP — the frozen-pane-on-reconnect symptom. The retrying
    // helper must keep asking through the injected timer until the source honors one.
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const h = await startHarness({ timer: fakeTimer, keyFrameRejections: 2 });
    await subscribe(h.socketPath);
    await waitFor(() => h.sources.length > 0);
    const source = h.sources[0];

    // 2 throttled attempts + the honored one. Without the retry the count would stay at 1.
    await waitFor(() => source.keyFrameRequests >= 3);
    expect(source.keyFrameRejectionsRemaining).toBe(0);
  });

  test("a key frame throttled at drain time is retried until the source honors one", async () => {
    // The real capture sources rate-limit key-frame requests (Android + raw iOS ~3s, encoded iOS
    // ~500ms), so a drain landing inside that window gets a `false` from requestKeyFrame(). Without
    // a retry the subscriber stays in waitingForKeyFrame and drops every inter frame until the
    // natural GOP — the multi-second freeze this recovery exists to prevent. Auto-advance lets the
    // injected timer's retries fire promptly.
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const h = await startHarness({ timer: fakeTimer });
    const client = await subscribe(h.socketPath);
    await waitFor(() => h.sources.length > 0);
    const source = h.sources[0];

    // Get the subscriber actually streaming (as in the drain test above).
    h.emit(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x05, 0xaa, 0x00, 0x00, 0x00, 0x01, 0x01]));
    await waitFor(() => client.binary().includes(Buffer.from([0x05, 0xaa])));

    // Throttle the NEXT two key-frame requests before the source honors one. Set after the
    // subscribe-time request so only the drain-recovery path meets the throttle.
    source.keyFrameRejectionsRemaining = 2;
    const before = source.keyFrameRequests;

    // Backpressure, then drain the subscriber.
    client.socket.pause();
    const frame = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x01]),
      Buffer.alloc(64 * 1024, 0xab),
    ]);
    for (let i = 0; i < 40; i++) {
      h.emit(frame);
    }
    h.emit(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x01]));
    client.socket.resume();

    // The drain handler's first request is rejected; the timer-driven retries keep asking until the
    // source finally honors one — 2 rejections + 1 success — instead of leaving playback frozen.
    await waitFor(() => source.keyFrameRequests >= before + 3);
    expect(source.keyFrameRejectionsRemaining).toBe(0);
  });

  test("a failed capture start is reported and starts nothing", async () => {
    const h = await startHarness({ startError: new Error("adb: device offline") });

    const { ack } = await subscribe(h.socketPath);

    expect(ack.success).toBe(false);
    expect(String(ack.error)).toContain("adb: device offline");
    expect(h.server.activeDeviceIds()).toHaveLength(0);
  });

  test("reports a Screen Recording denial as structured permission state with a legacy fallback", async () => {
    const h = await startHarness({ startError: new ScreenRecordingPermissionError() });

    const { ack } = await subscribe(h.socketPath);

    expect(ack.success).toBe(false);
    expect(ack.permission).toEqual({
      kind: "screen_recording",
      status: "needs_approval",
      approvalTarget: "AutoMobile",
    });
    expect(ack.error).toBe(
      "Screen Recording permission is required to discover and observe iOS Simulator windows.",
    );
    expect(h.server.activeDeviceIds()).toHaveLength(0);
  });

  test("reports a pending Screen Recording denial to every subscriber", async () => {
    let releaseStart: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const h = await startHarness({
      startError: new ScreenRecordingPermissionError(),
      startGate,
    });

    const first = subscribe(h.socketPath);
    await waitFor(() => h.sources.length === 1);
    const second = subscribe(h.socketPath);
    await waitFor(() => h.server.subscriberCount(DEVICE.deviceId) === 2);
    releaseStart!();

    const responses = await Promise.all([first, second]);
    for (const { ack } of responses) {
      expect(ack.success).toBe(false);
      expect(ack.permission).toEqual({
        kind: "screen_recording",
        status: "needs_approval",
        approvalTarget: "AutoMobile",
      });
    }
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
    const socket = new net.Socket();
    await connectBounded(socket, h.socketPath);

    const chunks: Buffer[] = [];
    socket.on("data", (data) => chunks.push(data));
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

  describe("authentication (issue #4751)", () => {
    function fakeSessionManager(
      overrides: Partial<StreamAuthSessionManager> = {},
    ): StreamAuthSessionManager {
      return {
        getSession: (sessionUuid) => (sessionUuid === "session-1" ? {} : null),
        getSessionForDevice: () => null,
        getDeviceLabels: () => undefined,
        ...overrides,
      };
    }

    function enforcing(sm: StreamAuthSessionManager): StreamSocketAuthenticator {
      return new SessionScopedStreamAuthenticator(
        () => sm,
        "video-stream subscribe",
        {} as NodeJS.ProcessEnv,
      );
    }

    test("rejects an unauthenticated subscribe and starts no capture", async () => {
      const h = await startHarness({ authenticator: enforcing(fakeSessionManager()) });

      const { ack } = await subscribe(h.socketPath);

      expect(ack.success).toBe(false);
      expect(String(ack.error)).toContain("authenticated daemon session");
      expect(h.server.activeDeviceIds()).toHaveLength(0);
      expect(h.sources).toHaveLength(0);
    });

    test("rejects a subscribe whose session is unknown/expired", async () => {
      const h = await startHarness({ authenticator: enforcing(fakeSessionManager()) });

      const { ack } = await subscribe(h.socketPath, {
        action: "subscribe",
        deviceId: DEVICE.deviceId,
        sessionUuid: "ghost",
      });

      expect(ack.success).toBe(false);
      expect(String(ack.error)).toContain("not an active daemon session");
      expect(h.sources).toHaveLength(0);
    });

    test("accepts a subscribe with a live session", async () => {
      const h = await startHarness({ authenticator: enforcing(fakeSessionManager()) });

      const { ack } = await subscribe(h.socketPath, {
        action: "subscribe",
        deviceId: DEVICE.deviceId,
        sessionUuid: "session-1",
      });

      expect(ack.success).toBe(true);
      expect(h.server.activeDeviceIds()).toEqual([DEVICE.deviceId]);
    });

    test("rejects riding along on a device owned by another session", async () => {
      const h = await startHarness({
        authenticator: enforcing(
          fakeSessionManager({ getSessionForDevice: () => "other-session" }),
        ),
      });

      const { ack } = await subscribe(h.socketPath, {
        action: "subscribe",
        deviceId: DEVICE.deviceId,
        sessionUuid: "session-1",
      });

      expect(ack.success).toBe(false);
      expect(String(ack.error)).toContain("different daemon session");
      expect(h.sources).toHaveLength(0);
    });
  });
});
