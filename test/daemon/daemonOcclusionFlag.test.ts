import { afterEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { serverConfig } from "../../src/utils/ServerConfig";

describe("Daemon --no-occlusion option", () => {
  afterEach(() => {
    serverConfig.setOcclusionEnabled(true);
    // Constructing a Daemon initializes the global DaemonState singleton.
    // Reset it so this test does not leak initialized state into other test
    // files (bun shares module/singleton state across files in a run, and file
    // execution order is platform-dependent).
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
  });

  test("occlusion stays enabled when noOcclusion is not set", () => {
    new Daemon({});

    expect(serverConfig.getAccessibilityFlagsConfig().occlusionEnabled).toBe(true);
  });

  test("applies noOcclusion option to disable the occlusion pass", () => {
    new Daemon({ noOcclusion: true });

    expect(serverConfig.getAccessibilityFlagsConfig().occlusionEnabled).toBe(false);
  });
});
