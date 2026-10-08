import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import type { IosCtrlProxyBuilder } from "../../src/ctrlProxy/IosCtrlProxyBuilder";
import { ActionableError } from "../../src/models/ActionableError";
import type { BootedDevice } from "../../src/models";
import { createExecResult } from "../../src/utils/execResult";
import { logger } from "../../src/utils/logger";
import { PortManager } from "../../src/utils/PortManager";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { FakeTimer } from "../fakes/FakeTimer";

// #10649: a caller such as getApple extends the shared health-poll deadline to its
// whole acquisition budget. A runner frozen at launch must still be relaunched
// once its launch window elapses unanswered, bounded, inside that budget.

const DEVICE: BootedDevice = {
  deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
  platform: "ios",
  name: "iPhone 16 Simulator",
};
// getApple's acquisition budget, which it passes as the minimum health-poll duration.
const ACQUISITION_BUDGET_MS = 360_000;
// 3 attempts x 500 ms: a 1.5 s default window, so the first launch window is 3 s.
const HEALTH_MAX_ATTEMPTS = "3";
const WINDOW_MS = 1_500;
const FIRST_LAUNCH_WINDOW_MS = 3_000;

function fakeBuilder(): IosCtrlProxyBuilder {
  return {
    getXctestrunPath: async () => "/tmp/CtrlProxy.xctestrun",
    getRunnerBinaryPath: async () => null,
    verifyRunnerBinaryBeforeLaunch: async () => {},
    writeRunnerEnvironment: async () => "/tmp/automobile-runner.xctestrun",
    needsRebuild: async () => false,
    build: async () => ({ success: true, message: "built" }),
    getExpectedAppHash: () => null,
  } as unknown as IosCtrlProxyBuilder;
}

interface Harness {
  manager: IOSCtrlProxyManager;
  executor: FakeProcessExecutor;
  timer: FakeTimer;
  /** Fake-clock time of each runner launch's first health poll. */
  launches: number[];
  terminated: number[];
}

/**
 * Builds a simulator manager whose health endpoint answers only when `healthy`
 * says so. Each spawned runner is "ours" until terminated.
 */
function createHarness(
  healthy: (launchIndex: number, sinceLaunchMs: number) => boolean,
  options: { exitOnTerminate?: boolean } = {},
): Harness {
  const timer = new FakeTimer();
  const executor = new FakeProcessExecutor();
  const manager = IOSCtrlProxyManager.createForTestingWithDeps(
    DEVICE,
    timer,
    fakeBuilder(),
    executor,
  );
  const harness: Harness = { manager, executor, timer, launches: [], terminated: [] };
  const launchedPids = (): number[] =>
    executor.getSpawnedProcesses().map((spawned) => spawned.process.pid ?? -1);
  executor.setCommandResponse("pgrep", createExecResult("", ""));
  executor.setCommandHandler("curl -s", () => {
    // The health poll begins right after each launch, so record launches here.
    while (harness.launches.length < launchedPids().length) {
      harness.launches.push(timer.now());
    }
    const launchIndex = launchedPids().length - 1;
    const answers =
      launchIndex >= 0 &&
      !harness.terminated.includes(launchedPids()[launchIndex]) &&
      healthy(launchIndex, timer.now() - harness.launches[launchIndex]);
    return createExecResult(
      answers ? JSON.stringify({ status: "ok", deviceId: DEVICE.deviceId }) : "",
      "",
    );
  });
  const internals = manager as unknown as {
    isOwnRunnerProcessAlive(pid?: number | null): Promise<boolean>;
    terminateHungRunnerProcess(pid: number): Promise<void>;
    xcTestProcessId: number | null;
  };
  spyOn(internals, "isOwnRunnerProcessAlive").mockImplementation(
    async (pid: number | null = internals.xcTestProcessId) =>
      pid !== null && launchedPids().includes(pid) && !harness.terminated.includes(pid),
  );
  spyOn(internals, "terminateHungRunnerProcess").mockImplementation(async (pid: number) => {
    harness.terminated.push(pid);
    if (options.exitOnTerminate) {
      // A real tree kill delivers the xcodebuild child's exit event while the
      // retirement is still in flight, before the PID is untracked (#10653).
      const killed = executor
        .getSpawnedProcesses()
        .find((spawned) => spawned.process.pid === pid)?.process;
      (killed as FakeChildProcess | undefined)?.emit("exit", null, "SIGTERM");
    }
  });
  return harness;
}

