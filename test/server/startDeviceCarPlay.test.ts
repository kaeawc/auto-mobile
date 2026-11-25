import { describe, expect, test } from "bun:test";
import { startDeviceSchema } from "../../src/features/deviceLifecycle/deviceLifecycleCore";
import { ActionableError } from "../../src/models/ActionableError";
import { withRequestedCarPlay } from "../../src/server/startDeviceCarPlay";
import { parseCarPlayProjectionState } from "../../src/utils/ios/carPlayProjection";
import { createStructuredToolResponse, getStructuredPayload } from "../../src/utils/toolUtils";
import { FakeCarPlayProjectionProbe } from "../fakes/FakeCarPlayProjectionProbe";
import { FakeCarPlayScreenPowerer } from "../fakes/FakeCarPlayScreenPowerer";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeCarPlayRuntimeReader } from "../fakes/FakeCarPlayRuntimeReader";

// Captured on a fresh iOS 26.5 iPhone 17 Pro simulator after power-on (#18728).
const car = parseCarPlayProjectionState(
  '{"deviceName":"PurpleTVOut","displayId":2,"displayType":1,"found":true,"identity":"Car[2]","isCarDisplay":true,"isCarInstrumentsDisplay":false,"name":"TVOut","tag":32}',
);
const powered = {
  carPlay: { powerState: 1, found: true, screenID: 2 },
  screens: [{ width: 800, id: 2, name: "TVOut", screenType: 1, powerState: 1, height: 480 }],
};
const ready = createStructuredToolResponse({
  name: "iPhone 17 Pro",
  platform: "ios",
  message: "ready",
  runtime: { deviceId: "SIM-UDID", session: { sessionUuid: "session-1" } },
});
const bounds = { signal: undefined, totalDeadlineMs: 60_000 };

function fakes() {
  const powerer = new FakeCarPlayScreenPowerer(powered);
  const probe = new FakeCarPlayProjectionProbe(car);
  const runtime = new FakeCarPlayRuntimeReader();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const sessionWork = new AbortController();
  const holds: Array<{ sessionUuid: string; deadlineMs: number; released: boolean }> = [];
  const holdAcquiringSession = (sessionUuid: string, deadlineMs: number) => {
    const hold = { sessionUuid, deadlineMs, released: false };
    holds.push(hold);
    return {
      signal: sessionWork.signal,
      release: () => {
        hold.released = true;
      },
    };
  };
  return {
    powerer,
    probe,
    runtime,
    holds,
    sessionWork,
    deps: () => ({ powerer, probe, runtime, timer, holdAcquiringSession }),
  };
}

describe("startDevice carPlay", () => {
  test("leaves the response untouched when carPlay was not requested", async () => {
    const { powerer, deps } = fakes();
    expect(await withRequestedCarPlay(undefined, ready, bounds, deps)).toBe(ready);
    expect(powerer.calls).toEqual([]);
  });

  test("an iOS 27 simulator gets unsupported-runtime before the helpers run (#19185)", async () => {
    const { powerer, probe, runtime, deps } = fakes();
    runtime.version = "27.2";
    powerer.error = new ActionableError("power helper missing");
    const result = withRequestedCarPlay({}, ready, bounds, deps);
    await expect(result).rejects.toThrow(
      /^\[unsupported-runtime\] Headless CarPlay needs an iOS 26\.x runtime \(found 27\.2\)/,
    );
    expect(runtime.calls).toEqual(["SIM-UDID"]);
    expect(powerer.calls).toEqual([]);
    expect(probe.calls).toEqual([]);
  });

  test("powers on the ready simulator and reports the car display", async () => {
    const { powerer, deps } = fakes();
    const response = await withRequestedCarPlay({}, ready, bounds, deps);
    expect(getStructuredPayload(response)).toMatchObject({
      message: "ready",
      carPlay: { display: "Car[2]", displayId: 2 },
    });
    expect(powerer.calls).toEqual([{ udid: "SIM-UDID", action: "power-on" }]);
  });

  test("powers on with head-unit inputs when asked", async () => {
    const { powerer, deps } = fakes();
    const response = await withRequestedCarPlay({ headUnitInputs: true }, ready, bounds, deps);
    expect(getStructuredPayload(response)).toMatchObject({
      carPlay: { display: "Car[2]", displayId: 2, headUnitInputs: true },
    });
    expect(powerer.powerOnOptions[0]).toMatchObject({ headUnitInputs: true });
  });

  test("holds the bound session while CarPlay activates, then releases it", async () => {
    const { holds, powerer, deps } = fakes();
    let heldDuringPowerOn = false;
    const powerOn = powerer.powerOn.bind(powerer);
    powerer.powerOn = async (udid, options) => {
      heldDuringPowerOn = holds.length === 1 && !holds[0].released;
      return await powerOn(udid, options);
    };
    await withRequestedCarPlay({}, ready, bounds, deps);
    expect(heldDuringPowerOn).toBe(true);
    expect(holds).toEqual([{ sessionUuid: "session-1", deadlineMs: 60_000, released: true }]);
  });

  test("a cancel of the held session's work stops a wedged power-on", async () => {
    const { holds, powerer, probe, sessionWork, deps } = fakes();
    powerer.hangPowerOn = true;
    const run = withRequestedCarPlay({}, ready, bounds, deps);
    // The runtime check settles first; let it reach the wedged power-on.
    for (let turn = 0; turn < 50 && powerer.calls.length === 0; turn++) {
      await Promise.resolve();
    }
    expect(powerer.calls).toHaveLength(1);
    sessionWork.abort(new Error("device lost"));
    await expect(run).rejects.toThrow(
      "SIM-UDID is ready and bound to session session-1, but its CarPlay display is not available: device lost",
    );
    expect(powerer.powerOnOptions[0]?.signal?.aborted).toBe(true);
    expect(probe.calls).toEqual([]);
    expect(holds[0].released).toBe(true);
  });

  test("returns unsupported-runtime unchanged", async () => {
    const { powerer, deps } = fakes();
    const refusal = new ActionableError(
      "[unsupported-runtime] Headless CarPlay needs an iOS 26.x runtime (found 27.0).",
    );
    powerer.error = refusal;
    await expect(withRequestedCarPlay({}, ready, bounds, deps)).rejects.toBe(refusal);
  });

  test("names the held simulator and session for any other failure", async () => {
    const { probe, deps } = fakes();
    probe.error = new ActionableError("probe missing");
    await expect(withRequestedCarPlay({}, ready, bounds, deps)).rejects.toThrow(
      "SIM-UDID is ready and bound to session session-1, but its CarPlay display is not available: probe missing",
    );
  });

  test("accepts carPlay only as an object with an optional headUnitInputs on iOS", () => {
    expect(startDeviceSchema.parse({ platform: "ios", carPlay: {} })).toMatchObject({
      carPlay: {},
    });
    expect(
      startDeviceSchema.parse({ platform: "ios", carPlay: { headUnitInputs: true } }),
    ).toMatchObject({ carPlay: { headUnitInputs: true } });
    expect(
      startDeviceSchema.safeParse({ platform: "ios", carPlay: { headUnitInputs: "yes" } }).success,
    ).toBe(false);
    expect(startDeviceSchema.safeParse({ platform: "android", carPlay: {} }).success).toBe(false);
    expect(startDeviceSchema.safeParse({ platform: "ios", carPlay: { size: 1 } }).success).toBe(
      false,
    );
    expect(startDeviceSchema.safeParse({ platform: "ios", carPlay: true }).success).toBe(false);
  });
});
