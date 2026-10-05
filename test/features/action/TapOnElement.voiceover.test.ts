import { DEFAULT_GESTURE_REQUEST_TIMEOUT_MS } from "../../../src/features/observe/shared/SharedGestureDelegate";
import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { LONG_PRESS_TIMEOUT_HEADROOM_MS } from "../../../src/features/action/gestureTransportTimeout";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeIosVoiceOverDetector } from "../../fakes/FakeIosVoiceOverDetector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";

describe("TapOnElement VoiceOver mode", () => {
  let fakeVoiceOverDetector: FakeIosVoiceOverDetector;
  let fakeAdb: FakeAdbClient;
  let fakeTimer: FakeTimer;
  let fakeIosClient: FakeIOSCtrlProxy;
  let tapOnElement: TapOnElement;
  let executeiOSTapWithCoordinates: any;

  beforeEach(() => {
    fakeVoiceOverDetector = new FakeIosVoiceOverDetector();
    fakeAdb = new FakeAdbClient();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    fakeIosClient = new FakeIOSCtrlProxy();

    tapOnElement = new TapOnElement(
      {
        name: "test-iphone",
        platform: "ios",
        id: "00001234-ABCD",
        deviceId: "00001234-ABCD",
      } as any,
      fakeAdb as any,
      {
        iosVoiceOverDetector: fakeVoiceOverDetector,
        timer: fakeTimer,
      },
    );

    executeiOSTapWithCoordinates = null;
  });

  // These dispatch-routing tests deliberately do NOT mock the two transport
  // methods. Instead they let the real transport run against the fake CtrlProxy
  // and assert the observable artifact each one leaves (a coordinate tap in
  // tapHistory vs a VoiceOver activation in voiceOverActivateHistory). An earlier
  // version mocked both targets and only asserted which mock was called, so no
  // real code ran and the routing could not actually regress the test.
  describe("dispatch routing (real transport artifacts)", () => {
    let getInstanceSpy: ReturnType<typeof spyOn> | null = null;

    const wireCtrlProxy = async () => {
      const iosModule = await import("../../../src/features/observe/ios");
      getInstanceSpy = spyOn(iosModule.IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeIosClient as any,
      );
    };

    afterEach(() => {
      getInstanceSpy?.mockRestore();
      getInstanceSpy = null;
    });

    const element = {
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      "ios-accessibility-label": "Settings",
    } as any;

    for (const action of ["tap", "longPress"] as const) {
      test.each([
        "Timeout waiting for action_result",
        "runner disconnected",
        "activation cancelled",
      ])(`${action}: dispatched unconfirmed activation (%s) never falls back`, async (error) => {
        await wireCtrlProxy();
        const result = { success: false, error, dispatched: true };
        fakeIosClient.setVoiceOverActivateResult(result);
        await expect(
          tapOnElement["executeIOSTapWithVoiceOver"](action, element, 50, 50, 1000),
        ).rejects.toMatchObject({
          message: `Tap outcome is indeterminate: the request was dispatched but no result was confirmed (${error}). Do not retry automatically.`,
        });
        expect(fakeIosClient.getVoiceOverActivateHistory()).toHaveLength(1);
        expect(fakeIosClient.getVoiceOverActivateHistory()[0].action).toBe(
          action === "longPress" ? "long_press" : "activate",
        );
        expect(fakeIosClient.getTapHistory()).toHaveLength(0);
      });

      test.each([
        "Element not found",
        "Not activatable",
        "runner rejected request_action as unknown",
        "Timeout waiting for action_result",
      ])(
        `${action}: acknowledged refusal (%s) permits exactly one coordinate fallback`,
        async (error) => {
          await wireCtrlProxy();
          const result = { success: false, error, dispatched: true, acknowledged: true };
          fakeIosClient.setVoiceOverActivateResult(result);
          await tapOnElement["executeIOSTapWithVoiceOver"](action, element, 50, 50, 1000);
          expect(fakeIosClient.getVoiceOverActivateHistory()).toHaveLength(1);
          expect(fakeIosClient.getTapHistory()).toEqual([
            { x: 50, y: 50, duration: action === "longPress" ? 1000 : 50 },
          ]);
        },
      );

      test(`${action}: not dispatched permits coordinate fallback`, async () => {
        await wireCtrlProxy();
        const result = {
          success: false,
          error: "Not connected to CtrlProxy",
          dispatched: false,
          acknowledged: false,
        };
        fakeIosClient.setVoiceOverActivateResult(result);
        await tapOnElement["executeIOSTapWithVoiceOver"](action, element, 50, 50, 1000);
        expect(fakeIosClient.getTapHistory()).toHaveLength(1);
        expect(fakeIosClient.getVoiceOverActivateHistory()).toHaveLength(1);
      });

      test(`${action}: successful activation invalidates the cache without a coordinate tap`, async () => {
        await wireCtrlProxy();
        const existing = spyOn(IOSCtrlProxyClient, "getExistingInstance").mockReturnValue(
          fakeIosClient as unknown as IOSCtrlProxyClient,
        );
        const invalidate = spyOn(fakeIosClient, "invalidateCache");
        try {
          await tapOnElement["executeIOSTapWithVoiceOver"](action, element, 50, 50, 1000);
          expect(invalidate).toHaveBeenCalledTimes(1);
          expect(fakeIosClient.getVoiceOverActivateHistory()).toHaveLength(1);
          expect(fakeIosClient.getTapHistory()).toHaveLength(0);
        } finally {
          invalidate.mockRestore();
          existing.mockRestore();
        }
      });
    }

    test.each(["tap", "doubleTap", "longPress"] as const)(
      "%s coordinate transport uses the requested long-press timeout only",
      async (action) => {
        await wireCtrlProxy();
        const request = spyOn(fakeIosClient, "requestTapCoordinates");
        await tapOnElement["executeiOSTapWithCoordinates"](action, 50, 50, 500);
        expect(request.mock.calls).toHaveLength(action === "doubleTap" ? 2 : 1);
        for (const call of request.mock.calls) {
          expect(call[2]).toBe(action === "longPress" ? 500 : 50);
          expect(call[3]).toBe(
            action === "longPress" ? DEFAULT_GESTURE_REQUEST_TIMEOUT_MS : undefined,
          );
        }
      },
    );

    for (const duration of [500, 4000]) {
      test.each(["tap", "doubleTap", "longPress"] as const)(
        `%s VoiceOver transport sizes only long presses (${duration}ms)`,
        async (action) => {
          await wireCtrlProxy();
          const request = spyOn(fakeIosClient, "requestVoiceOverActivate");
          await tapOnElement["executeIOSTapWithVoiceOver"](action, element, 50, 50, duration);
          expect(request.mock.calls[0][1]).toBe(action === "longPress" ? "long_press" : "activate");
          expect(request.mock.calls[0][2]).toBe(
            action === "longPress"
              ? Math.max(
                  DEFAULT_GESTURE_REQUEST_TIMEOUT_MS,
                  duration + LONG_PRESS_TIMEOUT_HEADROOM_MS,
                )
              : undefined,
          );
        },
      );
    }

    test("VoiceOver disabled + element records a coordinate tap only", async () => {
      fakeVoiceOverDetector.setVoiceOverEnabled(false);
      await wireCtrlProxy();

      await (tapOnElement as any).executeiOSTap("tap", 50, 50, 50, element, false);

      expect(fakeIosClient.getTapHistory()).toEqual([{ x: 50, y: 50, duration: 50 }]);
      expect(fakeIosClient.getVoiceOverActivateHistory()).toHaveLength(0);
    });

    test("VoiceOver disabled + no element records a coordinate tap only", async () => {
      fakeVoiceOverDetector.setVoiceOverEnabled(false);
      await wireCtrlProxy();

      await (tapOnElement as any).executeiOSTap("tap", 50, 50, 50, undefined, false);

      expect(fakeIosClient.getTapHistory()).toHaveLength(1);
      expect(fakeIosClient.getVoiceOverActivateHistory()).toHaveLength(0);
    });

    test("VoiceOver enabled + element records a VoiceOver activation only", async () => {
      fakeVoiceOverDetector.setVoiceOverEnabled(true);
      await wireCtrlProxy();

      await (tapOnElement as any).executeiOSTap("tap", 50, 50, 50, element, true);

      expect(fakeIosClient.getVoiceOverActivateHistory()).toEqual([
        { label: "Settings", action: "activate", bounds: element.bounds, duration: undefined },
      ]);
      expect(fakeIosClient.getTapHistory()).toHaveLength(0);
    });

    test("VoiceOver enabled + no element falls back to a coordinate tap", async () => {
      fakeVoiceOverDetector.setVoiceOverEnabled(true);
      await wireCtrlProxy();

      await (tapOnElement as any).executeiOSTap("tap", 50, 50, 50, undefined, true);

      expect(fakeIosClient.getTapHistory()).toHaveLength(1);
      expect(fakeIosClient.getVoiceOverActivateHistory()).toHaveLength(0);
    });
  });

  describe("executeIOSTapWithVoiceOver", () => {
    beforeEach(() => {
      // Mock only the coordinate fallback so the real VoiceOver path runs and
      // records its artifact against the fake CtrlProxy client.
      executeiOSTapWithCoordinates = spyOn(
        tapOnElement as any,
        "executeiOSTapWithCoordinates",
      ).mockResolvedValue(undefined);
    });

    test("uses ios-accessibility-label as VoiceOver label", async () => {
      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        "ios-accessibility-label": "Settings Button",
        text: "Settings",
      } as any;

      // Patch IOSCtrlProxyClient.getInstance to return fakeIosClient
      const iosModule = await import("../../../src/features/observe/ios");
      const getInstanceSpy = spyOn(iosModule.IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeIosClient as any,
      );

      await (tapOnElement as any).executeIOSTapWithVoiceOver("tap", element, 50, 50, 50);

      const history = fakeIosClient.getVoiceOverActivateHistory();
      expect(history).toHaveLength(1);
      expect(history[0].label).toBe("Settings Button");
      expect(history[0].action).toBe("activate");

      getInstanceSpy.mockRestore();
    });

    test("falls back to text when no ios-accessibility-label", async () => {
      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        text: "Settings",
      } as any;

      const iosModule = await import("../../../src/features/observe/ios");
      const getInstanceSpy = spyOn(iosModule.IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeIosClient as any,
      );

      await (tapOnElement as any).executeIOSTapWithVoiceOver("tap", element, 50, 50, 50);

      const history = fakeIosClient.getVoiceOverActivateHistory();
      expect(history).toHaveLength(1);
      expect(history[0].label).toBe("Settings");

      getInstanceSpy.mockRestore();
    });

    test("falls back to coordinate tap when no label available", async () => {
      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      } as any;

      const iosModule = await import("../../../src/features/observe/ios");
      const getInstanceSpy = spyOn(iosModule.IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeIosClient as any,
      );

      await (tapOnElement as any).executeIOSTapWithVoiceOver("tap", element, 50, 50, 50);

      expect(executeiOSTapWithCoordinates).toHaveBeenCalledTimes(1);
      expect(fakeIosClient.getVoiceOverActivateHistory()).toHaveLength(0);

      getInstanceSpy.mockRestore();
    });

    test("maps longPress action to long_press VoiceOver action", async () => {
      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        "ios-accessibility-label": "Delete",
      } as any;

      const iosModule = await import("../../../src/features/observe/ios");
      const getInstanceSpy = spyOn(iosModule.IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeIosClient as any,
      );

      await (tapOnElement as any).executeIOSTapWithVoiceOver("longPress", element, 50, 50, 1000);

      const history = fakeIosClient.getVoiceOverActivateHistory();
      expect(history).toHaveLength(1);
      expect(history[0].action).toBe("long_press");
      expect(history[0].bounds).toEqual(element.bounds);
      expect(history[0].duration).toBe(1000);

      getInstanceSpy.mockRestore();
    });

    test("maps tap action to activate VoiceOver action", async () => {
      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        "ios-accessibility-label": "Save",
      } as any;

      const iosModule = await import("../../../src/features/observe/ios");
      const getInstanceSpy = spyOn(iosModule.IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeIosClient as any,
      );

      await (tapOnElement as any).executeIOSTapWithVoiceOver("tap", element, 50, 50, 50);

      const history = fakeIosClient.getVoiceOverActivateHistory();
      expect(history[0].action).toBe("activate");

      getInstanceSpy.mockRestore();
    });

    test("maps doubleTap action to activate VoiceOver action", async () => {
      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        "ios-accessibility-label": "Item",
      } as any;

      const iosModule = await import("../../../src/features/observe/ios");
      const getInstanceSpy = spyOn(iosModule.IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeIosClient as any,
      );

      await (tapOnElement as any).executeIOSTapWithVoiceOver("doubleTap", element, 50, 50, 50);

      const history = fakeIosClient.getVoiceOverActivateHistory();
      expect(history[0].action).toBe("activate");

      getInstanceSpy.mockRestore();
    });

    test("falls back to coordinate tap when requestVoiceOverActivate fails", async () => {
      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        "ios-accessibility-label": "Button",
      } as any;

      fakeIosClient.setVoiceOverActivateResult({ success: false, error: "Element not found" });

      const iosModule = await import("../../../src/features/observe/ios");
      const getInstanceSpy = spyOn(iosModule.IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeIosClient as any,
      );

      await (tapOnElement as any).executeIOSTapWithVoiceOver("tap", element, 50, 50, 50);

      expect(executeiOSTapWithCoordinates).toHaveBeenCalledTimes(1);

      getInstanceSpy.mockRestore();
    });
  });
});
