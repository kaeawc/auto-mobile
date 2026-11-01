import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createDeviceCaptureRegistry } from "../../src/features/webrtc/deviceCaptureRegistry";
import { VideoStreamSocketServer } from "../../src/daemon/videoStreamSocketServer";
import { BaseSocketServer } from "../../src/daemon/socketServer/BaseSocketServer";
import type { StreamSocketAuthenticator } from "../../src/daemon/streamSocketAuth";
import type { H264CaptureSource } from "../../src/features/webrtc/H264CaptureSource";
import type { BootedDevice } from "../../src/models";
import { FakeSocket } from "../fakes/FakeNetServer";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";

// Owner contract: daemon shutdown with live streams releases within the shutdown stage budget.
// The relay's close() used to await `capture.source.stop()` bare, so a capture whose stop wedges
// (the persistent-encoder teardown awaits adb forward cleanup against the device) held the
// "video stream socket server" shutdown stage until the process limit (#11601). close() now
// bounds the stop the way the WebRTC server bounds its own close, and says what it abandoned.

const device = { deviceId: "wedged-device", platform: "android", name: "Fake" } as BootedDevice;

class WedgedStopSource implements H264CaptureSource {
  constructor(private readonly wedged: boolean) {}
  async start(): Promise<void> {}
  stop(): Promise<void> {
    return this.wedged ? new Promise<void>(() => {}) : Promise.resolve();
  }
  requestKeyFrame(): boolean {
    return true;
  }
  setHasConsumers(): void {}
}

class TestServer extends VideoStreamSocketServer {
  line(socket: FakeSocket, request: unknown): Promise<void> {
    return this.processLine(socket, JSON.stringify(request));
  }
}

const allowAll: StreamSocketAuthenticator = {
  authorize: () => {},
  isAuthenticationEnforced: () => true,
};

const servers: TestServer[] = [];
afterEach(() => {
  servers.length = 0;
});

interface CloseOutcome {
  settled: boolean;
  settledAtMs: number | undefined;
  activeDeviceIds: string[];
  warnings: string[];
}

async function closeWithStreamingViewer(wedged: boolean): Promise<CloseOutcome> {
  const warnings: string[] = [];
  const warn = spyOn(logger, "warn").mockImplementation((message: string) => {
    warnings.push(message);
  });
  try {
    const timer = new FakeTimer();
    const server = new TestServer(
      {
        resolveDevice: async () => device,
        captureRegistry: createDeviceCaptureRegistry(),
        createCaptureSource: async () => new WedgedStopSource(wedged),
        nowUs: () => 1000n,
      },
      "/unused/video-relay-shutdown.sock",
      timer,
      { authenticator: allowAll, admissionGate: { assertDeviceActionable: () => {} } },
    );
    servers.push(server);
    const bind = spyOn(BaseSocketServer.prototype, "start").mockResolvedValue(undefined);
    try {
      await server.start();
    } finally {
      bind.mockRestore();
    }
    const socket = new FakeSocket();
    await server.line(socket, {
      action: "subscribe",
      sessionUuid: "viewer",
      deviceId: device.deviceId,
    });
    expect(server.subscriberCount(device.deviceId)).toBe(1);

    let settled = false;
    let settledAtMs: number | undefined;
    void server.close().then(() => {
      settled = true;
      settledAtMs = timer.now();
    });
    for (let i = 0; i < 9; i++) {
      timer.advanceTime(1_000);
      for (let j = 0; j < 12; j++) {
        await Promise.resolve();
      }
    }

    return { settled, settledAtMs, activeDeviceIds: server.activeDeviceIds(), warnings };
  } finally {
    warn.mockRestore();
  }
}

describe("video relay shutdown with a wedged capture stop", () => {
  test("control: close() settles at once and warns about nothing when the capture stops", async () => {
    const outcome = await closeWithStreamingViewer(false);

    expect(outcome.settled).toBe(true);
    expect(outcome.settledAtMs).toBeLessThan(5_000);
    expect(outcome.warnings).toEqual([]);
  });

  test("close() abandons a source.stop() that never returns after 5 s and finishes socket teardown", async () => {
    const outcome = await closeWithStreamingViewer(true);

    expect(outcome.settled).toBe(true);
    expect(outcome.settledAtMs).toBe(5_000);
    expect(outcome.activeDeviceIds).toEqual([]);
    expect(outcome.warnings).toEqual([
      "[VideoStream] shutdown abandoned the capture stop for wedged-device after 5000ms; continuing socket teardown",
    ]);
  });
});
