import { afterEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { isDebugPerfEnabled, setDebugPerfEnabled } from "../../src/utils/PerformanceTracker";

describe("Daemon debug perf option", () => {
  afterEach(() => {
    setDebugPerfEnabled(false);
    // Constructing a Daemon initializes the global DaemonState singleton.
    // Reset it so this test does not leak initialized state into other test
    // files (bun shares module/singleton state across files in a run, and file
    // execution order is platform-dependent).
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
  });

  test("applies debugPerf option to global performance tracking", () => {
    setDebugPerfEnabled(false);

    new Daemon({ debugPerf: true });

    expect(isDebugPerfEnabled()).toBe(true);
  });
});
