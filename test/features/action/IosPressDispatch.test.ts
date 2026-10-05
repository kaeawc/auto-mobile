import { describe, expect, spyOn, test } from "bun:test";
import { PressButton } from "../../../src/features/action/PressButton";
import { InputKey } from "../../../src/features/action/InputKey";
import { ExecuteGesture } from "../../../src/features/action/ExecuteGesture";
import { RecentApps } from "../../../src/features/action/RecentApps";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { CtrlProxyNavigation } from "../../../src/features/observe/ios/CtrlProxyNavigation";
import { CtrlProxyKeyboard } from "../../../src/features/observe/ios/CtrlProxyKeyboard";
import { CtrlProxyGestures } from "../../../src/features/observe/ios/CtrlProxyGestures";
import { ActionableError, type BootedDevice } from "../../../src/models";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { createIosDelegateHarness } from "../../helpers/iosDelegateHarness";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeWindow } from "../../fakes/FakeWindow";

const device: BootedDevice = { deviceId: "physical-iphone", platform: "ios", name: "iPhone" };
const fingers = [
  {
    finger: 0,
    points: [
      { x: 10, y: 20 },
      { x: 10, y: 80 },
    ],
  },
  {
    finger: 1,
    points: [
      { x: 30, y: 20 },
      { x: 30, y: 80 },
    ],
  },
];

async function flushDispatch(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

test("recentApps execute preserves indeterminate cancellation before post-action observation", async () => {
  const h = createIosDelegateHarness();
  const navigation = new CtrlProxyNavigation(h.context);
  const controller = new AbortController();
  const client = Object.assign(new FakeIOSCtrlProxy(h.timer), {
    requestRecentApps: navigation.requestRecentApps.bind(navigation),
  });
  const clientSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
    client as unknown as IOSCtrlProxyClient,
  );
  const observe = new FakeObserveScreen();
  observe.setObserveResult({ timestamp: h.timer.now() });
  const observeSpy = spyOn(observe, "execute").mockImplementation(async (options) => {
    options?.signal?.throwIfAborted();
    return { timestamp: h.timer.now() };
  });
  const recentApps = new RecentApps(device, null, h.timer);
  recentApps.observeScreen = observe;
  recentApps.window = new FakeWindow();
  try {
    const outcome = recentApps.execute(undefined, controller.signal).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
    }
    expect(h.sentMessages).toHaveLength(1);
    controller.abort(new ActionableError("caller cancelled"));
    const result = await outcome;
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(String(result.error)).toContain("outcome is indeterminate");
      expect(String(result.error)).toContain(
        "Do not retry automatically. Observe before retrying.",
      );
    }
    expect(observeSpy).toHaveBeenCalledTimes(1);
    expect(h.requestManager.getPendingCount()).toBe(0);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  } finally {
    clientSpy.mockRestore();
    observeSpy.mockRestore();
  }
});

