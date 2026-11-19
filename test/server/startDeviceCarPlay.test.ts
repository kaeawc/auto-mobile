import { describe, expect, test } from "bun:test";
import { startDeviceSchema } from "../../src/features/deviceLifecycle/deviceLifecycleCore";
import { ActionableError } from "../../src/models/ActionableError";
import { withRequestedCarPlay } from "../../src/server/startDeviceCarPlay";
import { parseCarPlayProjectionState } from "../../src/utils/ios/carPlayProjection";
import { createStructuredToolResponse, getStructuredPayload } from "../../src/utils/toolUtils";
import { FakeCarPlayProjectionProbe } from "../fakes/FakeCarPlayProjectionProbe";
import { FakeCarPlayScreenPowerer } from "../fakes/FakeCarPlayScreenPowerer";
import { FakeTimer } from "../fakes/FakeTimer";

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
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return { powerer, probe, deps: () => ({ powerer, probe, timer }) };
}

describe("startDevice carPlay", () => {
  test("leaves the response untouched when carPlay was not requested", async () => {
    const { powerer, deps } = fakes();
    expect(await withRequestedCarPlay(undefined, ready, bounds, deps)).toBe(ready);
    expect(powerer.calls).toEqual([]);
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

  test("accepts carPlay only as an empty object on iOS", () => {
    expect(startDeviceSchema.parse({ platform: "ios", carPlay: {} })).toMatchObject({
      carPlay: {},
    });
    expect(startDeviceSchema.safeParse({ platform: "android", carPlay: {} }).success).toBe(false);
    expect(startDeviceSchema.safeParse({ platform: "ios", carPlay: { size: 1 } }).success).toBe(
      false,
    );
    expect(startDeviceSchema.safeParse({ platform: "ios", carPlay: true }).success).toBe(false);
  });
});
