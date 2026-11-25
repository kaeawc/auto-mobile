import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  activateCarPlayDisplay,
  CAR_DISPLAY_PROBE_ATTEMPTS,
  CAR_DISPLAY_PROBE_INTERVAL_MS,
} from "../../../src/utils/ios/carPlayDisplay";
import { parseCarPlayProjectionState } from "../../../src/utils/ios/carPlayProjection";
import { FakeCarPlayProjectionProbe } from "../../fakes/FakeCarPlayProjectionProbe";
import { FakeCarPlayScreenPowerer } from "../../fakes/FakeCarPlayScreenPowerer";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeCarPlayRuntimeReader } from "../../fakes/FakeCarPlayRuntimeReader";

// Real projection probe captures from fresh iPhone 17 Pro simulators (#18728), as in
// carPlayProjection.test.ts: iOS 26.5 after boot, and after carplay-power-helper power-on.
const untagged = parseCarPlayProjectionState(
  '{"deviceName":"PurpleTVOut","displayId":2,"displayType":1,"found":true,"identity":"Untagged[2]","isCarDisplay":false,"isCarInstrumentsDisplay":false,"name":"TVOut","tag":0}',
);
const car = parseCarPlayProjectionState(
  '{"deviceName":"PurpleTVOut","displayId":2,"displayType":1,"found":true,"identity":"Car[2]","isCarDisplay":true,"isCarInstrumentsDisplay":false,"name":"TVOut","tag":32}',
);
// carplay-power-helper power-on output captured on a fresh iOS 26.5 iPhone 17 Pro simulator.
const powered = {
  carPlay: { powerState: 1, found: true, screenID: 2 },
  screens: [
    { width: 720, id: 3, name: "Wireless", screenType: 2, powerState: 0, height: 480 },
    { width: 800, id: 2, name: "TVOut", screenType: 1, powerState: 1, height: 480 },
    { width: 1206, id: 1, name: "LCD", screenType: 0, powerState: 1, height: 2622 },
  ],
};
const udid = "SIM-UDID";

function setup(probeState = car) {
  const powerer = new FakeCarPlayScreenPowerer(powered);
  const probe = new FakeCarPlayProjectionProbe(probeState);
  const runtime = new FakeCarPlayRuntimeReader();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return { powerer, probe, runtime, timer, deps: { powerer, probe, runtime, timer } };
}

