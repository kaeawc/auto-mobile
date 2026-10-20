import { EventEmitter } from "node:events";
import { describe, expect, it } from "bun:test";
import { createSimulatorLaunchHandle } from "../../../src/utils/ios-cmdline-tools/simulatorLaunchHandle";

describe("createSimulatorLaunchHandle", () => {
  it("reports no OS process and delegates kill to the supplied cancellation", () => {
    let cancelled = 0;
    const handle = createSimulatorLaunchHandle(() => {
      cancelled++;
      return true;
    });

    expect(handle.pid).toBeUndefined();
    expect(handle.stdout).toBeNull();
    expect(handle.killed).toBe(false);
    expect(handle.kill()).toBe(true);
    expect(cancelled).toBe(1);
  });

  it("supports event listeners so lifecycle owners can subscribe", () => {
    const handle = createSimulatorLaunchHandle(() => true);
    let exits = 0;
    handle.once("exit", () => {
      exits++;
    });
    if (!(handle instanceof EventEmitter)) {
      throw new Error("Expected event emitter");
    }
    handle.emit("exit");
    expect(exits).toBe(1);
  });
});
