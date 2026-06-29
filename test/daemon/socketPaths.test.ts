import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { SOCKET_PATH } from "../../src/daemon/constants";
import { getDaemonSocketPaths } from "../../src/daemon/socketPaths";

describe("daemon socket paths", () => {
  const originalExternalMode = process.env.AUTOMOBILE_EMULATOR_EXTERNAL;

  afterEach(() => {
    if (originalExternalMode === undefined) {
      delete process.env.AUTOMOBILE_EMULATOR_EXTERNAL;
    } else {
      process.env.AUTOMOBILE_EMULATOR_EXTERNAL = originalExternalMode;
    }
  });

  test("publishes all default socket paths", () => {
    delete process.env.AUTOMOBILE_EMULATOR_EXTERNAL;

    expect(getDaemonSocketPaths()).toEqual({
      "control": SOCKET_PATH,
      "appearance": path.join(os.homedir(), ".auto-mobile", "appearance.sock"),
      "device-snapshot": path.join(os.homedir(), ".auto-mobile", "device-snapshot.sock"),
      "failures-push": path.join(os.homedir(), ".auto-mobile", "failures-push.sock"),
      "failures-stream": path.join(os.homedir(), ".auto-mobile", "failures-stream.sock"),
      "observation-stream": path.join(os.homedir(), ".auto-mobile", "observation-stream.sock"),
      "performance-push": path.join(os.homedir(), ".auto-mobile", "performance-push.sock"),
      "performance-stream": path.join(os.homedir(), ".auto-mobile", "performance-stream.sock"),
      "telemetry-push": path.join(os.homedir(), ".auto-mobile", "telemetry-push.sock"),
      "test-recording": path.join(os.homedir(), ".auto-mobile", "test-recording.sock"),
      "video-recording": path.join(os.homedir(), ".auto-mobile", "video-recording.sock"),
    });
  });

  test("publishes external-mode socket paths", () => {
    process.env.AUTOMOBILE_EMULATOR_EXTERNAL = "true";

    expect(getDaemonSocketPaths()).toEqual({
      "control": SOCKET_PATH,
      "appearance": "/tmp/auto-mobile-appearance.sock",
      "device-snapshot": "/tmp/auto-mobile-device-snapshot.sock",
      "failures-push": "/tmp/auto-mobile-failures-push.sock",
      "failures-stream": "/tmp/auto-mobile-failures-stream.sock",
      "observation-stream": "/tmp/auto-mobile-observation-stream.sock",
      "performance-push": "/tmp/auto-mobile-performance-push.sock",
      "performance-stream": "/tmp/auto-mobile-performance-stream.sock",
      "telemetry-push": "/tmp/auto-mobile-telemetry-push.sock",
      "test-recording": "/tmp/auto-mobile-test-recording.sock",
      "video-recording": "/tmp/auto-mobile-video-recording.sock",
    });
  });
});
