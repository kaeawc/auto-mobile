import { FakeRunnerLaunchProgressProbe } from "../../fakes/FakeRunnerLaunchProgressProbe";
import { describe, expect, mock, test, spyOn } from "bun:test";
import { IosCtrlProxyReadiness } from "../../../src/ctrlProxy/ios/IosCtrlProxyReadiness";
import type { SharedCtrlProxyStart } from "../../../src/ctrlProxy/ios/IosCtrlProxyLifecycleSteps";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { sequenceBackoff } from "../../../src/utils/Backoff";
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeIosTunnelClient } from "../../fakes/FakeIosTunnelClient";
import { settleByFakeEvents } from "../../helpers/fakeTimerStepping";

function createHarness(isSimulator = true) {
  const timer = new FakeTimer();
  const tunnelClient = new FakeIosTunnelClient();
  const unexpectedStep = async (): Promise<never> => {
    throw new Error("Unexpected runner lifecycle step");
  };
  const state: ConstructorParameters<typeof IosCtrlProxyReadiness>[0] = {
    timer,
    runnerLaunchProgressProbe: new FakeRunnerLaunchProgressProbe(),
    tunnelClient,
    device: { deviceId: "test-ios-device", platform: "ios", name: "Test iPhone" },
    xcTestProcessId: null,
    xcTestProcess: null,
    servicePort: 8767,
    isStopping: false,
    retiredRunnerPids: new Set(),
    runnerGenerationTokens: new Map(),
    steps: {
      startInternal: unexpectedStep,
      waitForNonJoinableStart: unexpectedStep,
      retireRunnerAfterFinalSharedStartCancellation: unexpectedStep,
      startOnSimulator: unexpectedStep,
      startOnDevice: unexpectedStep,
      waitForHealthEndpoint: (...args) => readiness.waitForHealthEndpoint(...args),
      completeHealthStartup: (...args) => readiness.completeHealthStartup(...args),
      isOwnRunnerProcessAlive: unexpectedStep,
      terminateHungRunnerProcess: unexpectedStep,
      terminateTrackedRunner: unexpectedStep,
      uninstallLegacyAppIfPresent: unexpectedStep,
      fenceLateRemoteStartAfterShutdown: unexpectedStep,
    },
  };
  const host: ConstructorParameters<typeof IosCtrlProxyReadiness>[1] = {
    isSimulator: () => isSimulator,
    checkHealthEndpointOnPortForDevice: mock(async () => false),
    adoptServicePort: mock((port: number) => {
      state.servicePort = port;
    }),
    clearCaches: mock(() => {}),
    startProcessSupervision: mock(async () => {}),
    assertDeviceNotRetired: () => {},
    prepareSimulatorRunner: unexpectedStep,
    prepareDeviceRunner: unexpectedStep,
    checkHealthEndpoint: mock(async () => false),
    resolveHealthPollMaxAttempts: () => 60,
  };
  const readiness = new IosCtrlProxyReadiness(state, host);
  const start: SharedCtrlProxyStart = {
    controller: new AbortController(),
    completion: Promise.resolve(),
    healthPollDeadlineMs: 6_000,
    defaultHealthPollDeadlineMs: 6_000,
    callerHealthPollDeadlinesMs: new Map(),
    teardownCommitted: false,
    waitingCallers: 1,
    externalWaitingCallers: 1,
    completed: false,
  };
  return { timer, tunnelClient, state, host, readiness, start, perf: new NoOpPerformanceTracker() };
}

describe("IosCtrlProxyReadiness health startup", () => {
  test.each([true, false])(
    "completeHealthStartup does not sleep after health success (simulator=%s)",
    async (isSimulator) => {
      const { readiness, start, perf, timer, host, tunnelClient } = createHarness(isSimulator);
      await settleByFakeEvents(timer, readiness.completeHealthStartup(start, perf), {
        description: "health startup completion",
      });
      expect(timer.getSleepHistory()).toEqual([]);
      expect(timer.now()).toBe(0);
      expect(host.clearCaches).toHaveBeenCalledTimes(1);
      expect(host.startProcessSupervision).toHaveBeenCalledTimes(1);
      expect(tunnelClient.supervisionStarts).toBe(isSimulator ? 0 : 1);
    },
  );

  test("polls every 100ms for five seconds, then backs off to 500ms", async () => {
    const { readiness, start, perf, timer, host } = createHarness();
    // A nonzero clock ensures the fast window is relative to polling, not epoch time.
    timer.advanceTime(20_000);
    start.healthPollDeadlineMs = timer.now() + 6_000;
    host.checkHealthEndpoint = mock(async () => timer.now() >= 26_000);
    const ready = await settleByFakeEvents(
      timer,
      readiness.waitForHealthEndpoint(start, perf, 500),
      { description: "health polling" },
    );
    expect(ready).toBe(true);
    expect(timer.getSleepHistory()).toEqual([...Array<number>(50).fill(100), 500, 500]);
    expect(timer.now()).toBe(26_000);
  });

  test("still rejects cancellation during process supervision without sleeping", async () => {
    const { readiness, start, perf, timer, host, tunnelClient } = createHarness(false);
    const reason = new Error("startup cancelled");
    host.startProcessSupervision = mock(async () => start.controller.abort(reason));
    await expect(readiness.completeHealthStartup(start, perf)).rejects.toBe(reason);
    expect(timer.getSleepHistory()).toEqual([]);
    expect(tunnelClient.supervisionStarts).toBe(0);
  });

  test("clips the short poll to the remaining health deadline", async () => {
    const { readiness, start, perf, timer } = createHarness();
    start.healthPollDeadlineMs = 250;
    expect(
      await settleByFakeEvents(timer, readiness.waitForHealthEndpoint(start, perf, 500), {
        description: "health deadline",
      }),
    ).toBe(false);
    expect(timer.getSleepHistory()).toEqual([100, 100, 50]);
    expect(timer.now()).toBe(250);
  });

  test("adopts a healthy default-port runner without a post-health sleep", async () => {
    const { readiness, start, perf, timer, state, host } = createHarness();
    state.xcTestProcessId = 123;
    host.checkHealthEndpointOnPortForDevice = mock(async () => true);
    expect(
      await settleByFakeEvents(
        timer,
        readiness.waitForHealthRestartingUnresponsiveRunner(start, perf, 500, 100, false),
        { description: "default-port runner adoption" },
      ),
    ).toBe(true);
    expect(timer.now()).toBe(200);
    expect(timer.getSleepHistory()).toEqual([100, 100]);
    expect(state.servicePort).toBe(8765);
    expect(host.startProcessSupervision).toHaveBeenCalledTimes(1);
  });
});