for (const action of [
  "back",
  "recent",
  "volume_up",
  "volume_down",
  "power",
  "home",
  "input/key",
  "multi-finger swipe",
  "recentApps tool",
] as const) {
  describe(`iOS ${action} caller`, () => {
    test.each([
      "success",
      "timeout",
      "socket close",
      "abort before",
      "abort after",
      "ActionableError abort after",
      "failure reply",
      "runner_busy",
      "connect failure",
    ] as const)("%s preserves the dispatch contract", async (scenario) => {
      const h = createIosDelegateHarness();
      const navigation = new CtrlProxyNavigation(h.context);
      const keyboard = new CtrlProxyKeyboard(h.context);
      const gestures = new CtrlProxyGestures(h.context);
      const client = Object.assign(new FakeIOSCtrlProxy(h.timer), {
        requestPressHome: navigation.requestPressHome.bind(navigation),
        requestPressBack: navigation.requestPressBack.bind(navigation),
        requestRecentApps: navigation.requestRecentApps.bind(navigation),
        requestPressButton: navigation.requestPressButton.bind(navigation),
        requestPressKey: keyboard.requestPressKey.bind(keyboard),
        requestMultiFingerSwipe: gestures.requestMultiFingerSwipe.bind(gestures),
      });
      const spy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        client as unknown as IOSCtrlProxyClient,
      );
      const controller = new AbortController();
      const cancellation = new ActionableError("caller cancelled");
      let dispatchCount = 0;
      if (scenario === "abort before") {
        h.context.ensureConnected = async () => {
          controller.abort(cancellation);
          return true;
        };
      }
      if (scenario === "connect failure") {
        h.context.ensureConnected = async () => {
          throw new Error("connect failed");
        };
      }
      try {
        const pending =
          action === "recentApps tool"
            ? new RecentApps(device, null, h.timer)["executeIosRecentApps"](controller.signal)
            : action === "input/key"
              ? new InputKey(
                  device,
                  new FakeAdbClientFactory(),
                  undefined,
                  h.timer,
                  () => client,
                ).press("enter", 50, undefined, [], {
                  signal: controller.signal,
                  onDispatch: () => dispatchCount++,
                })
              : action === "multi-finger swipe"
                ? new ExecuteGesture(device, null, h.timer).execute(fingers, 300, controller.signal)
                : new PressButton(device, null, h.timer).press(
                    action,
                    50,
                    undefined,
                    controller.signal,
                  );
        const outcome = pending.then(
          (value) => ({ value }),
          (error) => ({ error: error as unknown }),
        );
        await flushDispatch();
        if (scenario === "success" || scenario === "failure reply") {
          h.resolveLast({
            success: scenario === "success",
            totalTimeMs: 7,
            error: scenario === "failure reply" ? "runner refused" : undefined,
            verified: true,
            warning: "runner warning",
          });
        }
        if (scenario === "runner_busy") {
          h.requestManager.reject(
            h.lastRequestId()!,
            new ActionableError("runner_busy: retry shortly"),
          );
        }
        if (scenario === "socket close") {
          h.requestManager.cancelAll(new Error("WebSocket connection closed"));
        }
        if (scenario === "abort after" || scenario === "ActionableError abort after") {
          controller.abort(
            scenario === "abort after" ? new Error("caller cancelled") : cancellation,
          );
        }
        h.advanceTime(11000);
        const result = await outcome;
        const unconfirmed = [
          "timeout",
          "socket close",
          "abort after",
          "ActionableError abort after",
        ].includes(scenario);
        if (
          scenario === "abort before" ||
          (action === "home" && scenario.includes("abort after"))
        ) {
          expect("error" in result).toBe(true);
          if ("error" in result) {
            expect(String(result.error)).toContain(
              action === "multi-finger swipe" || action === "recentApps tool"
                ? "caller cancelled"
                : "Operation cancelled",
            );
          }
        } else if (unconfirmed && action !== "home") {
          const message = "error" in result ? String(result.error) : String(result.value.error);
          expect(message).toContain("outcome is indeterminate");
          expect(message).toContain("Do not retry automatically.");
          if (action !== "input/key") {
            expect(message).toContain("Observe before retrying.");
          }
        } else if (scenario === "success") {
          expect("value" in result).toBe(true);
          if ("value" in result && action === "input/key") {
            expect(result.value).toMatchObject({
              success: true,
              key: "enter",
              keyCode: "enter",
              verified: true,
              warning: "runner warning",
            });
          }
          if ("value" in result && action === "multi-finger swipe") {
            expect(result.value).toEqual({ pathLength: 2, duration: 300, platform: "ios" });
          }
          if ("value" in result && action === "recentApps tool") {
            expect(result.value).toEqual({ success: true, method: "ios_swipe", error: undefined });
          }
          if (
            "value" in result &&
            action !== "input/key" &&
            action !== "multi-finger swipe" &&
            action !== "recentApps tool"
          ) {
            expect(result.value).toEqual({ success: true, button: action, keyCode: -1 });
          }
        } else {
          const message = "error" in result ? String(result.error) : String(result.value.error);
          expect(message).not.toContain("indeterminate");
          expect(message).toContain(
            scenario === "runner_busy"
              ? "runner_busy"
              : scenario === "failure reply"
                ? "runner refused"
                : scenario === "connect failure"
                  ? "connect failed"
                  : scenario === "socket close"
                    ? "WebSocket connection closed"
                    : "timed out",
          );
        }
        expect(h.sentMessages).toHaveLength(
          ["abort before", "connect failure"].includes(scenario) ? 0 : 1,
        );
        if (action === "input/key") {
          expect(dispatchCount).toBe(
            ["abort before", "connect failure"].includes(scenario) ? 0 : 1,
          );
        }
        expect(h.requestManager.getPendingCount()).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });
  });
}