describe("activateCarPlayDisplay", () => {
  test("powers on, then reports the car display the probe finds", async () => {
    const { powerer, probe, timer, deps } = setup();
    await expect(activateCarPlayDisplay(udid, deps, { deadlineMs: 60_000 })).resolves.toEqual({
      display: "Car[2]",
      displayId: 2,
    });
    expect(powerer.calls).toEqual([{ udid, action: "power-on" }]);
    expect(probe.calls).toEqual([udid]);
    expect(timer.getSleepCallCount()).toBe(0);
  });

  test("asks for head-unit inputs at power-on and reports them", async () => {
    const { powerer, deps } = setup();
    await expect(
      activateCarPlayDisplay(udid, deps, { deadlineMs: 60_000 }, { headUnitInputs: true }),
    ).resolves.toEqual({ display: "Car[2]", displayId: 2, headUnitInputs: true });
    expect(powerer.powerOnOptions).toEqual([{ timeoutMs: 60_000, headUnitInputs: true }]);
  });

  test("waits on the fake clock until the display takes the car tag", async () => {
    const { probe, timer, deps } = setup();
    probe.queued.push(untagged, untagged);
    const report = await activateCarPlayDisplay(udid, deps, { deadlineMs: 60_000 });
    expect(report.display).toBe("Car[2]");
    expect(probe.calls).toHaveLength(3);
    expect(timer.getSleepHistory()).toEqual([
      CAR_DISPLAY_PROBE_INTERVAL_MS,
      CAR_DISPLAY_PROBE_INTERVAL_MS,
    ]);
  });

  test("refuses an untagged display after the bounded probes", async () => {
    const { probe, timer, deps } = setup(untagged);
    const run = activateCarPlayDisplay(udid, deps, { deadlineMs: 60_000 });
    await expect(run).rejects.toThrow(ActionableError);
    await expect(run).rejects.toThrow("Untagged[2] (TVOut), not the car display");
    expect(probe.calls).toHaveLength(CAR_DISPLAY_PROBE_ATTEMPTS);
    expect(timer.getSleepCallCount()).toBe(CAR_DISPLAY_PROBE_ATTEMPTS - 1);
  });

  test("stops probing at the request deadline", async () => {
    const { probe, timer, deps } = setup(untagged);
    await expect(
      activateCarPlayDisplay(udid, deps, { deadlineMs: timer.now() + 100 }),
    ).rejects.toThrow("not the car display");
    expect(probe.calls).toHaveLength(1);
    expect(timer.getSleepCallCount()).toBe(0);
  });

  test("passes the helper's unsupported-runtime error through unchanged", async () => {
    const { powerer, probe, deps } = setup();
    const refusal = new ActionableError(
      "[unsupported-runtime] Headless CarPlay needs an iOS 26.x runtime (found 27.0).",
    );
    powerer.error = refusal;
    await expect(activateCarPlayDisplay(udid, deps, { deadlineMs: 60_000 })).rejects.toBe(refusal);
    expect(probe.calls).toEqual([]);
  });

  test("gives power-on and each probe the signal and the remaining budget", async () => {
    const { powerer, probe, timer, deps } = setup();
    probe.queued.push(untagged);
    const controller = new AbortController();
    await activateCarPlayDisplay(udid, deps, {
      deadlineMs: timer.now() + 60_000,
      signal: controller.signal,
    });
    expect(powerer.powerOnOptions).toEqual([{ signal: controller.signal, timeoutMs: 60_000 }]);
    expect(probe.options).toEqual([
      { signal: controller.signal, timeoutMs: 60_000 },
      { signal: controller.signal, timeoutMs: 60_000 - CAR_DISPLAY_PROBE_INTERVAL_MS },
    ]);
  });

  test("a wedged power-on stops at the request deadline", async () => {
    const { powerer, probe, timer, deps } = setup();
    powerer.hangPowerOn = true;
    await expect(
      activateCarPlayDisplay(udid, deps, { deadlineMs: timer.now() + 5_000 }),
    ).rejects.toThrow(`CarPlay power-on on ${udid} timed out after 5000ms`);
    expect(timer.now()).toBe(5_000);
    expect(probe.calls).toEqual([]);
  });

  test("a wedged probe stops at the request deadline", async () => {
    const { probe, timer, deps } = setup();
    probe.hang = true;
    await expect(
      activateCarPlayDisplay(udid, deps, { deadlineMs: timer.now() + 5_000 }),
    ).rejects.toThrow(`CarPlay probe on ${udid} timed out after 5000ms`);
    expect(probe.calls).toHaveLength(1);
  });

  test("a cancel during a wedged power-on returns at once", async () => {
    const { powerer, probe, runtime } = setup();
    powerer.hangPowerOn = true;
    // A manual clock: nothing advances, so only the cancel can end the call.
    const timer = new FakeTimer();
    const controller = new AbortController();
    const reason = new Error("device lost");
    const run = activateCarPlayDisplay(
      udid,
      { powerer, probe, runtime, timer },
      { deadlineMs: 60_000, signal: controller.signal },
    );
    // The runtime check settles first; let it reach the wedged power-on.
    for (let turn = 0; turn < 50 && powerer.calls.length === 0; turn++) {
      await Promise.resolve();
    }
    expect(powerer.calls).toEqual([{ udid, action: "power-on" }]);
    controller.abort(reason);
    await expect(run).rejects.toBe(reason);
    expect(probe.calls).toEqual([]);
  });

  test("does nothing once the request is cancelled", async () => {
    const { powerer, deps } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      activateCarPlayDisplay(udid, deps, { deadlineMs: 60_000, signal: controller.signal }),
    ).rejects.toThrow();
    expect(powerer.calls).toEqual([]);
  });
});

describe("activateCarPlayDisplay on an iOS 27 simulator (#19185)", () => {
  test("refuses with unsupported-runtime before power-on or the probe", async () => {
    const { powerer, probe, runtime, deps } = setup();
    runtime.version = "27.2";
    await expect(activateCarPlayDisplay(udid, deps, { deadlineMs: 60_000 })).rejects.toThrow(
      "[unsupported-runtime] Headless CarPlay needs an iOS 26.x runtime (found 27.2)",
    );
    expect(powerer.calls).toEqual([]);
    expect(probe.calls).toEqual([]);
  });
});
