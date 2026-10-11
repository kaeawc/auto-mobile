import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createDeviceCaptureRegistry } from "../../../src/features/webrtc/deviceCaptureRegistry";
import { VideoStreamSocketServer } from "../../../src/daemon/videoStreamSocketServer";
import { BaseSocketServer } from "../../../src/daemon/socketServer/BaseSocketServer";
import type { StreamSocketAuthenticator } from "../../../src/daemon/streamSocketAuth";
import type { H264CaptureSource } from "../../../src/features/webrtc/H264CaptureSource";
import type { BootedDevice } from "../../../src/models";
import { FakeSocket } from "../../fakes/FakeNetServer";
import { FakeTimer } from "../../fakes/FakeTimer";

// Owner contract: "daemon shutdown with live streams (released within the shutdown stage budget)".
// `Daemon.stop()` runs its cleanup stages strictly one after another with no per-stage deadline
// (src/shutdownCleanup.ts), and the process has a ~9 s limit (#11156). The WebRTC server bounds
// its own close with WEBRTC_SOCKET_CLOSE_TIMEOUT_MS (5 s); the video relay's close() awaits
// `capture.source.stop()` bare. A capture whose stop wedges (the persistent-encoder teardown
// awaits adb forward cleanup against the device) therefore holds the "video stream socket server"
// stage forever, and every later stage (Unix socket, session release, database close, pid file)
// is skipped when the process limit hits.

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

async function closeWithStreamingViewer(wedged: boolean): Promise<boolean> {
  {
    const timer = new FakeTimer();
    const server = new TestServer(
      {
        resolveDevice: async () => device,
        captureRegistry: createDeviceCaptureRegistry(),
        createCaptureSource: async () => new WedgedStopSource(wedged),
        nowUs: () => 1000n,
      },
      "/unused/hunt-video.sock",
      timer,
      allowAll,
      { assertDeviceActionable: () => {} },
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
    void server.close().then(() => {
      settled = true;
    });
    for (let i = 0; i < 9; i++) {
      timer.advanceTime(1_000);
      for (let j = 0; j < 12; j++) {
        await Promise.resolve();
      }
    }

    return settled;
  }
}

describe("video relay shutdown with a wedged capture stop", () => {
  test("control: close() settles when the capture stops", async () => {
    expect(await closeWithStreamingViewer(false)).toBe(true);
  });

  test("close() settles within the 9 s process limit even if source.stop() never returns", async () => {
    expect(await closeWithStreamingViewer(true)).toBe(true);
  });
});
