import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { SimulatorPrebootProfile } from "../../../src/utils/ios-cmdline-tools/SimulatorPrebootProfile";
import { FakeSimulatorHostState } from "../../fakes/FakeSimulatorHostState";
import { describe, expect, test } from "bun:test";
import { Mutex } from "async-mutex";
import {
  SimCtlShutdown,
  type SimCtlShutdownContext,
} from "../../../src/utils/ios-cmdline-tools/SimCtlShutdown";
import { DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS } from "../../../src/utils/deviceTimeouts";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";
import { settleByFakeEvents } from "../../helpers/fakeTimerStepping";

function harness(states: string[], autoAdvance = true) {
  const timer = new FakeTimer();
  if (autoAdvance) {
    timer.enableAutoAdvance();
  }
  const lease = {
    state: { mutex: new Mutex(), lastBootSucceeded: true, ownerToken: {} },
    release: () => {},
  };
  const context: SimCtlShutdownContext = {
    timer,
    acquireSimulatorBoot: async () => lease,
    executeCommandArgs: async () => createExecResult("", ""),
    executeCommandArgv: async () => createExecResult("", ""),
    readSimulatorState: async () => (states.length > 1 ? states.shift() : states[0]),
    invalidateDeviceListCache: () => {},
    execAsync: async () => {
      throw new Error("No process probes allowed");
    },
    prebootProfile: new SimulatorPrebootProfile(new FakeSimulatorHostState(), () => "none"),
  };
  return {
    timer,
    lease,
    context,
    shutdown: new SimCtlShutdown(context),
  };
}

