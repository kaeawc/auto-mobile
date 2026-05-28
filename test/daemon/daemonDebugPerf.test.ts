import { afterEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { isDebugPerfEnabled, setDebugPerfEnabled } from "../../src/utils/PerformanceTracker";

describe("Daemon debug perf option", () => {
  afterEach(() => {
    setDebugPerfEnabled(false);
  });

  test("applies debugPerf option to global performance tracking", () => {
    setDebugPerfEnabled(false);

    new Daemon({ debugPerf: true });

    expect(isDebugPerfEnabled()).toBe(true);
  });
});
