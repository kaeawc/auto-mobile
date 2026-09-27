import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { resolveAuxSocketDir } from "../../../src/daemon/socketServer/index";
import {
  DEVICE_DATA_STREAM_SOCKET_CONFIG,
  WEBRTC_STREAM_SOCKET_CONFIG,
} from "../../../src/daemon/daemonFiles";
import { testOverrides } from "../../../src/utils/testOverrides";

describe("resolveAuxSocketDir", () => {
  const originalOverride = testOverrides.auxSocketDir;
  const originalEnv = process.env.AUTOMOBILE_AUX_SOCKET_DIR;
  const originalWebRtcEnv = process.env.AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH;
  const originalLegacyWebRtcEnv = process.env.AUTO_MOBILE_WEBRTC_STREAM_SOCKET_PATH;

  afterEach(() => {
    testOverrides.auxSocketDir = originalOverride;
    if (originalEnv === undefined) {
      delete process.env.AUTOMOBILE_AUX_SOCKET_DIR;
    } else {
      process.env.AUTOMOBILE_AUX_SOCKET_DIR = originalEnv;
    }
    if (originalWebRtcEnv === undefined) {
      delete process.env.AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH;
    } else {
      process.env.AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH = originalWebRtcEnv;
    }
    if (originalLegacyWebRtcEnv === undefined) {
      delete process.env.AUTO_MOBILE_WEBRTC_STREAM_SOCKET_PATH;
    } else {
      process.env.AUTO_MOBILE_WEBRTC_STREAM_SOCKET_PATH = originalLegacyWebRtcEnv;
    }
  });

  test("uses the home directory when neither override is set", () => {
    testOverrides.auxSocketDir = undefined;
    expect(resolveAuxSocketDir({})).toBe(path.join(os.homedir(), ".auto-mobile"));
  });

  test("uses the environment directory when the test override is cleared", () => {
    testOverrides.auxSocketDir = undefined;
    expect(resolveAuxSocketDir({ AUTOMOBILE_AUX_SOCKET_DIR: "/isolated-daemon" })).toBe(
      "/isolated-daemon",
    );
  });

  test("test override takes precedence over an exported environment directory", () => {
    testOverrides.auxSocketDir = "test-only";
    expect(resolveAuxSocketDir({ AUTOMOBILE_AUX_SOCKET_DIR: "/user-daemon" })).toBe("test-only");
  });

  test("anchors a relative environment directory to the daemon launch cwd", () => {
    testOverrides.auxSocketDir = undefined;
    expect(
      resolveAuxSocketDir({
        AUTOMOBILE_AUX_SOCKET_DIR: "relative",
        AUTOMOBILE_DAEMON_LAUNCH_CWD: path.resolve("/tmp/original"),
      }),
    ).toBe(path.resolve("/tmp/original", "relative"));
  });

  test("trims environment directories and ignores blank overrides", () => {
    testOverrides.auxSocketDir = undefined;
    const absolute = path.resolve("/isolated-daemon");
    expect(resolveAuxSocketDir({ AUTOMOBILE_AUX_SOCKET_DIR: `  ${absolute}  ` })).toBe(absolute);
    expect(resolveAuxSocketDir({ AUTOMOBILE_AUX_SOCKET_DIR: "  " })).toBe(
      path.join(os.homedir(), ".auto-mobile"),
    );
  });

  test("uses the in-process test override when the environment is unset", () => {
    testOverrides.auxSocketDir = "/test-only";
    delete process.env.AUTOMOBILE_AUX_SOCKET_DIR;
    delete process.env.AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH;
    delete process.env.AUTO_MOBILE_WEBRTC_STREAM_SOCKET_PATH;
    expect(resolveAuxSocketDir()).toBe("/test-only");
    expect(DEVICE_DATA_STREAM_SOCKET_CONFIG.defaultPath).toBe(
      path.join("/test-only", "observation-stream.sock"),
    );
    expect(WEBRTC_STREAM_SOCKET_CONFIG.defaultPath).toBe(
      path.join("/test-only", "webrtc-stream.sock"),
    );
  });
});