describe("failed boot cleanup settlement", () => {
  test("confirms Shutdown after a transient state read failure", async () => {
    const h = harness(["Shutdown"]);
    const budgets: number[] = [];
    h.context.readSimulatorState = async (_udid, timeout) => {
      budgets.push(timeout);
      if (budgets.length === 1) {
        throw new Error("discovery temporarily unavailable");
      }
      return "Shutdown";
    };

    await h.shutdown.shutdownAfterFailedStart("sim", h.lease);

    expect(budgets).toEqual([60_000, 59_000]);
    expect(h.timer.getSleepHistory()).toEqual([1_000]);
    expect(h.timer.now()).toBe(1_000);
    expect(h.lease.state.lastBootSucceeded).toBe(false);
    expect(h.lease.state.ownerToken).toBeUndefined();
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("reports the last read error when discovery fails until the cleanup deadline", async () => {
    const h = harness(["Shutdown"]);
    let reads = 0;
    h.context.readSimulatorState = async () => {
      throw new Error(`discovery failure ${++reads}`);
    };

    const failure = await h.shutdown
      .shutdownAfterFailedStart("sim", h.lease)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("Expected cleanup to fail with an error");
    }
    expect(failure.message).toContain("cleanup timed out");
    expect(failure.message).toContain("discovery failure 60");
    expect(reads).toBe(60);
    expect(h.timer.now()).toBe(DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS);
    expect(h.lease.state.lastBootSucceeded).toBe(true);
    expect(h.lease.state.ownerToken).toBeDefined();
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("honours cancellation during the retry backoff without another read", async () => {
    const h = harness(["Shutdown"], false);
    const controller = new AbortController();
    const reason = new Error("cleanup cancelled");
    let reads = 0;
    h.context.readSimulatorState = async () => {
      reads++;
      h.timer.setTimeout(() => controller.abort(reason), 250);
      throw new Error("discovery unavailable");
    };
    const outcome = h.shutdown
      .shutdownSimulatorCoordinated("sim", DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS, controller.signal, {
        expectedOwnerToken: h.lease.state.ownerToken,
      })
      .catch((error: unknown) => error);

    expect(
      await settleByFakeEvents(h.timer, outcome, { description: "cleanup cancellation" }),
    ).toBe(reason);
    expect(reads).toBe(1);
    expect(h.timer.now()).toBe(250);
    expect(h.lease.state.lastBootSucceeded).toBe(true);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("waits for Shutting Down to become Shutdown", async () => {
    const h = harness(["Shutting Down", "Shutdown"]);
    await h.shutdown.shutdownAfterFailedStart("sim", h.lease);
    expect(h.timer.now()).toBeGreaterThan(0);
    expect(h.timer.now()).toBeLessThanOrEqual(DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS);
    expect(h.lease.state.lastBootSucceeded).toBe(false);
  });

  test("reports unconfirmed cleanup when Shutting Down never settles", async () => {
    const h = harness(["Shutting Down"]);
    await expect(h.shutdown.shutdownAfterFailedStart("sim", h.lease)).rejects.toThrow(
      "Shutting Down",
    );
    expect(h.timer.now()).toBe(DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS);
    expect(h.lease.state.lastBootSucceeded).toBe(true);
  });

  test("does not start shutdown after the lease consumes the cleanup budget", async () => {
    const h = harness(["Shutdown"]);
    let released = false;
    let commanded = false;
    h.lease.release = () => {
      released = true;
    };
    h.context.acquireSimulatorBoot = async () => {
      await h.timer.sleep(DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS);
      return h.lease;
    };
    h.context.executeCommandArgv = async () => {
      commanded = true;
      return createExecResult("", "");
    };
    await expect(
      h.shutdown.shutdownSimulatorCoordinated(
        "sim",
        DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS,
        undefined,
        { expectedOwnerToken: h.lease.state.ownerToken },
      ),
    ).rejects.toThrow("timed out");
    expect(h.timer.now()).toBe(DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS);
    expect(commanded).toBe(false);
    expect(released).toBe(true);
  });

  test.each(["shutdown", "verify"])(
    "shares one budget after a stalled lease and %s",
    async (stall) => {
      const h = harness(["Shutdown"]);
      const owner = h.lease.state.ownerToken;
      const budgets: number[] = [];
      h.context.acquireSimulatorBoot = async (_udid, deadline) => {
        expect(deadline).toBe(DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS);
        await h.timer.sleep(20_000);
        return h.lease;
      };
      h.context.executeCommandArgv = async (_args, timeout) => {
        budgets.push(timeout!);
        if (stall === "shutdown") {
          return new Promise(() => {});
        }
        await h.timer.sleep(20_000);
        return createExecResult("", "");
      };
      h.context.readSimulatorState = async (_udid, timeout) => {
        budgets.push(timeout);
        return new Promise(() => {});
      };
      await expect(
        h.shutdown.shutdownSimulatorCoordinated(
          "sim",
          DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS,
          undefined,
          { expectedOwnerToken: owner },
        ),
      ).rejects.toThrow("timed out");
      expect(h.timer.now()).toBe(DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS);
      expect(budgets).toEqual(stall === "shutdown" ? [40_000] : [40_000, 20_000]);
    },
  );
});

test.each(["success", "delete failure", "cleanup failure"])(
  "delete host cleanup: %s",
  async (mode) => {
    const h = harness([]);
    const calls: string[] = [];
    h.context.executeCommandArgv = async () => {
      calls.push("delete");
      if (mode === "delete failure") {
        throw new Error("delete failed");
      }
      return createExecResult("", "");
    };
    h.context.prebootProfile = {
      removeHostState: async (udid) => {
        expect(udid).toBe("sim");
        calls.push("cleanup");
        if (mode === "cleanup failure") {
          throw new Error("cleanup failed");
        }
      },
    };
    const shutdown = new SimCtlShutdown(h.context);
    if (mode === "delete failure") {
      await expect(shutdown.deleteSimulator("sim")).rejects.toThrow("delete failed");
      expect(calls).toEqual(["delete"]);
    } else {
      await shutdown.deleteSimulator("sim");
      expect(calls).toEqual(["delete", "cleanup"]);
    }
  },
);

test("SimCtlClient passes its injected host cleanup through to deletion", async () => {
  const calls: string[] = [];
  const timer = new FakeTimer();
  const client = new SimCtlClient(
    null,
    async (_file, args) => {
      expect(args).toEqual(["simctl", "delete", "injected-sim"]);
      calls.push("delete");
      return createExecResult("", "");
    },
    {
      timer,
      prebootProfile: {
        removeHostState: async (udid) => {
          calls.push(`cleanup:${udid}`);
        },
      },
    },
  );
  await client.deleteSimulator("injected-sim");
  expect(calls).toEqual(["delete", "cleanup:injected-sim"]);
});