describe("progress-aware runner windows", () => {
  function progressHarness(samples: Array<number | null | Error>, callerDeadline?: number) {
    const h = createHarness();
    const sample = mock(async () => {
      const value = samples.length > 1 ? samples.shift()! : samples[0]!;
      if (value instanceof Error) {
        throw value;
      }
      return value;
    });
    const readiness = new IosCtrlProxyReadiness(h.state, h.host, {
      progressProbe: { sample },
      extensionBackoff: sequenceBackoff([300, 60000]),
      relaunchBackoff: sequenceBackoff([10]),
    });
    h.state.steps.waitForHealthEndpoint = (...args) => readiness.waitForHealthEndpoint(...args);
    h.state.xcTestProcessId = 123;
    h.start.defaultHealthPollDeadlineMs = 100;
    h.start.healthPollDeadlineMs = callerDeadline ?? 100;
    if (callerDeadline) {
      h.start.callerHealthPollDeadlinesMs.set(Symbol(), callerDeadline);
    }
    const terminated = mock(async () => {});
    h.state.steps.isOwnRunnerProcessAlive = async () => true;
    h.state.steps.terminateHungRunnerProcess = terminated;
    h.host.prepareSimulatorRunner = mock(async () => {
      h.state.xcTestProcessId = 124;
      return "spawned" as const;
    });
    return { ...h, readiness, sample, terminated };
  }

  test("growing CPU extends by injected Backoff and succeeds without retiring the launch", async () => {
    const h = progressHarness([0, 200, 400]);
    h.host.checkHealthEndpoint = mock(async () => h.timer.now() >= 450);
    expect(
      await settleByFakeEvents(
        h.timer,
        h.readiness.waitForHealthRestartingUnresponsiveRunner(h.start, h.perf, 100, 100, true),
        { description: "progress extension" },
      ),
    ).toBe(true);
    expect(h.terminated).not.toHaveBeenCalled();
    expect(h.start.defaultHealthPollDeadlineMs).toBe(500);
    expect(h.timer.now()).toBe(500);
  });

  test.each([0, null, new Error("probe failed")])(
    "flat or unavailable CPU %s retires and relaunches",
    async (value) => {
      const h = progressHarness([0, value], 10000);
      h.host.checkHealthEndpoint = mock(async () => h.state.xcTestProcessId === 124);
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        expect(
          await settleByFakeEvents(
            h.timer,
            h.readiness.waitForHealthRestartingUnresponsiveRunner(h.start, h.perf, 100, 100, true),
            { description: "no progress relaunch" },
          ),
        ).toBe(true);
        expect(h.terminated).toHaveBeenCalledTimes(1);
        if (value !== 0) {
          expect(warn.mock.calls.some(([message]) => String(message).includes("progress"))).toBe(
            true,
          );
        }
        expect(h.timer.getSleepHistory()).toContain(10);
      } finally {
        warn.mockRestore();
      }
    },
  );

  test("continuing progress retires at the hard launch ceiling", async () => {
    const h = progressHarness([0], 400000);
    h.sample.mockImplementation(async () => h.timer.now());
    h.host.checkHealthEndpoint = mock(async () => h.state.xcTestProcessId === 124);
    expect(
      await settleByFakeEvents(
        h.timer,
        h.readiness.waitForHealthRestartingUnresponsiveRunner(h.start, h.perf, 10000, 30000, true),
        { description: "progress ceiling", maxEvents: 2000 },
      ),
    ).toBe(true);
    expect(h.terminated).toHaveBeenCalledTimes(1);
    expect(h.timer.now()).toBe(300010);
  });

  test("caller budget bounds progress extensions", async () => {
    const h = progressHarness([0, 200, 400], 350);
    expect(
      await settleByFakeEvents(
        h.timer,
        h.readiness.waitForHealthRestartingUnresponsiveRunner(h.start, h.perf, 100, 100, true),
        { description: "caller budget" },
      ),
    ).toBe(false);
    expect(h.timer.now()).toBe(350);
    expect(h.terminated).not.toHaveBeenCalled();
  });
});
