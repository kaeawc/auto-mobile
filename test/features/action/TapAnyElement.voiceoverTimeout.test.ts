import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { TapAnyIosTapper } from "../../../src/features/action/TapAnyIosTapper";
import { VoiceOverTapTimeoutError } from "../../../src/features/action/tapIosVoiceOver";
import {
  IndeterminateTapError,
  indeterminateTapError,
} from "../../../src/features/action/coordinateTapDispatch";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import type { BootedDevice, Element } from "../../../src/models";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeIosVoiceOverDetector } from "../../fakes/FakeIosVoiceOverDetector";
import type { FeatureFlagReader } from "../../../src/features/featureFlags/FeatureFlagService";
import { FakeTimer } from "../../fakes/FakeTimer";

// #17626: a tapAny timeout with VoiceOver on carries the same typed remedy as tapOn.
const DEVICE: BootedDevice = { deviceId: "00001234-ABCD", platform: "ios", name: "test-iphone" };
const flags: FeatureFlagReader = { isEnabled: () => true };
const TIMEOUT = "Timeout waiting for tap_result";
const labeled: Element = {
  bounds: { left: 0, top: 0, right: 100, bottom: 100 },
  "ios-accessibility-label": "OK",
};

describe("tapAny iOS tap timeout under VoiceOver", () => {
  let fakeClient: FakeIOSCtrlProxy;
  let detector: FakeIosVoiceOverDetector;
  let tapper: TapAnyIosTapper;
  let getInstance: ReturnType<typeof spyOn> | null = null;

  beforeEach(() => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    fakeClient = new FakeIOSCtrlProxy(timer);
    const client = IOSCtrlProxyClient.createForTesting(DEVICE, 8766, {
      wsFactory: () => {
        throw new Error("Unexpected live iOS socket");
      },
      timer,
    });
    client.requestTapCoordinates = (...args) => fakeClient.requestTapCoordinates(...args);
    client.requestDoubleTapCoordinates = (...args) =>
      fakeClient.requestDoubleTapCoordinates(...args);
    client.requestVoiceOverActivate = (...args) => fakeClient.requestVoiceOverActivate(...args);
    getInstance = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(client);
    detector = new FakeIosVoiceOverDetector();
    tapper = new TapAnyIosTapper({
      device: DEVICE,
      iosVoiceOverDetector: detector,
      featureFlags: flags,
    });
    fakeClient.setTapResult({
      success: false,
      error: TIMEOUT,
      totalTimeMs: 5000,
      dispatched: true,
      acknowledged: false,
    });
    fakeClient.setVoiceOverActivateResult({
      success: false,
      error: TIMEOUT,
      dispatched: true,
      acknowledged: false,
    });
  });

  afterEach(() => {
    getInstance?.mockRestore();
    getInstance = null;
  });

  test.each([
    ["activation", labeled],
    ["coordinate", undefined],
  ] as const)("VoiceOver on: %s timeout names the remedy", async (_route, element) => {
    detector.setVoiceOverEnabled(true);
    const result = tapper.executeIosTap("tap", { x: 50, y: 50 }, 800, { element });
    await expect(result).rejects.toBeInstanceOf(VoiceOverTapTimeoutError);
    await expect(result).rejects.toBeInstanceOf(IndeterminateTapError);
    await expect(result).rejects.toMatchObject({ cause: expect.any(IndeterminateTapError) });
    for (const text of [TIMEOUT, "Do not retry automatically", "voiceover:false", "observe"]) {
      await expect(result).rejects.toThrow(text);
    }
    await expect(result).rejects.not.toThrow("Duo");
    expect(fakeClient.getVoiceOverActivateHistory()).toHaveLength(element ? 1 : 0);
    expect(fakeClient.getTapHistory()).toHaveLength(element ? 0 : 1);
  });

  test("VoiceOver off: the coordinate timeout is unchanged", async () => {
    detector.setVoiceOverEnabled(false);
    const result = tapper.executeIosTap("tap", { x: 50, y: 50 }, 800, { element: labeled });
    await expect(result).rejects.toMatchObject({ message: indeterminateTapError(TIMEOUT).message });
    await expect(result).rejects.not.toBeInstanceOf(VoiceOverTapTimeoutError);
    expect(fakeClient.getVoiceOverActivateHistory()).toHaveLength(0);
    expect(fakeClient.getTapHistory()).toHaveLength(1);
  });

  test("VoiceOver on: a refusal that is not a timeout is unchanged", async () => {
    detector.setVoiceOverEnabled(true);
    fakeClient.setVoiceOverActivateResult({
      success: false,
      error: "Element not found: OK",
      dispatched: true,
      acknowledged: true,
    });
    const result = tapper.executeIosTap("tap", { x: 50, y: 50 }, 800, { element: labeled });
    await expect(result).rejects.toThrow('VoiceOver action failed for label "OK"');
    await expect(result).rejects.not.toBeInstanceOf(IndeterminateTapError);
  });
});
