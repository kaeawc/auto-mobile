import {
  type IosRunnerLaunchGate,
  DefaultIosRunnerLaunchGate,
} from "../../../src/ctrlProxy/ios/IosRunnerLaunchGate";
import { expect, mock, test } from "bun:test";
import { IosCtrlProxyStartup } from "../../../src/ctrlProxy/ios/IosCtrlProxyStartup";
import type { SharedCtrlProxyStart } from "../../../src/ctrlProxy/ios/IosCtrlProxyLifecycleSteps";
import { FakeIosRunnerLaunchGate } from "../../fakes/FakeIosRunnerLaunchGate";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeIosTunnelClient } from "../../fakes/FakeIosTunnelClient";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";

function harness(launchGate?: IosRunnerLaunchGate) {
  const gate = new FakeIosRunnerLaunchGate();
  const timer = new FakeTimer();
  const start: SharedCtrlProxyStart = {
    controller: new AbortController(),
    completion: Promise.resolve(),
    healthPollDeadlineMs: null,
    defaultHealthPollDeadlineMs: null,
    callerHealthPollDeadlinesMs: new Map([[Symbol(), 1000]]),
    teardownCommitted: false,
    waitingCallers: 1,
    externalWaitingCallers: 1,
    completed: false,
  };
  const noop = async () => {};
  const state: ConstructorParameters<typeof IosCtrlProxyStartup>[0] = {
    forceRestartGeneration: 0,
    forceRestartInFlight: null,
    sharedStart: start,
    timer,
    isStopping: false,
    isProcessSupervisorRestarting: false,
    xcTestProcessId: null,
    servicePort: 8765,
    device: { deviceId: "test-device", platform: "ios", name: "Test" },
    runnerGenerationTokens: new Map(),
    xcTestProcess: null,
    processSupervisor: {
      start: noop,
      stop: () => {},
      processExited: () => {},
      isAlive: async () => false,
      setAutoRestart: () => {},
      isAutoRestartEnabled: () => false,
      isRestartPending: () => false,
    },
    tunnelClient: new FakeIosTunnelClient(),
    runnerLaunchGate: launchGate ?? gate,
    steps: {
      startInternal: noop,
      waitForNonJoinableStart: async () => null,
      retireRunnerAfterFinalSharedStartCancellation: noop,
      startOnSimulator: mock(async () => "spawned" as const),
      startOnDevice: mock(async () => "spawned" as const),
      waitForHealthEndpoint: async () => true,
      completeHealthStartup: noop,
      isOwnRunnerProcessAlive: async () => false,
      terminateHungRunnerProcess: noop,
      terminateTrackedRunner: noop,
      uninstallLegacyAppIfPresent: noop,
      fenceLateRemoteStartAfterShutdown: noop,
    },
  };
  const host: ConstructorParameters<typeof IosCtrlProxyStartup>[1] = {
    assertDeviceNotRetired: () => {},
    assertDeviceNotSuspended: () => {},
    waitForForceRestart: async () => false,
    startAfterForceRestart: noop,
    start: noop,
    extendHealthPollDeadline: () => {},
    waitForSharedStart: noop,
    checkCtrlProxyProcessLiveness: async () => "dead",
    isSimulator: () => true,
    startProcessSupervision: noop,
    isRunning: async () => false,
    resolveHealthPollMaxAttempts: () => 60,
    refreshHealthPollDeadline: (shared) => {
      shared.healthPollDeadlineMs = Math.max(
        shared.defaultHealthPollDeadlineMs ?? 0,
        ...shared.callerHealthPollDeadlinesMs.values(),
      );
    },
    waitForHealthRestartingUnresponsiveRunner: async () => true,
    checkHealthEndpointOnPortForDevice: async () => false,
    adoptServicePort: () => {},
    clearCaches: () => {},
    sleepForHealthPoll: noop,
    completeHealthStartupIfDeadlineExtended: async () => false,
    findListeningProcessesOnPort: async () => [],
    formatListeningProcesses: () => "",
    startIproxyTunnel: noop,
    restartDeviceProcessAfterHostPortCollision: async () => "adopted",
    useRemoteRunner: () => false,
    findExternalCtrlProxyProcess: async () => null,
    ensureServicePortReadyForLaunch: noop,
    forceStopCancelledStartup: noop,
    awaitGlobalStartupOrphanRunnerReap: noop,
  };
  const startup = new IosCtrlProxyStartup(state, host);
  return { startup, state, host, gate, timer, start };
}

