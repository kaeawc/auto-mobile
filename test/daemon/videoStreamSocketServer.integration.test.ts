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
import {
  VideoStreamSocketServer,
  type DeviceOwnershipChanges,
} from "../../src/daemon/videoStreamSocketServer";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { ScreenRecordingPermissionError } from "../../src/features/webrtc";
import {
  SessionScopedStreamAuthenticator,
  STREAM_SOCKET_AUTH_ENV,
  type StreamAuthSessionManager,
  type StreamSocketAuthenticator,
} from "../../src/daemon/streamSocketAuth";
import {
  CODEC_ID_H264,
  encodeDroppedFrames,
  PACKET_FLAG_DROPPED_FRAMES,
  PACKET_FLAG_HEARTBEAT,
} from "../../src/daemon/videoStreamFraming";
import { SIMULATOR_FPS_DEFAULT } from "../../src/features/screen-stream/IosScreenCaptureHelper";
import {
  permissiveDeviceAdmissionGate,
  type DeviceAdmissionGate,
} from "../../src/daemon/deviceAdmissionGate";
import { ActionableError } from "../../src/models";
import {
  WEBRTC_ANDROID_FPS_DEFAULT,
  WEBRTC_IOS_SIMULATOR_FPS_DEFAULT,
} from "../../src/features/webrtc/webrtcStreamingConfig";

const DEVICE: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
} as BootedDevice;

/** A capture source that never touches adb; tests push chunks by hand. */
class FakeCaptureSource implements H264CaptureSource {
  started = false;
  stopped = false;
  staleStopped = false;
  producerStaleOnStop: boolean | null = null;
  keyFramePurposes: ("viewer" | "probe" | undefined)[] = [];
  startError: Error | null = null;
  stopError: Error | null = null;
  startGate: Promise<void> | null = null;
  stopGate: Promise<void> | null = null;
  onStopSettled: (() => void) | null = null;
  onStart: (() => void) | null = null;
  keyFrameRequests = 0;
  consumerStates: boolean[] = [];
  setHasConsumers(hasConsumers: boolean): void {
    this.consumerStates.push(hasConsumers);
  }
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
    await this.stopGate;
    if (this.stopError) {
      throw this.stopError;
    }
    this.onStopSettled?.();
  }

  async stopStale(producerStale?: boolean): Promise<void> {
    this.staleStopped = true;
    this.producerStaleOnStop = producerStale ?? null;
    await this.stop();
  }

  requestKeyFrame(purpose?: "viewer" | "probe"): boolean {
    this.keyFrameRequests++;
    this.keyFramePurposes.push(purpose);
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
  captureOptions: Array<{ fps?: number; quality?: string; bitrateBps?: number }>;
  emitFromSource: (index: number, chunk: Buffer) => void;
  emit: (chunk: Buffer) => void;
  emitUnattested: (chunk: Buffer) => void;
  emitSourceFrame: () => void;
  emitIdle: () => void;
  emitEncodedBoundary: () => void;
  setIdleSupport: (supported: boolean) => void;
  /** Simulates the source attesting a display rotation (issue #4786). */
  emitRotation: (rotation: number) => void;
  /** Simulates a cumulative encoder-side dropped-frame measurement. */
  emitDroppedFrames: (droppedFrames: number) => void;
  /** Simulates the capture source reporting a mid-stream failure. */
  emitError: (error: Error) => void;
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
    onResolveDevice?: () => void;
    resolveGate?: Promise<void>;
    authenticator?: StreamSocketAuthenticator;
    timer?: Timer;
    /** Pre-arms each created source to throttle this many key-frame requests. */
    keyFrameRejections?: number;
    admissionGate?: DeviceAdmissionGate;
    device?: BootedDevice;
    ownershipChanges?: () => DeviceOwnershipChanges;
  } = {},
): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "amvs-"));
  const socketPath = path.join(dir, "video-stream.sock");
  const sources: FakeCaptureSource[] = [];
  let onData: ((chunk: Buffer) => void) | null = null;
  let onSourceFrame: (() => void) | null = null;
  let onSourceIdle: (() => void) | null = null;
  let onEncodedAccessUnit: (() => void) | null = null;
  let onIdleAttestationSupport: ((supported: boolean) => void) | null = null;
  let onRotation: ((rotation: number) => void) | null = null;
  let onDroppedFrames: ((droppedFrames: number) => void) | null = null;
  let onError: ((error: Error) => void) | null = null;
  const captureOptions: Array<{ fps?: number; quality?: string; bitrateBps?: number }> = [];
  const sourceCallbacks: Array<{ onData: (chunk: Buffer) => void; onSourceFrame?: () => void }> =
    [];

  const server = new VideoStreamSocketServer(
    {
      resolveDevice: async () => {
        options.onResolveDevice?.();
        await options.resolveGate;
        if (options.resolveError) {
          throw options.resolveError;
        }
        return options.device ?? DEVICE;
      },
      createCaptureSource: async (opts) => {
        onData = opts.onData;
        onSourceFrame = opts.onSourceFrame ?? null;
        onSourceIdle = opts.onSourceIdle ?? null;
        onEncodedAccessUnit = opts.onEncodedAccessUnit ?? null;
        onIdleAttestationSupport = opts.onIdleAttestationSupport ?? null;
        onRotation = opts.onRotation ?? null;
        onDroppedFrames = opts.onDroppedFrames ?? null;
        onError = opts.onError;
        captureOptions.push(opts);
        sourceCallbacks.push({ onData: opts.onData, onSourceFrame: opts.onSourceFrame });
        const source = new FakeCaptureSource();
        source.startError = options.startError ?? null;
        source.startGate = options.startGate ?? null;
        source.keyFrameRejectionsRemaining = options.keyFrameRejections ?? 0;
        source.onStart = () => {
          if (options.startData) {
            onSourceFrame?.();
            onData?.(options.startData);
          }
        };
        sources.push(source);
        return source;
      },
      nowUs: () => 1_000n,
      ownershipChanges: options.ownershipChanges,
    },
    socketPath,
    options.timer ?? defaultTimer,
    options.authenticator ?? allowAllAuthenticator,
    // Explicit rather than defaulted: the real default consults the running
    // daemon's pool, which another suite in this process may have initialized.
    options.admissionGate ?? permissiveDeviceAdmissionGate,
  );
  await server.start();

  const harness: Harness = {
    server,
    socketPath,
    sources,
    captureOptions,
    emitFromSource: (index, chunk) => {
      sourceCallbacks[index].onSourceFrame?.();
      sourceCallbacks[index].onData(chunk);
    },
    emit: (chunk) => {
      onSourceFrame?.();
      onData?.(chunk);
    },
    emitUnattested: (chunk) => onData?.(chunk),
    emitSourceFrame: () => onSourceFrame?.(),
    emitIdle: () => onSourceIdle?.(),
    emitEncodedBoundary: () => onEncodedAccessUnit?.(),
    setIdleSupport: (supported) => onIdleAttestationSupport?.(supported),
    emitRotation: (rotation) => onRotation?.(rotation),
    emitDroppedFrames: (droppedFrames) => onDroppedFrames?.(droppedFrames),
    emitError: (error) => onError?.(error),
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
    await new Promise<void>((resolve) => setImmediate(resolve));
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

async function flushSocketTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function framedPackets(binary: Buffer): Array<{ flags: bigint; payload: Buffer }> {
  const packets: Array<{ flags: bigint; payload: Buffer }> = [];
  for (let offset = 12; offset + 12 <= binary.length;) {
    const length = binary.readInt32BE(offset + 8);
    if (offset + 12 + length > binary.length) {
      break;
    }
    packets.push({
      flags: binary.readBigInt64BE(offset),
      payload: binary.subarray(offset + 12, offset + 12 + length),
    });
    offset += 12 + length;
  }
  return packets;
}

afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()?.cleanup();
  }
});

