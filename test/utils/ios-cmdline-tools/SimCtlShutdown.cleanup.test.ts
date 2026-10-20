import { describe, expect, test } from "bun:test";
import { Mutex } from "async-mutex";
import {
  SimCtlShutdown,
  type SimCtlShutdownContext,
} from "../../../src/utils/ios-cmdline-tools/SimCtlShutdown";
import { DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS } from "../../../src/utils/deviceTimeouts";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";

function harness(states: string[]) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
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
  };
  return { timer, lease, context, shutdown: new SimCtlShutdown(context) };
}

describe("failed boot cleanup settlement", () => {
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
        h.lease.state.ownerToken,
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
          owner,
        ),
      ).rejects.toThrow("timed out");
      expect(h.timer.now()).toBe(DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS);
      expect(budgets).toEqual(stall === "shutdown" ? [40_000] : [40_000, 20_000]);
    },
  );
});
