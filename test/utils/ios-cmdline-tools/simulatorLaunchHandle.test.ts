import { EventEmitter } from "node:events";
import { describe, expect, it, spyOn } from "bun:test";
import { createSimulatorLaunchHandle } from "../../../src/utils/ios-cmdline-tools/simulatorLaunchHandle";
import { terminateColdBootProcess } from "../../../src/devices/coldBootProcessTermination";
import { FakeTimer } from "../../fakes/FakeTimer";
import { logger } from "../../../src/utils/logger";

describe("createSimulatorLaunchHandle", () => {
  it("reports no OS process and delegates kill to the supplied cancellation", () => {
    let cancelled = 0;
    const handle = createSimulatorLaunchHandle(async () => {
      cancelled++;
    });

    expect(handle.pid).toBeUndefined();
    expect(handle.stdout).toBeNull();
    expect(handle.killed).toBe(false);
    expect(handle.kill()).toBe(true);
    expect(cancelled).toBe(1);
  });

  it("supports event listeners so lifecycle owners can subscribe", () => {
    const handle = createSimulatorLaunchHandle(async () => {});
    let exits = 0;
    handle.once("exit", () => {
      exits++;
    });
    if (!(handle instanceof EventEmitter)) {
      throw new Error("Expected an event-emitting launch handle");
    }
    handle.emit("exit");
    expect(exits).toBe(1);
  });

  it("waits for shutdown settlement before confirming a pidless handle", async () => {
    const shutdown = Promise.withResolvers<void>();
    let cancellations = 0;
    const handle = createSimulatorLaunchHandle(() => {
      cancellations++;
      return shutdown.promise;
    });
    const timer = new FakeTimer();
    expect(handle.exitCode).toBeNull();
    const termination = terminateColdBootProcess(handle, "simulator", timer);
    let confirmed: boolean | undefined;
    void termination.confirmed.then((value) => {
      confirmed = value;
    });
    timer.advanceTime(10_000);
    await Promise.resolve();
    expect(confirmed).toBeUndefined();
    expect(handle.exitCode).toBeNull();
    expect(handle.kill()).toBe(true);
    expect(cancellations).toBe(1);
    shutdown.resolve();
    expect(await termination.confirmed).toBe(true);
    await termination.exited;
    expect(handle.exitCode).toBe(0);
  });

  it("warns and never confirms a failed shutdown, including a settled handle", async () => {
    const failure = new Error("shutdown failed");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const handle = createSimulatorLaunchHandle(() => Promise.reject(failure));
      const timer = new FakeTimer();
      const termination = terminateColdBootProcess(handle, "simulator", timer);
      expect(await termination.confirmed).toBe(false);
      await termination.exited;
      expect(handle.exitCode).toBe(1);
      expect(await terminateColdBootProcess(handle, "simulator", timer).confirmed).toBe(false);
      expect(warn.mock.calls.some((call) => call.includes(failure))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