describe("VideoStreamSocketServer", () => {
  test("ignores a pipelined duplicate subscribe before device resolution", async () => {
    let releaseResolve = () => {};
    const resolveGate = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    let resolveCalls = 0;
    const h = await startHarness({
      resolveGate,
      onResolveDevice: () => resolveCalls++,
    });
    const socket = new net.Socket();
    await connectBounded(socket, h.socketPath);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    const request = JSON.stringify({ action: "subscribe", deviceId: DEVICE.deviceId });
    socket.write(`${request}\n${request}\n`);

    await waitFor(() => resolveCalls > 0);
    releaseResolve();
    await waitFor(() => Buffer.concat(chunks).includes(Buffer.from("\n")));
    await waitFor(() => Buffer.concat(chunks).length >= Buffer.concat(chunks).indexOf(0x0a) + 13);

    const frame = Buffer.from([0, 0, 0, 1, 5, 0xaa, 0xbb, 0, 0, 0, 1, 1]);
    h.emit(frame);
    await waitFor(() => Buffer.concat(chunks).length >= Buffer.concat(chunks).indexOf(0x0a) + 32);

    const received = Buffer.concat(chunks);
    const ackEnd = received.indexOf(0x0a);
    const ack = JSON.parse(received.subarray(0, ackEnd).toString("utf8")) as Record<
      string,
      unknown
    >;
    const binary = received.subarray(ackEnd + 1);
    expect(ack.success).toBe(true);
    expect(resolveCalls).toBe(1);
    expect(h.sources).toHaveLength(1);
    expect(h.server.subscriberCount(DEVICE.deviceId)).toBe(1);
    expect(binary.length).toBe(12 + 12 + 7);
    expect(binary.readInt32BE(0)).toBe(CODEC_ID_H264);
    expect(binary.readInt32BE(12 + 8)).toBe(7);
    expect(binary.subarray(12 + 12)).toEqual(frame.subarray(0, 7));
    socket.destroy();
  });

  test("acknowledges a subscribe and announces the framing", async () => {
    const h = await startHarness();

    const { ack } = await subscribe(h.socketPath);

    expect(ack.success).toBe(true);
    expect(ack.type).toBe("video_stream_response");
    expect(ack.deviceId).toBe(DEVICE.deviceId);
    expect(ack.framing).toBe("h264");
  });

  // FUNNEL 2: the quarantine preserves the owning session, so authorization
  // still succeeds on a serial whose AVD identity the pool can no longer prove.
  // Starting a capture on it would relay whichever runtime now answers
  // ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
  test("refuses a subscribe on a quarantined serial without starting a capture", async () => {
    const h = await startHarness({
      admissionGate: {
        assertDeviceActionable: (deviceId, purpose) => {
          throw new ActionableError(`Refusing ${purpose} on device '${deviceId}'`);
        },
      },
    });

    const { ack } = await subscribe(h.socketPath);

    expect(ack.success).toBe(false);
    expect(String(ack.error)).toContain("Refusing to stream video on device 'emulator-5554'");
    expect(h.sources).toHaveLength(0);
    expect(h.server.activeDeviceIds()).toEqual([]);
  });

  test("defaults Android capture to the Android WebRTC rate", async () => {
    const h = await startHarness();

    await subscribe(h.socketPath);

    expect(h.captureOptions[0].fps).toBe(WEBRTC_ANDROID_FPS_DEFAULT);
    expect(h.captureOptions[0].fps).not.toBe(SIMULATOR_FPS_DEFAULT);
  });

  test("defaults iOS capture to the Simulator observation rate", async () => {
    const h = await startHarness({ device: { ...DEVICE, platform: "ios" } });

    await subscribe(h.socketPath);

    expect(h.captureOptions[0].fps).toBe(SIMULATOR_FPS_DEFAULT);
    expect(SIMULATOR_FPS_DEFAULT).not.toBe(WEBRTC_IOS_SIMULATOR_FPS_DEFAULT);
  });

  test("lets explicit fps hints override the platform default", async () => {
    const android = await startHarness();
    const ios = await startHarness({ device: { ...DEVICE, platform: "ios" } });

    await subscribe(android.socketPath, {
      action: "subscribe",
      deviceId: DEVICE.deviceId,
      fps: 15,
    });
    await subscribe(ios.socketPath, {
      action: "subscribe",
      deviceId: DEVICE.deviceId,
      fps: 20,
    });

    expect(android.captureOptions[0].fps).toBe(15);
    expect(ios.captureOptions[0].fps).toBe(20);
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
    const fakeTimer = new FakeTimer();
    const h = await startHarness({ timer: fakeTimer });
    const { binary } = await subscribe(h.socketPath);
    await waitFor(() => binary().length >= 12);

    h.emitDroppedFrames(42);
    await defaultTimer.sleep(10);
    expect(binary().length).toBe(12);

    h.emit(Buffer.from([0, 0, 0, 1, 5, 0xaa, 0, 0, 0, 1, 1]));
    await waitFor(() => binary().length > 12);
    const beforeDropPacket = binary().length;
    h.emitDroppedFrames(42);
    await waitFor(() => binary().length >= beforeDropPacket + 12);

    const packet = binary().subarray(beforeDropPacket, beforeDropPacket + 12);
    expect(packet.readBigInt64BE(0) & PACKET_FLAG_DROPPED_FRAMES).toBe(PACKET_FLAG_DROPPED_FRAMES);
    expect(packet.readBigInt64BE(0) & ((1n << 59n) - 1n)).toBe(42n);

    fakeTimer.advanceTime(10_000);
    await defaultTimer.sleep(10);
    const staleLength = binary().length;
    h.emitDroppedFrames(42);
    await defaultTimer.sleep(10);
    expect(binary().length).toBe(staleLength);

    const replacement = await subscribe(h.socketPath);
    await waitFor(() => replacement.binary().length >= 12);
    h.emit(Buffer.from([0, 0, 0, 1, 5, 0xbb, 0, 0, 0, 1, 1]));
    await waitFor(() => replacement.binary().length > 12);
    const beforeRecoveredDrop = replacement.binary().length;
    h.emitDroppedFrames(43);
    await waitFor(() => replacement.binary().length >= beforeRecoveredDrop + 12);
    expect(packet.readInt32BE(8)).toBe(0);
  });

  // --- Relay-originated heartbeat (issue #7549) ---

  test("advertises the heartbeat cadence in the subscribe ack", async () => {
    const h = await startHarness();

    const { ack } = await subscribe(h.socketPath);

    expect(ack.heartbeatMs).toBe(1_000);
  });

  test("emits a heartbeat packet to a promoted subscriber once the capture has data", async () => {
    const fakeTimer = new FakeTimer();
    const h = await startHarness({ timer: fakeTimer });
    const { binary } = await subscribe(h.socketPath);
    await waitFor(() => binary().length >= 12);

    // A closing start code is required so the parser can flush the IDR NAL (it buffers an
    // unterminated NAL waiting for more data, same as every other emit() in this file).
    h.emit(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x05, 0xaa, 0x00, 0x00, 0x00, 0x01, 0x01]));
    await waitFor(() => binary().length > 12);

    const beforeHeartbeat = binary().length;
    fakeTimer.advanceTime(1_000);
    await waitFor(() => binary().length > beforeHeartbeat);

    const packet = binary().subarray(beforeHeartbeat, beforeHeartbeat + 12);
    const ptsAndFlags = BigInt.asUintN(64, packet.readBigInt64BE(0));
    expect(ptsAndFlags & PACKET_FLAG_HEARTBEAT).toBe(PACKET_FLAG_HEARTBEAT);
    expect(packet.readInt32BE(8)).toBe(0);
  });

  test("does not emit a heartbeat before the capture has produced any data", async () => {
    const fakeTimer = new FakeTimer();
    const h = await startHarness({ timer: fakeTimer });
    const { binary } = await subscribe(h.socketPath);
    await waitFor(() => binary().length >= 12);

    // A dead-from-start source must never look alive.
    fakeTimer.advanceTime(5_000);
    await defaultTimer.sleep(30);

    expect(binary().length).toBe(12);
  });

  test("keeps the capture when a quiet source answers a key-frame probe", async () => {
    const fakeTimer = new FakeTimer();
    const h = await startHarness({ timer: fakeTimer });
    const { binary } = await subscribe(h.socketPath);
    await waitFor(() => binary().length >= 12);
    h.emit(Buffer.from([0, 0, 0, 1, 5, 0xaa, 0, 0, 0, 1, 1]));
    await waitFor(() => binary().length > 12);

    fakeTimer.advanceTime(8_000);
    await defaultTimer.sleep(10);
    const beforeRecovery = binary().length;
    expect(h.sources[0].keyFrameRequests).toBeGreaterThan(0);

    h.emit(Buffer.from([0, 0, 0, 1, 1, 0xbb, 0, 0, 0, 1, 1]));
    fakeTimer.advanceTime(1_000);
    await waitFor(() => binary().length > beforeRecovery);
    expect(h.sources[0].stopped).toBe(false);
  });

  test("fresh source frames do not reset the successful probe interval while encoding stalls", async () => {
    const fakeTimer = new FakeTimer();
    const h = await startHarness({ timer: fakeTimer });
    const { binary } = await subscribe(h.socketPath);
    await waitFor(() => binary().length >= 12);
    h.emit(Buffer.from([0, 0, 0, 1, 5, 0xaa, 0, 0, 0, 1, 1]));
    await waitFor(() => binary().length > 12);

    const requestsBeforeProbe = h.sources[0].keyFrameRequests;
    fakeTimer.advanceTime(6_000);
    expect(h.sources[0].keyFrameRequests).toBe(requestsBeforeProbe + 1);
    expect(h.sources[0].keyFramePurposes).toContain("probe");
    for (let second = 7; second <= 9; second++) {
      h.emitSourceFrame();
      fakeTimer.advanceTime(1_000);
    }
    expect(h.sources[0].keyFrameRequests).toBe(requestsBeforeProbe + 1);
    h.emitSourceFrame();
    fakeTimer.advanceTime(1_000);
    await waitFor(() => h.sources[0].stopped);
    expect(h.sources[0].producerStaleOnStop).toBe(false);
  });

  test("retires a stale capture so a reconnect starts a new source", async () => {
    const fakeTimer = new FakeTimer();
    const h = await startHarness({ timer: fakeTimer });
    const first = await subscribe(h.socketPath);
    await waitFor(() => first.binary().length >= 12);
    h.emit(Buffer.from([0, 0, 0, 1, 5, 0xaa, 0, 0, 0, 1, 1]));
    await waitFor(() => first.binary().length > 12);
    let finishStop: (() => void) | undefined;
    h.sources[0].stopGate = new Promise<void>((resolve) => {
      finishStop = resolve;
    });

    fakeTimer.advanceTime(10_000);
    await waitFor(() => h.sources[0].stopped);
    expect(h.sources[0].staleStopped).toBe(true);
    expect(h.server.activeDeviceIds()).toEqual([]);

    const reconnect = subscribe(h.socketPath);
    await defaultTimer.sleep(10);
    expect(h.sources).toHaveLength(1);
    finishStop?.();
    const second = await reconnect;
    await waitFor(() => second.binary().length >= 12);
    expect(h.sources).toHaveLength(2);
    expect(h.sources[1].started).toBe(true);
  });

  test("retires a capture when only the raw source reports a frame", async () => {
    const fakeTimer = new FakeTimer();
    const h = await startHarness({ timer: fakeTimer });
    const first = await subscribe(h.socketPath);
    await waitFor(() => first.binary().length >= 12);

    h.emitSourceFrame();
    fakeTimer.advanceTime(8_000);
    expect(h.sources[0].stopped).toBe(false);
    // More raw frames must not restart the deadline for the missing encoder.
    h.emitSourceFrame();
    fakeTimer.advanceTime(2_000);
    await waitFor(() => h.sources[0].stopped);
    expect(h.sources[0].staleStopped).toBe(true);

    const second = await subscribe(h.socketPath);
    await waitFor(() => second.binary().length >= 12);
    expect(h.sources).toHaveLength(2);
    expect(h.sources[1].started).toBe(true);
  });

  test("retires a capture when only the encoder reports output", async () => {
    const fakeTimer = new FakeTimer();
    const h = await startHarness({ timer: fakeTimer });
    const first = await subscribe(h.socketPath);
    await waitFor(() => first.binary().length >= 12);

    // emit() attests the source too; this path deliberately reports encoder output alone.
    h.emitUnattested(Buffer.from([0, 0, 0, 1, 5, 0xaa, 0, 0, 0, 1, 1]));
    fakeTimer.advanceTime(8_000);
    expect(h.sources[0].stopped).toBe(false);
    fakeTimer.advanceTime(2_000);
    await waitFor(() => h.sources[0].stopped);
    expect(h.sources[0].staleStopped).toBe(true);
  });

  test("fresh native idle evidence sustains an encoder-only pooled iOS capture", async () => {
    const fakeTimer = new FakeTimer();
    const iosDevice = { ...DEVICE, platform: "ios" } as BootedDevice;
    const h = await startHarness({ timer: fakeTimer, device: iosDevice });
    const { socket, binary } = await subscribe(h.socketPath);
    await waitFor(() => binary().length >= 12);
    const receiveAtLeast = (byteCount: number): Promise<void> =>
      new Promise((resolve) => {
        const onData = (): void => {
          if (binary().length >= byteCount) {
            socket.off("data", onData);
            resolve();
          }
        };
        socket.on("data", onData);
        onData();
      });

    // A warm helper's replayed frame reaches ffmpeg but never attests a new source frame.
    const frameReceived = receiveAtLeast(30);
    h.emitUnattested(Buffer.from([0, 0, 0, 1, 5, 0xaa, 0, 0, 0, 1, 1]));
    await frameReceived;
    const beforeIdle = binary().length;
    const heartbeatReceived = receiveAtLeast(beforeIdle + 12);
    for (let i = 0; i < 10; i++) {
      h.emitIdle();
      fakeTimer.advanceTime(2_000);
    }
    await heartbeatReceived;

    expect(h.sources[0].stopped).toBe(false);
    expect(h.server.activeDeviceIds()).toContain(iosDevice.deviceId);
    expect(binary().length).toBeGreaterThan(beforeIdle);
    const packet = binary().subarray(beforeIdle, beforeIdle + 12);
    const ptsAndFlags = BigInt.asUintN(64, packet.readBigInt64BE(0));
    expect(ptsAndFlags & PACKET_FLAG_HEARTBEAT).toBe(PACKET_FLAG_HEARTBEAT);
    expect(packet.readInt32BE(8)).toBe(0);
  });

  test("native idle callbacks sustain a static capture only after encoded output", async () => {
    const fakeTimer = new FakeTimer();
    const h = await startHarness({ timer: fakeTimer });
    const { binary } = await subscribe(h.socketPath);
    await waitFor(() => binary().length >= 12);
    h.emit(Buffer.from([0, 0, 0, 1, 5, 0xaa, 0, 0, 0, 1, 1]));
    for (let i = 0; i < 6; i++) {
      h.emitIdle();
      fakeTimer.advanceTime(2_000);
    }
    expect(h.sources[0].stopped).toBe(false);
    h.emitSourceFrame();
    fakeTimer.advanceTime(1_000);
    await waitFor(() => h.sources[0].stopped);
    expect(h.sources[0].staleStopped).toBe(true);
  });

  test("older Simulator helpers preserve static-screen heartbeats until upgraded", async () => {
    const fakeTimer = new FakeTimer();
    const iosDevice = { ...DEVICE, platform: "ios" } as BootedDevice;
    const h = await startHarness({ timer: fakeTimer, device: iosDevice });
    const { binary } = await subscribe(h.socketPath);
    await waitFor(() => binary().length >= 12);
    h.setIdleSupport(false);
    h.emit(Buffer.from([0, 0, 0, 1, 5, 0xaa, 0, 0, 0, 1, 1]));
    fakeTimer.advanceTime(12_000);
    expect(h.sources[0].stopped).toBe(false);
    h.setIdleSupport(true);
    fakeTimer.advanceTime(1_000);
    await waitFor(() => h.sources[0].stopped);
  });

  test("iOS encoder output alone cannot keep a cached helper frame capture alive", async () => {
    const fakeTimer = new FakeTimer();
    const iosDevice = { ...DEVICE, platform: "ios" } as BootedDevice;
    const h = await startHarness({ timer: fakeTimer, device: iosDevice });
    const { binary } = await subscribe(h.socketPath);
    await waitFor(() => binary().length >= 12);
    h.emitUnattested(Buffer.from([0, 0, 0, 1, 5, 0xaa, 0, 0, 0, 1, 1]));

    fakeTimer.advanceTime(2_000);
    await defaultTimer.sleep(10);
    const withoutProof = binary().length;
    h.emitSourceFrame();
    fakeTimer.advanceTime(1_000);
    await waitFor(() => binary().length > withoutProof);

    fakeTimer.advanceTime(5_000);
    await defaultTimer.sleep(10);
    // Raw iOS key-frame requests can cause this replay without any fresh helper frame.
    h.emitUnattested(Buffer.from([0, 0, 0, 1, 1, 0xbb, 0, 0, 0, 1, 1]));
    fakeTimer.advanceTime(5_000);
    await waitFor(() => h.sources[0].stopped);
  });

  test("fresh iOS helper frames cannot hide a stalled encoder", async () => {
    const fakeTimer = new FakeTimer();
    const iosDevice = { ...DEVICE, platform: "ios" } as BootedDevice;
    const h = await startHarness({ timer: fakeTimer, device: iosDevice });
    const { binary } = await subscribe(h.socketPath);
    await waitFor(() => binary().length >= 12);
    h.emit(Buffer.from([0, 0, 0, 1, 5, 0xaa, 0, 0, 0, 1, 1]));
    fakeTimer.advanceTime(9_000);
    h.emitSourceFrame();
    await defaultTimer.sleep(10);
    const staleEncoderLength = binary().length;

    fakeTimer.advanceTime(2_000);
    await defaultTimer.sleep(10);
    expect(binary().length).toBe(staleEncoderLength);
  });

  test("does not emit a heartbeat to a subscriber still waiting for a key frame", async () => {
    const fakeTimer = new FakeTimer();
    // Keeps the source throttling key-frame requests indefinitely, so the second
    // subscriber never resyncs and stays parked in waitingForKeyFrame.
    const h = await startHarness({ timer: fakeTimer, keyFrameRejections: 100 });
    const first = await subscribe(h.socketPath);
    await waitFor(() => first.binary().length >= 12);
    h.emit(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x05, 0xaa, 0x00, 0x00, 0x00, 0x01, 0x01]));
    await waitFor(() => first.binary().length > 12);

    const second = await subscribe(h.socketPath);
    await waitFor(() => h.server.subscriberCount(DEVICE.deviceId) === 2);
    const beforeHeartbeat = second.binary().length;

    fakeTimer.advanceTime(3_000);
    await defaultTimer.sleep(30);

    expect(second.binary().length).toBe(beforeHeartbeat);
  });

  test("stops the heartbeat once the capture is torn down", async () => {
    const fakeTimer = new FakeTimer();
    const h = await startHarness({ timer: fakeTimer });
    await subscribe(h.socketPath);
    await waitFor(() => h.server.subscriberCount(DEVICE.deviceId) === 1);
    h.emit(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x05, 0xaa, 0x00, 0x00, 0x00, 0x01, 0x01]));
    await waitFor(() => fakeTimer.getPendingIntervalCount() >= 1);

    h.emitError(new Error("adb: device offline"));
    await waitFor(() => h.server.activeDeviceIds().length === 0);

    expect(fakeTimer.getPendingIntervalCount()).toBe(0);
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

  test("a late quality request reconfigures one shared source without disconnecting viewers", async () => {
    const timer = new FakeTimer();
    const h = await startHarness({ timer });
    const first = await subscribe(h.socketPath, {
      action: "subscribe",
      deviceId: DEVICE.deviceId,
      quality: "high",
      fps: 30,
      bitrateKbps: 8000,
    });
    const second = await subscribe(h.socketPath, {
      action: "subscribe",
      deviceId: DEVICE.deviceId,
      quality: "low",
      fps: 15,
      bitrateKbps: 2000,
    });
    expect(h.sources).toHaveLength(1);
    timer.advanceTime(199);
    expect(h.sources).toHaveLength(1);
    timer.advanceTime(1);
    await flushSocketTurn();
    expect(h.sources).toHaveLength(2);
    expect(h.sources[0].stopped).toBe(true);
    expect(h.captureOptions[1]).toMatchObject({
      quality: "low",
      fps: 15,
      bitrateBps: 2_000_000,
    });
    expect(h.server.subscriberCount(DEVICE.deviceId)).toBe(2);
    expect(first.socket.destroyed).toBe(false);
    expect(second.socket.destroyed).toBe(false);

    // A stopped encoder can still deliver a buffered callback; its generation is fenced.
    const stale = Buffer.from([0, 0, 0, 1, 0x07, 0x11, 0, 0, 0, 1, 0x08, 0x12]);
    h.emitFromSource(0, stale);
    const fresh = Buffer.from([
      0, 0, 0, 1, 0x07, 0x21, 0, 0, 0, 1, 0x08, 0x22, 0, 0, 0, 1, 0x05, 0x23, 0, 0, 0, 1, 0x01,
      0x24,
    ]);
    h.emitFromSource(1, fresh);
    await flushSocketTurn();
    for (const viewer of [first, second]) {
      const packets = framedPackets(viewer.binary());
      expect(packets.some((packet) => packet.payload.includes(Buffer.from([0x07, 0x21])))).toBe(
        true,
      );
      expect(packets.some((packet) => packet.payload.includes(Buffer.from([0x08, 0x22])))).toBe(
        true,
      );
      expect(packets.some((packet) => (packet.flags & (1n << 62n)) !== 0n)).toBe(true);
      expect(packets.some((packet) => packet.payload.includes(Buffer.from([0x07, 0x11])))).toBe(
        false,
      );
    }
    const third = await subscribe(h.socketPath);
    await flushSocketTurn();
    const replay = framedPackets(third.binary());
    expect(replay.some((packet) => packet.payload.includes(Buffer.from([0x07, 0x21])))).toBe(true);
    expect(h.sources).toHaveLength(2);
  });

  test("coalesces rapid hints and serializes a newer request during an encoder swap", async () => {
    const timer = new FakeTimer();
    const h = await startHarness({ timer });
    await subscribe(h.socketPath, { action: "subscribe", quality: "high" });
    let releaseStop: () => void = () => {};
    h.sources[0].stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    await subscribe(h.socketPath, { action: "subscribe", quality: "medium" });
    timer.advanceTime(100);
    await subscribe(h.socketPath, { action: "subscribe", quality: "low", fps: 10 });
    timer.advanceTime(200);
    await flushSocketTurn();
    expect(h.sources).toHaveLength(1);
    releaseStop();
    await flushSocketTurn();
    expect(h.sources).toHaveLength(2);
    expect(h.captureOptions[1]).toMatchObject({ quality: "low", fps: 10 });

    h.sources[1].stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    await subscribe(h.socketPath, { action: "subscribe", quality: "medium" });
    timer.advanceTime(200);
    await flushSocketTurn();
    expect(h.sources).toHaveLength(2);
    await subscribe(h.socketPath, { action: "subscribe", quality: "high", bitrateKbps: 3000 });
    releaseStop();
    await flushSocketTurn();
    expect(h.sources).toHaveLength(3);
    timer.advanceTime(200);
    await flushSocketTurn();
    expect(h.sources).toHaveLength(4);
    expect(h.captureOptions[3]).toMatchObject({
      quality: "high",
      fps: 10,
      bitrateBps: 3_000_000,
    });
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
    const fakeTimer = new FakeTimer();
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
        fakeTimer,
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
    await waitFor(() => harness.server.subscriberCount(DEVICE.deviceId) === 0);
    fakeTimer.advanceTime(3_000);
    await waitFor(() => harness.server.activeDeviceIds().length === 0);
    resolveSource?.(source);

    await waitFor(() => source.stopped);
    expect(source.started).toBe(false);
  });

  test("keeps a replacement capture when an abandoned startup later fails", async () => {
    const fakeTimer = new FakeTimer();
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
      fakeTimer,
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
    await waitFor(() => server.subscriberCount(DEVICE.deviceId) === 0);
    fakeTimer.advanceTime(3_000);
    await waitFor(() => server.activeDeviceIds().length === 0);

    const replacementRequest = subscribe(socketPath);
    resolveAbandonedSource?.(abandonedSource);
    await waitFor(() => abandonedSource.stopped);
    const replacement = await replacementRequest;
    expect(replacement.ack.success).toBe(true);
    expect(server.activeDeviceIds()).toEqual([DEVICE.deviceId]);

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
    const fakeTimer = new FakeTimer();
    const h = await startHarness({ timer: fakeTimer });
    const first = await subscribe(h.socketPath);
    const second = await subscribe(h.socketPath);
    await waitFor(() => h.server.subscriberCount(DEVICE.deviceId) === 2);

    first.socket.destroy();
    await waitFor(() => h.server.subscriberCount(DEVICE.deviceId) === 1);
    expect(h.sources[0].stopped).toBe(false);

    second.socket.destroy();
    await waitFor(() => h.server.subscriberCount(DEVICE.deviceId) === 0);
    expect(h.sources[0].stopped).toBe(false);
    fakeTimer.advanceTime(3_000);
    await waitFor(() => h.server.activeDeviceIds().length === 0);
    expect(h.sources[0].stopped).toBe(true);
  });

  test("detach then reattach within the idle grace window reuses the capture", async () => {
    const fakeTimer = new FakeTimer();
    const h = await startHarness({ timer: fakeTimer });
    const first = await subscribe(h.socketPath);
    const keyFrameRequests = h.sources[0].keyFrameRequests;

    first.socket.destroy();
    await waitFor(() => h.server.subscriberCount(DEVICE.deviceId) === 0);
    expect(h.sources[0].consumerStates.at(-1)).toBe(false);
    fakeTimer.advanceTime(1_500);
    const second = await subscribe(h.socketPath);

    expect(second.ack.success).toBe(true);
    expect(h.sources).toHaveLength(1);
    expect(h.sources[0].stopped).toBe(false);
    expect(h.sources[0].consumerStates.at(-1)).toBe(true);
    expect(h.sources[0].keyFrameRequests).toBeGreaterThan(keyFrameRequests);
    fakeTimer.advanceTime(1_500);
    expect(h.sources[0].stopped).toBe(false);
  });

  test("detach then idle grace elapses with no reattach stops the capture", async () => {
    const fakeTimer = new FakeTimer();
    const h = await startHarness({ timer: fakeTimer });
    const client = await subscribe(h.socketPath);

    client.socket.destroy();
    await waitFor(() => h.server.subscriberCount(DEVICE.deviceId) === 0);
    fakeTimer.advanceTime(2_999);
    expect(h.sources[0].stopped).toBe(false);
    fakeTimer.advanceTime(1);

    await waitFor(() => h.sources[0].stopped);
    expect(h.server.activeDeviceIds()).toEqual([]);
  });

  test("attach during an in-flight stop waits for the stop to settle before starting a new source", async () => {
    const fakeTimer = new FakeTimer();
    let resolveCalls = 0;
    const h = await startHarness({
      timer: fakeTimer,
      onResolveDevice: () => resolveCalls++,
    });
    const first = await subscribe(h.socketPath);
    let releaseStop: (() => void) | undefined;
    h.sources[0].stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const order: string[] = [];
    h.sources[0].onStopSettled = () => order.push("stop settled");

    first.socket.destroy();
    await waitFor(() => h.server.subscriberCount(DEVICE.deviceId) === 0);
    fakeTimer.advanceTime(3_000);
    expect(h.sources[0].stopped).toBe(true);

    const secondRequest = subscribe(h.socketPath);
    await waitFor(() => resolveCalls === 2);
    expect(h.sources).toHaveLength(1);
    expect(order).toEqual([]);

    releaseStop?.();
    const second = await secondRequest;
    expect(second.ack.success).toBe(true);
    expect(order).toEqual(["stop settled"]);
    expect(h.sources).toHaveLength(2);
    expect(h.sources[1].started).toBe(true);
  });

  test("close rejects an attach waiting for an in-flight stop without creating a source", async () => {
    const fakeTimer = new FakeTimer();
    let resolveCalls = 0;
    const h = await startHarness({
      timer: fakeTimer,
      onResolveDevice: () => resolveCalls++,
    });
    const first = await subscribe(h.socketPath);
    let releaseStop: (() => void) | undefined;
    h.sources[0].stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });

    first.socket.destroy();
    await waitFor(() => h.server.subscriberCount(DEVICE.deviceId) === 0);
    fakeTimer.advanceTime(3_000);
    expect(h.sources[0].stopped).toBe(true);

    const parkedRequest = subscribe(h.socketPath);
    await waitFor(() => resolveCalls === 2);
    expect(h.sources).toHaveLength(1);

    const closing = h.server.close();
    releaseStop?.();
    const parked = await parkedRequest;
    await closing;

    expect(parked.ack.success).toBe(false);
    expect(parked.ack.error).toBe("Video stream server is closed");
    expect(h.sources).toHaveLength(1);
    expect(h.server.activeDeviceIds()).toEqual([]);
  });

  test("two attaches waiting for the same stop share one replacement capture", async () => {
    const fakeTimer = new FakeTimer();
    let resolveCalls = 0;
    const h = await startHarness({
      timer: fakeTimer,
      onResolveDevice: () => resolveCalls++,
    });
    const first = await subscribe(h.socketPath);
    let releaseStop: (() => void) | undefined;
    h.sources[0].stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });

    first.socket.destroy();
    await waitFor(() => h.server.subscriberCount(DEVICE.deviceId) === 0);
    fakeTimer.advanceTime(3_000);
    expect(h.sources[0].stopped).toBe(true);

    const secondRequest = subscribe(h.socketPath);
    const thirdRequest = subscribe(h.socketPath);
    await waitFor(() => resolveCalls === 3);
    expect(h.sources).toHaveLength(1);

    releaseStop?.();
    const [second, third] = await Promise.all([secondRequest, thirdRequest]);

    expect(second.ack.success).toBe(true);
    expect(third.ack.success).toBe(true);
    expect(h.sources).toHaveLength(2);
    expect(h.sources[1].started).toBe(true);
    expect(h.server.subscriberCount(DEVICE.deviceId)).toBe(2);
    expect(h.server.activeDeviceIds()).toEqual([DEVICE.deviceId]);
  });

  test("a disconnected attach waiting for stop cannot strand a replacement capture", async () => {
    const fakeTimer = new FakeTimer();
    let resolveCalls = 0;
    const h = await startHarness({ timer: fakeTimer, onResolveDevice: () => resolveCalls++ });
    const first = await subscribe(h.socketPath);
    let releaseStop: (() => void) | undefined;
    h.sources[0].stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });

    first.socket.destroy();
    await waitFor(() => h.server.subscriberCount(DEVICE.deviceId) === 0);
    fakeTimer.advanceTime(3_000);
    expect(h.sources[0].stopped).toBe(true);

    const disconnected = new net.Socket();
    await connectBounded(disconnected, h.socketPath);
    disconnected.write(`${JSON.stringify({ action: "subscribe", deviceId: DEVICE.deviceId })}\n`);
    await waitFor(() => resolveCalls === 2);
    disconnected.destroy();
    const remainingRequest = subscribe(h.socketPath);
    await waitFor(() => resolveCalls === 3);

    releaseStop?.();
    const remaining = await remainingRequest;
    expect(remaining.ack.success).toBe(true);
    remaining.socket.destroy();
    await waitFor(() => h.server.subscriberCount(DEVICE.deviceId) === 0);

    expect(h.server.subscriberCount(DEVICE.deviceId)).toBe(0);
    expect(fakeTimer.getPendingTimeouts()).toContain(3_000);
    fakeTimer.advanceTime(3_000);
    await waitFor(() => h.server.activeDeviceIds().length === 0);
    expect(h.sources[1].stopped).toBe(true);
  });

  test("explicit server shutdown stops immediately without waiting for the idle grace", async () => {
    const fakeTimer = new FakeTimer();
    const h = await startHarness({ timer: fakeTimer });
    const client = await subscribe(h.socketPath);

    client.socket.destroy();
    await waitFor(() => h.server.subscriberCount(DEVICE.deviceId) === 0);
    const closing = h.server.close();
    expect(h.sources[0].stopped).toBe(true);
    await closing;
    expect(h.server.activeDeviceIds()).toEqual([]);
  });

  test("a rejected in-flight stop releases the next attach", async () => {
    const fakeTimer = new FakeTimer();
    let resolveCalls = 0;
    const h = await startHarness({
      timer: fakeTimer,
      onResolveDevice: () => resolveCalls++,
    });
    const first = await subscribe(h.socketPath);
    let releaseStop: (() => void) | undefined;
    h.sources[0].stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    h.sources[0].stopError = new Error("device already gone");

    first.socket.destroy();
    await waitFor(() => h.server.subscriberCount(DEVICE.deviceId) === 0);
    fakeTimer.advanceTime(3_000);
    const secondRequest = subscribe(h.socketPath);
    await waitFor(() => resolveCalls === 2);
    expect(h.sources).toHaveLength(1);

    releaseStop?.();
    const second = await secondRequest;
    expect(second.ack.success).toBe(true);
    expect(h.sources).toHaveLength(2);
    expect(h.sources[1].started).toBe(true);
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

  test("replays a complete cached IDR to a late iOS viewer without extending source life", async () => {
    const fakeTimer = new FakeTimer();
    const iosDevice = { ...DEVICE, platform: "ios" } as BootedDevice;
    const h = await startHarness({ timer: fakeTimer, device: iosDevice });
    await subscribe(h.socketPath);
    const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x64]);
    const pps = Buffer.from([0, 0, 0, 1, 0x68, 0xee]);
    const idr = Buffer.from([0, 0, 0, 1, 0x65, 0x80, 0xaa]);
    const secondIdrSlice = Buffer.from([0, 0, 0, 1, 0x65, 0x40, 0xbb]);
    // The key frame is the last access unit; a static screen sends no next P-frame.
    h.emit(Buffer.concat([sps, pps, idr, secondIdrSlice]));
    h.emitEncodedBoundary();
    h.setIdleSupport(true);
    h.emitIdle();
    fakeTimer.advanceTime(8_000);

    const keyFrameRequestsBeforeJoin = h.sources[0].keyFrameRequests;
    const late = await subscribe(h.socketPath);
    await waitFor(() => late.binary().includes(idr));
    expect(late.binary().includes(sps)).toBe(true);
    expect(late.binary().includes(pps)).toBe(true);
    expect(late.binary().includes(secondIdrSlice)).toBe(true);
    expect(h.sources[0].keyFrameRequests).toBe(keyFrameRequestsBeforeJoin);

    // The replay is viewer setup, not evidence that either capture stage is still producing.
    fakeTimer.advanceTime(2_000);
    await waitFor(() => h.sources[0].staleStopped);
  });

  test("active iOS capture waits for a fresh IDR instead of replaying an old one", async () => {
    const fakeTimer = new FakeTimer();
    const iosDevice = { ...DEVICE, platform: "ios" } as BootedDevice;
    const h = await startHarness({ timer: fakeTimer, device: iosDevice });
    await subscribe(h.socketPath);
    const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x64]);
    const pps = Buffer.from([0, 0, 0, 1, 0x68, 0xee]);
    const idr = Buffer.from([0, 0, 0, 1, 0x65, 0x80, 0xaa]);
    h.emit(Buffer.concat([sps, pps, idr]));
    h.emitEncodedBoundary();
    h.setIdleSupport(true);
    h.emitIdle();
    h.emitSourceFrame();

    const requestsBeforeJoin = h.sources[0].keyFrameRequests;
    const late = await subscribe(h.socketPath);
    await waitFor(() => late.binary().length > 12);
    expect(late.binary().includes(idr)).toBe(false);
    expect(h.sources[0].keyFrameRequests).toBeGreaterThan(requestsBeforeJoin);
  });

  test("idle iOS replay includes P frames after the cached IDR", async () => {
    const fakeTimer = new FakeTimer();
    const h = await startHarness({
      timer: fakeTimer,
      device: { ...DEVICE, platform: "ios" } as BootedDevice,
    });
    await subscribe(h.socketPath);
    const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x64]);
    const pps = Buffer.from([0, 0, 0, 1, 0x68, 0xee]);
    const idr = Buffer.from([0, 0, 0, 1, 0x65, 0x80, 0xaa]);
    const finalP = Buffer.from([0, 0, 0, 1, 0x41, 0x80, 0xcc]);
    h.emit(Buffer.concat([sps, pps, idr]));
    h.emitEncodedBoundary();
    h.emit(finalP);
    h.emitEncodedBoundary();
    h.setIdleSupport(true);
    h.emitIdle();
    const late = await subscribe(h.socketPath);
    await waitFor(() => late.binary().includes(finalP));
    expect(late.binary().includes(idr)).toBe(true);
  });

  test("raw idle evidence never flushes a partial ffmpeg NAL", async () => {
    const h = await startHarness({ device: { ...DEVICE, platform: "ios" } as BootedDevice });
    await subscribe(h.socketPath);
    const partial = Buffer.from([0, 0, 0, 1, 0x65, 0x80]);
    h.emit(partial);
    h.setIdleSupport(true);
    h.emitIdle();
    const late = await subscribe(h.socketPath);
    expect(late.binary().includes(partial)).toBe(false);
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

  test("backpressured subscribers skip dropped telemetry and recover with an immediate key frame", async () => {
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
    h.emitDroppedFrames(42);

    // Baseline AFTER the subscribe-time IDR request: while the subscriber is still stuck (no drain
    // yet) the count must not climb further.
    const before = source.keyFrameRequests;

    // Resume reading: the socket drains, and the drain handler asks the encoder for an immediate IDR
    // rather than leaving this subscriber frozen until the next natural key frame (a whole GOP away).
    client.socket.resume();
    await waitFor(() => source.keyFrameRequests > before);

    expect(source.keyFrameRequests).toBeGreaterThan(before);
    expect(client.binary().includes(encodeDroppedFrames(42))).toBe(false);
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
    // natural GOP — the multi-second freeze this recovery exists to prevent. Advance only the
    // retry budget so the capture-liveness deadline does not replace the source during this test.
    const fakeTimer = new FakeTimer();
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
    await waitFor(() => source.keyFrameRequests >= before + 1);
    fakeTimer.advanceTime(2_000);
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

  test("clears a heartbeat armed by startup media when capture start fails", async () => {
    const fakeTimer = new FakeTimer();
    const h = await startHarness({
      timer: fakeTimer,
      startData: Buffer.from([0, 0, 0, 1, 5, 0xaa, 0, 0, 0, 1, 1]),
      startError: new Error("encoder failed"),
    });

    const { ack } = await subscribe(h.socketPath);

    expect(ack.success).toBe(false);
    expect(fakeTimer.getPendingIntervalCount()).toBe(0);
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
    function ownershipHarness(): {
      source: DeviceOwnershipChanges;
      changed: (deviceId: string) => void;
      listenerCount: () => number;
    } {
      const listeners = new Set<(deviceId: string) => void>();
      return {
        source: {
          onDeviceOwnershipChange: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        },
        changed: (deviceId) => {
          for (const listener of listeners) {
            listener(deviceId);
          }
        },
        listenerCount: () => listeners.size,
      };
    }

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

    test("rejects an omitted deviceId when the resolved device belongs to another session", async () => {
      const h = await startHarness({
        authenticator: enforcing(
          fakeSessionManager({ getSessionForDevice: () => "other-session" }),
        ),
      });
      const { ack } = await subscribe(h.socketPath, {
        action: "subscribe",
        sessionUuid: "session-1",
      });
      expect(ack.success).toBe(false);
      expect(String(ack.error)).toContain("different daemon session");
      expect(h.sources).toHaveLength(0);
    });

    test("accepts an omitted deviceId when the resolved device belongs to the caller", async () => {
      const h = await startHarness({
        authenticator: enforcing(fakeSessionManager({ getSessionForDevice: () => "session-1" })),
      });
      const { ack } = await subscribe(h.socketPath, {
        action: "subscribe",
        sessionUuid: "session-1",
      });
      expect(ack.success).toBe(true);
      expect(h.sources).toHaveLength(1);
    });

    test("revokes an unowned-device subscriber when another session claims it", async () => {
      const timer = new FakeTimer();
      const ownership = ownershipHarness();
      let owner: string | null = null;
      const h = await startHarness({
        timer,
        ownershipChanges: () => ownership.source,
        authenticator: enforcing(
          fakeSessionManager({
            getSession: (uuid) => (uuid === "session-1" || uuid === "session-2" ? {} : null),
            getSessionForDevice: () => owner,
          }),
        ),
      });
      const oldViewer = await subscribe(h.socketPath, {
        action: "subscribe",
        deviceId: DEVICE.deviceId,
        sessionUuid: "session-1",
      });
      const newViewer = await subscribe(h.socketPath, {
        action: "subscribe",
        deviceId: DEVICE.deviceId,
        sessionUuid: "session-2",
      });
      expect(h.server.subscriberCount(DEVICE.deviceId)).toBe(2);

      owner = "session-2";
      ownership.changed(DEVICE.deviceId);
      expect(h.server.subscriberCount(DEVICE.deviceId)).toBe(1);
      await waitFor(() => oldViewer.binary().includes(Buffer.from('"terminal":true')));
      expect(oldViewer.binary().toString()).toContain('"action":"unsubscribe"');
      expect(oldViewer.binary().toString()).toContain("Video stream ended: authorization changed");
      expect(newViewer.binary().toString()).not.toContain('"terminal":true');
      expect(h.sources[0].consumerStates.at(-1)).toBe(true);

      owner = "session-1";
      ownership.changed(DEVICE.deviceId);
      expect(h.server.subscriberCount(DEVICE.deviceId)).toBe(0);
      await waitFor(() => newViewer.binary().includes(Buffer.from('"terminal":true')));
      timer.advanceTime(3_000);
      await waitFor(() => h.sources[0].stopped);
    });

    test("release revokes the subscriber and stops capture after idle grace", async () => {
      const timer = new FakeTimer();
      const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
      await manager.createSession("session-1", DEVICE.deviceId, "android");
      const h = await startHarness({
        timer,
        ownershipChanges: () => manager,
        authenticator: enforcing(manager),
      });
      const viewer = await subscribe(h.socketPath, {
        action: "subscribe",
        deviceId: DEVICE.deviceId,
        sessionUuid: "session-1",
      });
      expect(viewer.ack.success).toBe(true);

      await manager.releaseSession("session-1", "explicit-release");

      expect(h.server.subscriberCount(DEVICE.deviceId)).toBe(0);
      await waitFor(() => viewer.binary().includes(Buffer.from('"terminal":true')));
      expect(viewer.binary().toString()).toContain('"action":"unsubscribe"');
      await waitFor(() => viewer.socket.destroyed);
      expect(h.sources[0].stopped).toBe(false);
      timer.advanceTime(3_000);
      await waitFor(() => h.sources[0].stopped);
      manager.stopCleanupTimer();
    });

    test("rebind revokes a subscriber while its session remains live", async () => {
      const ownership = ownershipHarness();
      let owner: string | null = "session-1";
      const h = await startHarness({
        ownershipChanges: () => ownership.source,
        authenticator: enforcing(fakeSessionManager({ getSessionForDevice: () => owner })),
      });
      const viewer = await subscribe(h.socketPath, {
        action: "subscribe",
        deviceId: DEVICE.deviceId,
        sessionUuid: "session-1",
      });
      owner = null;
      ownership.changed(DEVICE.deviceId);

      expect(h.server.subscriberCount(DEVICE.deviceId)).toBe(0);
      await waitFor(() => viewer.binary().includes(Buffer.from('"terminal":true')));
      expect(viewer.binary().toString()).toContain('"action":"unsubscribe"');
    });

    test("auth off leaves subscribers attached after ownership changes", async () => {
      const ownership = ownershipHarness();
      const auth = new SessionScopedStreamAuthenticator(() => null, "video-stream subscribe", {
        [STREAM_SOCKET_AUTH_ENV]: "0",
      } as NodeJS.ProcessEnv);
      const h = await startHarness({
        ownershipChanges: () => ownership.source,
        authenticator: auth,
      });
      const viewer = await subscribe(h.socketPath);

      ownership.changed(DEVICE.deviceId);

      expect(viewer.ack.success).toBe(true);
      expect(h.server.subscriberCount(DEVICE.deviceId)).toBe(1);
      expect(viewer.binary().toString()).not.toContain('"terminal":true');
    });

    test("an authorization error for one subscriber leaves the other streaming", async () => {
      const ownership = ownershipHarness();
      let rejectFirst = false;
      const h = await startHarness({
        ownershipChanges: () => ownership.source,
        authenticator: {
          authorize: ({ sessionUuid }) => {
            if (rejectFirst && sessionUuid === "session-1") {
              throw new ActionableError("Session lost access");
            }
          },
        },
      });
      const first = await subscribe(h.socketPath, {
        action: "subscribe",
        deviceId: DEVICE.deviceId,
        sessionUuid: "session-1",
      });
      const second = await subscribe(h.socketPath, {
        action: "subscribe",
        deviceId: DEVICE.deviceId,
        sessionUuid: "session-2",
      });
      rejectFirst = true;
      ownership.changed(DEVICE.deviceId);
      expect(h.server.subscriberCount(DEVICE.deviceId)).toBe(1);
      await waitFor(() => first.binary().includes(Buffer.from('"terminal":true')));
      expect(second.binary().toString()).not.toContain('"terminal":true');
    });

    test("removes the ownership listener on close", async () => {
      const ownership = ownershipHarness();
      const h = await startHarness({ ownershipChanges: () => ownership.source });
      expect(ownership.listenerCount()).toBe(1);
      await h.server.close();
      expect(ownership.listenerCount()).toBe(0);
    });
  });
});
