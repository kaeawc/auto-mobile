import { describe, expect, test } from "bun:test";
import { DeviceActionClock } from "../../src/server/pipeline/deviceActionClock";

describe("DeviceActionClock (#14082)", () => {
  test("only control calls move a device's last-action start, and only forward", () => {
    const clock = new DeviceActionClock();
    clock.recordDispatch("read-1", 500, "emulator-5554");
    expect(clock.lastActionStartMs("emulator-5554")).toBeUndefined();
    clock.markControl("tap-1");
    clock.recordDispatch("tap-1", 1_000, "emulator-5554");
    clock.markControl("tap-0");
    clock.recordDispatch("tap-0", 900, "emulator-5554");
    expect(clock.lastActionStartMs("emulator-5554")).toBe(1_000);
    expect(clock.lastActionStartMs("emulator-5556")).toBeUndefined();
  });

  test("ignores dispatches without execution context and bounds pending control ids", () => {
    const clock = new DeviceActionClock();
    clock.markControl("first");
    for (let index = 0; index < 300; index++) {
      clock.markControl(`call-${index}`);
    }
    clock.recordDispatch("first", 10, "d");
    clock.recordDispatch(undefined, 20, "d");
    clock.recordDispatch("call-299", "20", "d");
    expect(clock.lastActionStartMs("d")).toBeUndefined();
    clock.recordDispatch("call-299", 30, "d");
    expect(clock.lastActionStartMs("d")).toBe(30);
  });
});