test.each(["healthy", "running", "external", "deferred"])(
  "%s reuse never acquires a launch slot",
  async (path) => {
    const h = harness();
    if (path === "healthy") {
      h.host.checkCtrlProxyProcessLiveness = async () => "healthy";
    }
    if (path === "running") {
      h.host.isRunning = async () => true;
    }
    if (path === "external") {
      h.host.findExternalCtrlProxyProcess = async () => ({ pid: 42, port: 8765 });
    }
    if (path === "deferred") {
      h.state.steps.isOwnRunnerProcessAlive = async () => true;
    }
    await h.startup.startInternal(h.start);
    expect(h.gate.acquisitions).toBe(0);
  },
);

test.each(["success", "failure", "abort"])(
  "slot is held through health and released on %s",
  async (outcome) => {
    const h = harness();
    h.host.waitForHealthRestartingUnresponsiveRunner = async () => {
      expect(h.gate.held).toBe(1);
      // A readiness relaunch uses the same shared start, even at concurrency one.
      await h.startup.prepareSimulatorRunner(new NoOpPerformanceTracker());
      expect(h.gate.acquisitions).toBe(1);
      if (outcome === "abort") {
        h.start.controller.abort(new Error("abort"));
      }
      h.start.controller.signal.throwIfAborted();
      if (outcome === "failure") {
        throw new Error("failure");
      }
      return true;
    };
    const completion = h.startup.startInternal(h.start);
    if (outcome === "success") {
      await completion;
    } else {
      await expect(completion).rejects.toThrow(outcome);
    }
    expect(h.gate.held).toBe(0);
    expect(h.gate.releases).toBe(1);
  },
);

test("queue wait credits caller deadlines before health budget begins", async () => {
  const h = harness();
  h.gate.beforeAcquire = async () => {
    h.timer.advanceTime(5000);
  };
  h.host.waitForHealthRestartingUnresponsiveRunner = async () => {
    expect([...h.start.callerHealthPollDeadlinesMs.values()]).toEqual([6000]);
    expect(h.start.defaultHealthPollDeadlineMs).toBe(35000);
    return true;
  };
  await h.startup.startInternal(h.start);
  expect(h.gate.acquisitions).toBe(1);
});

test("queue wait credit skips a caller that joined while queued", async () => {
  const h = harness();
  const late = Symbol("late");
  h.gate.beforeAcquire = async () => {
    h.timer.advanceTime(5000);
    h.start.callerHealthPollDeadlinesMs.set(late, 9000);
  };
  h.host.waitForHealthRestartingUnresponsiveRunner = async () => {
    expect(h.start.callerHealthPollDeadlinesMs.get(late)).toBe(9000);
    return true;
  };
  await h.startup.startInternal(h.start);
});

test("spawn failure releases the slot", async () => {
  const h = harness();
  h.state.steps.startOnSimulator = async () => {
    throw new Error("spawn failed");
  };
  await expect(h.startup.startInternal(h.start)).rejects.toThrow("spawn failed");
  expect(h.gate.releases).toBe(1);
});

test("queue abort never spawns or releases someone else's slot", async () => {
  const h = harness();
  h.gate.beforeAcquire = async (signal) => {
    h.start.controller.abort(new Error("queue aborted"));
    signal?.throwIfAborted();
  };
  await expect(h.startup.startInternal(h.start)).rejects.toThrow("queue aborted");
  expect(h.state.steps.startOnSimulator).not.toHaveBeenCalled();
  expect(h.gate.releases).toBe(0);
});

test("readiness relaunch retains its slot at concurrency one", async () => {
  const h = harness(new DefaultIosRunnerLaunchGate(1));
  h.host.waitForHealthRestartingUnresponsiveRunner = async () => {
    await h.startup.prepareSimulatorRunner(new NoOpPerformanceTracker());
    return true;
  };
  await h.startup.startInternal(h.start);
  expect(h.state.steps.startOnSimulator).toHaveBeenCalledTimes(2);
  (await h.state.runnerLaunchGate.acquire()).release();
});

test("startup passes the device owner to the launch gate", async () => {
  const h = harness();
  let owner: string | undefined;
  h.gate.beforeAcquire = async (_signal, queuedOwner) => {
    owner = queuedOwner;
  };
  await h.startup.startInternal(h.start);
  expect(owner).toBe(h.state.device.deviceId);
});
