import { IosCtrlProxyProcessClient } from "../../src/ctrlProxy/ios/IosCtrlProxyProcessClient";
import { FakeLockOwnerGenerationProbe } from "../fakes/FakeLockOwnerGenerationProbe";
import { readFileSync } from "node:fs";
import { IosRunnerLaunchFailures } from "../../src/ctrlProxy/ios/IosRunnerLaunchFailure";
import type { RunnerLaunchProgressProbe } from "../../src/ctrlProxy/ios/IosRunnerLaunchProgress";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import type { IosCtrlProxyBuilderSurface } from "../../src/ctrlProxy/IosCtrlProxyBuilderSurface";
import { ActionableError } from "../../src/models/ActionableError";
import type { BootedDevice } from "../../src/models";
import { createExecResult } from "../../src/utils/execResult";
import { logger } from "../../src/utils/logger";
import { PortManager } from "../../src/utils/PortManager";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import {
  DefaultProcessSupervisor,
  type ProcessSupervisorOptions,
} from "../../src/utils/ProcessSupervisor";
import { FakeTimer } from "../fakes/FakeTimer";
import { fakeIosCtrlProxyBuilder } from "../helpers/iosCtrlProxyBuilderFake";
import { settleByFakeEvents } from "../helpers/fakeTimerStepping";

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

function fakeBuilder(): IosCtrlProxyBuilderSurface {
  return fakeIosCtrlProxyBuilder({
    getXctestrunPath: async () => "/tmp/CtrlProxy.xctestrun",
    verifyRunnerBinaryBeforeLaunch: async () => {},
    writeRunnerEnvironment: async () => "/tmp/automobile-runner.xctestrun",
    needsRebuild: async () => false,
    build: async () => ({ success: true, message: "built" }),
    getExpectedAppHash: () => "",
  });
}

interface Harness {
  manager: IOSCtrlProxyManager;
  executor: FakeProcessExecutor;
  timer: FakeTimer;
  /** Fake-clock time of each runner launch's first health poll. */
  launches: number[];
  terminated: number[];
  restartSupervisor(): Promise<void>;
  probe(): Promise<boolean>;
}

/**
 * Builds a simulator manager whose health endpoint answers only when `healthy`
 * says so. Each spawned runner is "ours" until terminated.
 */
