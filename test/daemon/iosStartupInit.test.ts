import { describe, expect, spyOn, test } from "bun:test";
import { initializeIosCtrlProxyAtStartup } from "../../src/daemon/iosStartupInit";
import { CtrlProxyStaleRunnerCacheError } from "../../src/utils/IOSCtrlProxyBuilder";
import { ActionableError } from "../../src/models/ActionableError";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Startup CtrlProxy iOS init must not race the background runner-bundle
 * prefetch (#7032): it awaits an in-flight prefetch under its per-device budget
 * and, when the budget expires or the cached runner is a known stale release,
 * defers setup to the first tool call instead of raising a tampering error.
 */
describe("initializeIosCtrlProxyAtStartup (#7032)", () => {
  const BUDGET_MS = 5_000;

  /**
   * Messages logged through `spy` by this module. Scoped by its wording because
   * other suites' leaked async work may log unrelated `[Daemon]` lines.
   */
  function daemonMessages(spy: { mock: { calls: unknown[][] } }): string[] {
    return spy.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.startsWith("[Daemon]") && message.includes("CtrlProxy iOS"));
  }

  function recordingVerify(): {
    verify: (deviceId: string) => Promise<void>;
    calls: string[];
  } {
    const calls: string[] = [];
    return {
      calls,
      verify: async (deviceId: string) => {
        calls.push(deviceId);
      },
    };
  }

  test("awaits an in-flight prefetch, then verifies every device with the new runner", async () => {
    const timer = new FakeTimer();
    const prefetch = Promise.withResolvers<null>();
    const { verify, calls } = recordingVerify();

    const init = initializeIosCtrlProxyAtStartup(["sim-a", "sim-b"], {
      timer,
      perDeviceTimeoutMs: BUDGET_MS,
      pendingPrefetch: () => prefetch.promise,
      verifyIosDevice: verify,
    });
    // Nothing is verified while the prefetch is still replacing the runner.
    await Promise.resolve();
    expect(calls).toEqual([]);

    prefetch.resolve(null);
    const result = await init;

    expect(calls).toEqual(["sim-a", "sim-b"]);
    expect(result).toEqual({ ready: ["sim-a", "sim-b"], deferred: [] });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a prefetch slower than the budget defers setup to the first tool call at info", async () => {
    const timer = new FakeTimer();
    const prefetch = Promise.withResolvers<null>();
    const { verify, calls } = recordingVerify();
    const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const init = initializeIosCtrlProxyAtStartup(["sim-a"], {
        timer,
        perDeviceTimeoutMs: BUDGET_MS,
        pendingPrefetch: () => prefetch.promise,
        verifyIosDevice: verify,
      });
      await Promise.resolve();
      timer.advanceTime(BUDGET_MS);
      const result = await init;

      expect(result).toEqual({ ready: [], deferred: ["sim-a"] });
      expect(calls).toEqual([]);
      expect(daemonMessages(warnSpy)).toEqual([]);
      const infoMessages = infoSpy.mock.calls.map((call) => String(call[0]));
      expect(infoMessages.some((m) => m.includes("deferring CtrlProxy iOS setup"))).toBe(true);
      expect(infoMessages.join("\n")).not.toContain("tampering");

      // The prefetch landing later does not need startup: the first tool call
      // (modelled by a fresh verify) succeeds against the new runner.
      prefetch.resolve(null);
      await verify("sim-a");
      expect(calls).toEqual(["sim-a"]);
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("a stale-cache pre-launch refusal is deferred at info, not logged as a failure", async () => {
    const timer = new FakeTimer();
    const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await initializeIosCtrlProxyAtStartup(["sim-a"], {
        timer,
        perDeviceTimeoutMs: BUDGET_MS,
        pendingPrefetch: () => null,
        verifyIosDevice: async () => {
          throw new CtrlProxyStaleRunnerCacheError("0.0.71", "0.0.72");
        },
      });

      expect(result).toEqual({ ready: [], deferred: ["sim-a"] });
      expect(daemonMessages(warnSpy)).toEqual([]);
      const infoMessages = infoSpy.mock.calls.map((call) => String(call[0]));
      expect(infoMessages.some((m) => m.includes("cached CtrlProxy runner is from 0.0.71"))).toBe(
        true,
      );
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("any other per-device failure keeps the warn and moves on to the next device", async () => {
    const timer = new FakeTimer();
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await initializeIosCtrlProxyAtStartup(["sim-a", "sim-b"], {
        timer,
        perDeviceTimeoutMs: BUDGET_MS,
        pendingPrefetch: () => null,
        verifyIosDevice: async (deviceId) => {
          if (deviceId === "sim-a") {
            throw new ActionableError("possible TOCTOU tampering");
          }
        },
      });

      expect(result).toEqual({ ready: ["sim-b"], deferred: [] });
      const warned = daemonMessages(warnSpy);
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("sim-a");
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("the per-device budget aborts a hung verify via the injected timer", async () => {
    const timer = new FakeTimer();
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const init = initializeIosCtrlProxyAtStartup(["sim-a"], {
        timer,
        perDeviceTimeoutMs: BUDGET_MS,
        pendingPrefetch: () => null,
        verifyIosDevice: (_deviceId, options) =>
          new Promise<void>((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(options.signal.reason));
          }),
      });
      await Promise.resolve();
      timer.advanceTime(BUDGET_MS);
      const result = await init;

      expect(result).toEqual({ ready: [], deferred: [] });
      const warned = daemonMessages(warnSpy);
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain(`Timeout after ${BUDGET_MS}ms`);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
