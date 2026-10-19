import { describe, expect, test } from "bun:test";
import {
  EmulatorProcessLifecycle,
  type EmulatorProcessLifecyclePoolPort,
} from "../../src/daemon/emulatorProcessLifecycle";
import { FakeExitStatelessChildProcess } from "../fakes/FakeExitStatelessChildProcess";
import { FakeTimer } from "../fakes/FakeTimer";

const unused = (): never => {
  throw new Error("not used when stopping a handle without exit state");
};

function lifecycle(timer: FakeTimer): EmulatorProcessLifecycle {
  const port: EmulatorProcessLifecyclePoolPort = {
    getTimer: () => timer,
    getStartedDeviceProcesses: unused,
    getStartedDeviceProcessOutput: unused,
    getDevices: unused,
    getSessionManager: unused,
    isReservedForShutdown: unused,
    prepareSessionPreservingRecovery: unused,
    finishSessionPreservingRecoveryPreparation: unused,
    recordEmulatorLossIncident: unused,
    finishEmulatorLossIncident: unused,
    evictMissingPooledDevice: unused,
  };
  return new EmulatorProcessLifecycle(port);
}

describe("EmulatorProcessLifecycle.stopEmulatorProcess without exit state", () => {
  test("kills a handle with no exit state once and does not wait for it to exit", async () => {
    const timer = new FakeTimer();
    const handle = new FakeExitStatelessChildProcess();

    await lifecycle(timer).stopEmulatorProcess(handle);

    expect(handle.exitCode).toBeUndefined();
    expect(handle.signals).toEqual([undefined]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});