describe("IOSCtrlProxyManager unresponsive runner relaunch (#10649)", () => {
  let prevHealthMaxAttempts: string | undefined;
  const restores: Array<() => void> = [];

  beforeEach(() => {
    prevHealthMaxAttempts = process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
    process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS = HEALTH_MAX_ATTEMPTS;
    IOSCtrlProxyManager.resetInstances();
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
    for (const level of ["info", "warn", "debug"] as const) {
      const spy = spyOn(logger, level).mockImplementation(() => {});
      restores.push(() => spy.mockRestore());
    }
  });

  afterEach(() => {
    for (const restore of restores.splice(0)) {
      restore();
    }
    if (prevHealthMaxAttempts === undefined) {
      delete process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
    } else {
      process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS = prevHealthMaxAttempts;
    }
    IOSCtrlProxyManager.resetInstances();
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  test("relaunches a runner frozen at launch after its window and succeeds on the second launch", async () => {
    const harness = createHarness((launchIndex) => launchIndex === 1);
    harness.timer.enableAutoAdvance();

    await harness.manager.start({ minimumHealthPollDurationMs: ACQUISITION_BUDGET_MS });

    expect(harness.launches).toHaveLength(2);
    // The frozen runner was given its whole first-launch window, then replaced.
    expect(harness.launches[1] - harness.launches[0]).toBeGreaterThanOrEqual(
      FIRST_LAUNCH_WINDOW_MS,
    );
    expect(harness.launches[1] - harness.launches[0]).toBeLessThan(ACQUISITION_BUDGET_MS);
    const [firstPid, secondPid] = harness.executor
      .getSpawnedProcesses()
      .map((spawned) => spawned.process.pid);
    expect(harness.terminated).toEqual([firstPid!]);
    expect(harness.manager["xcTestProcessId"]).toBe(secondPid!);
  });

  test("a retired runner's exit event does not abort the relaunch or schedule a supervisor restart (#10653)", async () => {
    const harness = createHarness((launchIndex) => launchIndex === 1, { exitOnTerminate: true });
    harness.timer.enableAutoAdvance();

    await harness.manager.start({ minimumHealthPollDurationMs: ACQUISITION_BUDGET_MS });

    expect(harness.launches).toHaveLength(2);
    const [firstPid, secondPid] = harness.executor
      .getSpawnedProcesses()
      .map((spawned) => spawned.process.pid);
    expect(harness.terminated).toEqual([firstPid!]);
    expect(harness.manager["xcTestProcessId"]).toBe(secondPid!);
    // The deliberate retirement must not leave a duplicate supervisor restart racing
    // the in-setup relaunch.
    expect(harness.manager["processSupervisor"].isRestartPending()).toBe(false);
  });

  test("fails with an actionable health-check error before the caller deadline when every launch stays frozen", async () => {
    const harness = createHarness(() => false);
    harness.timer.enableAutoAdvance();
    const startedAt = harness.timer.now();

    const error = await harness.manager
      .start({ minimumHealthPollDurationMs: ACQUISITION_BUDGET_MS })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(ActionableError);
    expect((error as Error).message).toContain("CtrlProxy runner health check failed");
    expect((error as Error).message).toContain("3 launches (windows 3s, 2s, 2s)");
    expect(harness.launches).toHaveLength(3);
    // Every frozen runner was terminated, including the last, so nothing re-adopts it.
    expect(harness.terminated).toEqual(
      harness.executor.getSpawnedProcesses().map((spawned) => spawned.process.pid!),
    );
    expect(harness.manager["xcTestProcessId"]).toBeNull();
    const elapsedMs = harness.timer.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(FIRST_LAUNCH_WINDOW_MS + 2 * WINDOW_MS);
    expect(elapsedMs).toBeLessThan(ACQUISITION_BUDGET_MS);
  });

  test("does not relaunch a slow first launch that answers within its first-launch window", async () => {
    // Slower than the default window, inside the longer cold-launch window.
    const harness = createHarness((_launchIndex, sinceLaunchMs) => sinceLaunchMs >= 2_500);
    harness.timer.enableAutoAdvance();

    await harness.manager.start({ minimumHealthPollDurationMs: ACQUISITION_BUDGET_MS });

    expect(harness.launches).toHaveLength(1);
    expect(harness.terminated).toEqual([]);
  });

  test("keeps the single default window when no caller extends the deadline", async () => {
    const harness = createHarness(() => false);
    harness.timer.enableAutoAdvance();

    await expect(harness.manager.start()).rejects.toThrow(
      "CtrlProxy failed to start within timeout",
    );

    expect(harness.launches).toHaveLength(1);
  });
});
