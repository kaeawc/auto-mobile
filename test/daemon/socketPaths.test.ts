import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { SOCKET_PATH } from "../../src/daemon/constants";
import { getDaemonSocketPathsByName } from "../../src/daemon/socketPaths";
import {
  AUXILIARY_SOCKET_CONFIGS_BY_NAME,
  getDaemonSocketPathList,
} from "../../src/daemon/daemonFiles";
import { getSocketPath } from "../../src/daemon/socketServer/index";

describe("daemon socket paths", () => {
  test("publishes all default socket paths", () => {
    expect(getDaemonSocketPathsByName()).toEqual({
      control: SOCKET_PATH,
      appearance: path.join(os.homedir(), ".auto-mobile", "appearance.sock"),
      "device-snapshot": path.join(os.homedir(), ".auto-mobile", "device-snapshot.sock"),
      "failures-push": path.join(os.homedir(), ".auto-mobile", "failures-push.sock"),
      "failures-stream": path.join(os.homedir(), ".auto-mobile", "failures-stream.sock"),
      "observation-stream": path.join(os.homedir(), ".auto-mobile", "observation-stream.sock"),
      "performance-push": path.join(os.homedir(), ".auto-mobile", "performance-push.sock"),
      "performance-stream": path.join(os.homedir(), ".auto-mobile", "performance-stream.sock"),
      "telemetry-push": path.join(os.homedir(), ".auto-mobile", "telemetry-push.sock"),
      "test-recording": path.join(os.homedir(), ".auto-mobile", "test-recording.sock"),
      "video-recording": path.join(os.homedir(), ".auto-mobile", "video-recording.sock"),
      // Issue #4195: started by the daemon but previously absent from both registries.
      "video-stream": path.join(os.homedir(), ".auto-mobile", "video-stream.sock"),
      "webrtc-stream": path.join(os.homedir(), ".auto-mobile", "webrtc-stream.sock"),
    });
  });

  test("cleanup path list unlinks every published socket", () => {
    const published = Object.values(getDaemonSocketPathsByName());
    const cleanupPaths = getDaemonSocketPathList();

    for (const socketPath of published) {
      expect(cleanupPaths).toContain(socketPath);
    }
    expect(cleanupPaths.length).toBe(published.length);
  });

  test("cleanup list and keyed map are anchored to the same registry", () => {
    const published = getDaemonSocketPathsByName();
    const auxiliaryNames = Object.keys(AUXILIARY_SOCKET_CONFIGS_BY_NAME).sort();

    expect(
      Object.keys(published)
        .filter((name) => name !== "control")
        .sort(),
    ).toEqual(auxiliaryNames);

    for (const [name, config] of Object.entries(AUXILIARY_SOCKET_CONFIGS_BY_NAME)) {
      expect(path.basename(getSocketPath(config))).toBe(`${name}.sock`);
    }
  });
});
