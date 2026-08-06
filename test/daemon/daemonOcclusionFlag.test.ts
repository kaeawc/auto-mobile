import { afterEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { parseDaemonArgs } from "../../src/daemon/manager";
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

/**
 * The MCP-process -> daemon-process hand-off (issue occlusion-flag): when the daemon is
 * auto-spawned or explicitly managed via `--daemon start`, the parent relays flags to the
 * child daemon subprocess as CLI args (DaemonManager.withDaemonOptions), and the child parses
 * them back into DaemonOptions via parseDaemonArgs. --no-occlusion was previously missing from
 * both halves of this relay, so a parent process that parsed --no-occlusion never actually
 * forwarded it to the daemon subprocess that holds the ServerConfig singleton consulted during
 * extraction, silently leaving occlusion on regardless of the flag.
 */
describe("parseDaemonArgs --no-occlusion (daemon-side of the MCP-process -> daemon-process relay)", () => {
  test("defaults to undefined when no flag is passed", () => {
    expect(parseDaemonArgs([]).noOcclusion).toBeUndefined();
  });

  test("--no-occlusion sets noOcclusion", () => {
    expect(parseDaemonArgs(["--no-occlusion"]).noOcclusion).toBe(true);
  });
});