function createHarness(
  healthy: (launchIndex: number, sinceLaunchMs: number) => boolean,
  options: {
    progressProbe?: RunnerLaunchProgressProbe;
    onPoll?: (child: FakeChildProcess, elapsed: number) => void;
    exitOnTerminate?: boolean;
    deferredPid?: number;
    defaultPortHealthyAfterMs?: number;
  } = {},
): Harness {
  const timer = new FakeTimer();
  const executor = new FakeProcessExecutor();
  const spawn = executor.spawn.bind(executor);
  spyOn(executor, "spawn").mockImplementation((command, args, spawnOptions) => {
    executor.setNextSpawnProcess(new FakeChildProcess(timer));
    return spawn(command, args, spawnOptions);
  });
  const launchedPids = (): number[] =>
    executor.getSpawnedProcesses().map((spawned) => spawned.process.pid ?? -1);
  const terminated: number[] = [];
  let supervisorOptions: ProcessSupervisorOptions | undefined;
  const manager: IOSCtrlProxyManager = IOSCtrlProxyManager.createForTestingWithOptions({
    device: DEVICE,
    runnerLaunchProgressProbe: options.progressProbe,
    timer,
    builder: fakeBuilder(),
    processExecutor: executor,
    processClient: new IosCtrlProxyProcessClient(executor, timer, {
      processGeneration: new FakeLockOwnerGenerationProbe(),
    }),
    processSupervisorFactory: (options) => {
      supervisorOptions = options;
      return new DefaultProcessSupervisor(options);
    },
    steps: {
      isOwnRunnerProcessAlive: async (pid = manager.getXcTestProcessId()) =>
        pid !== null &&
        (launchedPids().includes(pid) || pid === options.deferredPid) &&
        !terminated.includes(pid),
      terminateHungRunnerProcess: async (pid) => {
        terminated.push(pid);
        if (options.exitOnTerminate) {
          // A real tree kill delivers the xcodebuild child's exit event while the
          // retirement is still in flight, before the PID is untracked (#10653).
          const killed = executor
            .getSpawnedProcesses()
            .find((spawned) => spawned.process.pid === pid)?.process;
          (killed as FakeChildProcess | undefined)?.emit("exit", null, "SIGTERM");
        }
      },
    },
  });
  const harness: Harness = {
    manager,
    executor,
    timer,
    launches: [],
    terminated,
    probe: async () => {
      if (!supervisorOptions) {
        throw new Error("missing supervisor options");
      }
      return supervisorOptions.isAlive({ isCurrent: () => true });
    },
    restartSupervisor: async () => {
      if (!supervisorOptions) {
        throw new Error("missing supervisor options");
      }
      await supervisorOptions.restart();
    },
  };
  executor.setCommandResponse("pgrep", createExecResult("", ""));
  executor.setCommandHandler("curl -s", (command) => {
    // The health poll begins right after each launch, so record launches here.
    while (harness.launches.length < launchedPids().length) {
      harness.launches.push(timer.now());
    }
    const launchIndex = launchedPids().length - 1;
    const child = executor.getSpawnedProcesses()[launchIndex]?.process;
    if (child instanceof FakeChildProcess) {
      options.onPoll?.(child, timer.now() - harness.launches[launchIndex]);
    }
    const answers =
      (command.includes(":8765/") &&
        timer.now() >= (options.defaultPortHealthyAfterMs ?? Number.POSITIVE_INFINITY)) ||
      (launchIndex >= 0 &&
        !harness.terminated.includes(launchedPids()[launchIndex]) &&
        healthy(launchIndex, timer.now() - harness.launches[launchIndex]));
    return createExecResult(
      answers ? JSON.stringify({ status: "ok", deviceId: DEVICE.deviceId }) : "",
      "",
    );
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

  const captured = readFileSync(
    new URL("../fixtures/ios-runner-launch-failure/runner-output-captured.txt", import.meta.url),
    "utf8",
  )
    .trimEnd()
    .split("\n")
    .map((line) => line.slice(line.indexOf("\t") + 1));

  test.each(["listener failed", "Restarting after unexpected exit"])(
    "retires captured %s promptly despite growing CPU",
    async (marker) => {
      delete process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
      const output = captured.find((chunk) => chunk.includes(marker))!;
      let emitted = false;
      let samples = 0;
      const h = createHarness((index) => index === 1, {
        progressProbe: { sample: async () => ++samples * 1000 },
        onPoll: (child, elapsed) => {
          if (!emitted && elapsed >= 2000) {
            emitted = true;
            child.stdout.emit("data", output);
          }
        },
      });
      await settleByFakeEvents(
        h.timer,
        h.manager.start({ minimumHealthPollDurationMs: ACQUISITION_BUDGET_MS }),
        { description: "fatal output relaunch", maxEvents: 2000 },
      );
      expect(h.launches).toHaveLength(2);
      expect(h.launches[1] - h.launches[0]).toBeLessThan(5000);
      expect(samples).toBe(2); // Initial samples only; neither launch was extended.
      expect(h.terminated).toEqual([h.executor.getSpawnedProcesses()[0].process.pid!]);
    },
  );

  test.each([
    ["listener failed", "listener-bind-failed"],
    ["Restarting after unexpected exit", "runner-lost"],
  ] as const)("records split captured %s and promptly relaunches", async (marker, reason) => {
    delete process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
    const output = captured.find((chunk) => chunk.includes(marker))!;
    const split = output.indexOf(marker) + Math.floor(marker.length / 2);
    let emitted = false;
    const h = createHarness((index) => index === 1, {
      progressProbe: { sample: async () => 1000 },
      onPoll: (child, elapsed) => {
        if (!emitted && elapsed >= 2000) {
          emitted = true;
          child.stdout.emit("data", output.slice(0, split));
          child.stdout.emit("data", output.slice(split));
        }
      },
    });
    const record = spyOn(IosRunnerLaunchFailures.prototype, "record");
    try {
      await settleByFakeEvents(
        h.timer,
        h.manager.start({ minimumHealthPollDurationMs: ACQUISITION_BUDGET_MS }),
        { description: "split fatal output relaunch", maxEvents: 2000 },
      );
      const pid = h.executor.getSpawnedProcesses()[0].process.pid!;
      expect(record).toHaveBeenCalledWith(pid, expect.objectContaining({ reason }));
      expect(h.launches).toHaveLength(2);
      expect(h.launches[1] - h.launches[0]).toBeLessThan(5000);
      expect(h.terminated).toEqual([pid]);
    } finally {
      record.mockRestore();
    }
  });

  test.each(["stdout", "stderr"] as const)(
    "%s tail expires old text, stays separate, and preserves split whitespace",
    (stream) => {
      const h = createHarness(() => false);
      const child = new FakeChildProcess(h.timer);
      child.pid = 12345;
      h.manager.trackStartedXcodebuild(child);
      const otherStream = stream === "stdout" ? "stderr" : "stdout";
      const marker = "Restarting after unexpected exit, crash, or test timeout";
      const split = marker.indexOf(" unexpected") + 1;
      const record = spyOn(IosRunnerLaunchFailures.prototype, "record");
      try {
        child[stream].emit("data", marker.slice(0, split));
        child[otherStream].emit("data", marker.slice(split));
        expect(record).not.toHaveBeenCalled();
        child[stream].emit("data", "CtrlProxy listener failed: ");
        for (let i = 0; i < 20; i++) {
          child[stream].emit("data", "benign output\n".repeat(100));
        }
        child[stream].emit("data", "Address already in use");
        child[stream].emit("data", marker.slice(split));
        expect(record).not.toHaveBeenCalled();
        child[stream].emit("data", marker.slice(0, split));
        child[stream].emit("data", marker.slice(split));
        expect(record).toHaveBeenCalledWith(
          12345,
          expect.objectContaining({ reason: "runner-lost" }),
        );
        child[stream].emit("data", "more benign output");
        expect(record).toHaveBeenCalledTimes(1);
      } finally {
        record.mockRestore();
      }
    },
  );

  test("a replacement child with a reused PID starts with an empty output tail", () => {
    const h = createHarness(() => false);
    const first = new FakeChildProcess(h.timer);
    const replacement = new FakeChildProcess(h.timer);
    first.pid = replacement.pid = 12345;
    const record = spyOn(IosRunnerLaunchFailures.prototype, "record");
    try {
      h.manager.trackStartedXcodebuild(first);
      first.stdout.emit("data", "Restarting after unexpected");
      h.manager.trackStartedXcodebuild(replacement);
      replacement.stdout.emit("data", " exit, crash, or test timeout");
      first.stdout.emit("data", " exit, crash, or test timeout");
      expect(record).not.toHaveBeenCalled();
      replacement.stdout.emit("data", "Restarting after unexpected");
      replacement.stdout.emit("data", " exit, crash, or test timeout");
      expect(record).toHaveBeenCalledWith(
        12345,
        expect.objectContaining({ reason: "runner-lost" }),
      );
    } finally {
      record.mockRestore();
    }
  });

  test("bind failure relaunch uses a different service port", async () => {
    const ports: number[] = [];
    const h = createHarness((index) => index === 1, {
      onPoll: (child) => {
        ports.push(h.manager.getServicePort());
        if (ports.length === 1) {
          child.stdout.emit("data", "CtrlProxy listener failed: Address already in use");
        }
      },
    });
    await settleByFakeEvents(
      h.timer,
      h.manager.start({ minimumHealthPollDurationMs: ACQUISITION_BUDGET_MS }),
      { description: "bind failure port replacement" },
    );
    expect(h.launches).toHaveLength(2);
    expect(h.manager.getServicePort()).not.toBe(ports[0]);
    expect(ports.at(-1)).not.toBe(ports[0]);
  });

  test("final error includes the last bind failure reason and detail", async () => {
    const detail = "CtrlProxy listener failed: Address already in use";
    const h = createHarness(() => false, {
      onPoll: (child) => child.stdout.emit("data", detail),
    });
    const error = await settleByFakeEvents(
      h.timer,
      h.manager.start({ minimumHealthPollDurationMs: ACQUISITION_BUDGET_MS }).then(
        () => undefined,
        (caught: unknown) => caught,
      ),
      { description: "all launches fail to bind" },
    );
    expect(h.launches).toHaveLength(3);
    expect(error).toBeInstanceOf(ActionableError);
    if (!(error instanceof Error)) {
      throw new Error("Expected startup error");
    }
    expect(error.message).toContain("listener-bind-failed");
    expect(error.message).toContain(detail);
  });

  test("supervisor exit clears failure evidence when untracking the runner", async () => {
    const h = createHarness(() => false);
    const child = new FakeChildProcess(h.timer);
    child.pid = 12345;
    h.manager.trackStartedXcodebuild(child);
    child.stdout.emit("data", "CtrlProxy listener failed: Address already in use");
    const clearFailure = IosRunnerLaunchFailures.prototype.clear;
    const clear = spyOn(IosRunnerLaunchFailures.prototype, "clear").mockImplementation(function (
      this: IosRunnerLaunchFailures,
      pid: number,
    ) {
      expect(this.get(pid)?.reason).toBe("listener-bind-failed");
      clearFailure.call(this, pid);
      expect(this.get(pid)).toBeUndefined();
    });
    try {
      h.manager.diagnostics.processSupervisor.setAutoRestart(false);
      h.manager.diagnostics.processSupervisor.processExited();
      expect(h.manager.getXcTestProcessId()).toBeNull();
      expect(clear).toHaveBeenCalledWith(12345);
    } finally {
      clear.mockRestore();
    }
  });

  test("retires a deferred runner with recorded lost-runner output without waiting", async () => {
    delete process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
    const h = createHarness(() => true, { deferredPid: 12345 });
    const child = new FakeChildProcess(h.timer);
    child.pid = 12345;
    h.manager.trackStartedXcodebuild(child);
    child.stderr.emit(
      "data",
      captured.find((chunk) => chunk.includes("Restarting after"))!,
    );
    await settleByFakeEvents(h.timer, h.manager.start(), { description: "failed deferred runner" });
    expect(h.timer.now()).toBe(0);
    expect(h.terminated).toEqual([12345]);
    expect(h.executor.getSpawnedProcesses()).toHaveLength(1);
  });

  test("supervisor records its unhealthy verdict and clears it on a healthy probe", async () => {
    const options = { deferredPid: 12345, defaultPortHealthyAfterMs: Number.POSITIVE_INFINITY };
    const h = createHarness(() => false, options);
    h.manager.testHooks.setState({ xcTestProcessId: 12345 });
    const record = spyOn(IosRunnerLaunchFailures.prototype, "record");
    const clear = spyOn(IosRunnerLaunchFailures.prototype, "clear");
    try {
      expect(await h.probe()).toBe(true);
      expect(await h.probe()).toBe(true);
      expect(record).not.toHaveBeenCalled();
      expect(await h.probe()).toBe(false);
      expect(record).toHaveBeenCalledWith(
        12345,
        expect.objectContaining({ reason: "supervisor-unhealthy" }),
      );
      options.defaultPortHealthyAfterMs = 0;
      expect(await h.probe()).toBe(true);
      expect(clear).toHaveBeenCalledWith(12345);
    } finally {
      record.mockRestore();
      clear.mockRestore();
    }
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
    expect(harness.manager.diagnostics.xcTestProcessId).toBe(secondPid!);
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
    expect(harness.manager.diagnostics.xcTestProcessId).toBe(secondPid!);
    // The deliberate retirement must not leave a duplicate supervisor restart racing
    // the in-setup relaunch.
    expect(harness.manager.diagnostics.processSupervisor.isRestartPending()).toBe(false);
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
    expect(harness.manager.diagnostics.xcTestProcessId).toBeNull();
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

  test("default cold launch answers at 45s inside the real 60s first-launch window", async () => {
    delete process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
    const harness = createHarness((_index, elapsed) => elapsed >= 45_000);
    harness.timer.enableAutoAdvance();
    await harness.manager.start();
    expect(harness.launches).toHaveLength(1);
    expect(harness.terminated).toEqual([]);
    expect(harness.timer.now() - harness.launches[0]).toBe(45_000);
  });

  test("a subsequent launch stops at the shared deadline without extending its window", async () => {
    delete process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
    const harness = createHarness(() => false);
    harness.timer.enableAutoAdvance();
    await expect(harness.manager.start({ minimumHealthPollDurationMs: 75_000 })).rejects.toThrow(
      "CtrlProxy failed to start within timeout",
    );
    expect(harness.launches).toHaveLength(2);
    expect(harness.launches[1] - harness.launches[0]).toBe(60_000);
    expect(harness.timer.now() - harness.launches[0]).toBe(75_000);
  });

  test("a deferred runner without our exit handler retains the 30s default budget", async () => {
    delete process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
    const harness = createHarness(() => false, { deferredPid: 12345 });
    harness.manager.testHooks.setState({ xcTestProcessId: 12345 });
    harness.timer.enableAutoAdvance();
    const startedAt = harness.timer.now();
    await expect(harness.manager.start()).rejects.toThrow(
      "CtrlProxy failed to start within timeout (30s)",
    );
    expect(harness.launches).toEqual([]);
    expect(harness.executor.getSpawnedProcesses()).toHaveLength(0);
    expect(harness.terminated).toEqual([12345]);
    expect(harness.timer.now() - startedAt).toBe(30_000);
  });

  test("adopts a deferred runner on its healthy default port without a post-health sleep", async () => {
    const harness = createHarness(() => false, {
      deferredPid: 12345,
      defaultPortHealthyAfterMs: WINDOW_MS,
    });
    harness.manager.testHooks.setState({ xcTestProcessId: 12345, servicePort: 8767 });
    await settleByFakeEvents(harness.timer, harness.manager.start(), {
      description: "deferred runner adoption",
    });
    expect(harness.manager.getServicePort()).toBe(8765);
    expect(harness.timer.now()).toBe(WINDOW_MS);
    expect(harness.timer.getSleepHistory()).toEqual(Array<number>(15).fill(100));
    expect(harness.terminated).toEqual([]);
    expect(harness.executor.getSpawnedProcesses()).toHaveLength(0);
  });

  test("supervisor restarts retain the 30s default health budget", async () => {
    delete process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
    const harness = createHarness(() => false);
    harness.timer.enableAutoAdvance();
    await expect(harness.restartSupervisor()).rejects.toThrow(
      "CtrlProxy failed to start within timeout (30s)",
    );
    expect(harness.launches).toHaveLength(1);
    expect(harness.timer.now() - harness.launches[0]).toBe(30_000);
  });

  test("gives a frozen first launch exactly twice the default window without a caller extension", async () => {
    delete process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
    const harness = createHarness(() => false);
    harness.timer.enableAutoAdvance();

    await expect(harness.manager.start()).rejects.toThrow(
      "CtrlProxy failed to start within timeout (60s)",
    );

    expect(harness.launches).toHaveLength(1);
    expect(harness.timer.now() - harness.launches[0]).toBe(60_000);
  });
});
