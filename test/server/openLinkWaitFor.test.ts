import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type {
  BootedDevice,
  Element,
  ObserveResult,
  OpenURLResult,
  TapOnElementResult,
} from "../../src/models";
import {
  acceptIosAppOpenAlert,
  buildOpenLinkPayload,
  isIosAppOpenAlert,
  openLinkSchema,
  registerInteractionTools,
  selectAndroidOpenLinkChooser,
  resetTapOnElementFactory,
  setTapOnElementFactory,
} from "../../src/server/interactionTools";
import { DeepLinkManager } from "../../src/utils/DeepLinkManager";
import { OpenURL } from "../../src/features/action/OpenURL";
import { HandleIntentChooser } from "../../src/features/action/HandleIntentChooser";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { displayInventoryOutcome } from "../../src/models/DeviceInfo";
import { RealObserveScreen } from "../../src/features/observe/ObserveScreen";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";

const makeObservation = (marker: string): ObserveResult => ({
  updatedAt: 0,
  screenSize: { width: 200, height: 200 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  activeWindow: { appId: "com.example.app", activityName: marker, layoutSeqSum: 0 },
});

test("registered openLink retries a multi-panel first observation without hierarchy", async () => {
  const device: BootedDevice = {
    platform: "ios",
    deviceId: "fake-duo",
    name: "iPhone Duo",
    [displayInventoryOutcome]: { kind: "multi" },
  };
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const screen = new FakeObserveScreen();
  screen.setObserveSequence([
    {
      ...makeObservation("locked"),
      display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
    },
    {
      ...makeObservation("closed"),
      display: { key: "cover", role: "cover", posture: "closed", generation: 0 },
    },
  ]);
  const openSpy = spyOn(OpenURL.prototype, "execute").mockResolvedValue({
    success: true,
    url: "example://item",
  });
  const observeSpy = spyOn(RealObserveScreen.prototype, "execute").mockImplementation((options) =>
    screen.execute(options),
  );
  const sleepSpy = spyOn(defaultTimer, "sleep").mockImplementation((ms) => timer.sleep(ms));
  const nowSpy = spyOn(defaultTimer, "now").mockImplementation(() => timer.now());
  try {
    registerInteractionTools();
    const handler = ToolRegistry.getTool("openLink")?.deviceAwareHandler;
    expect(handler).toBeDefined();
    const result = await handler!(device, {
      url: "example://item",
      waitFor: { posture: "closed", timeout: 200 },
    });
    expect(result).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining('"awaitTimeout":false') }],
    });
    expect(screen.getExecuteCallCount()).toBe(2);
  } finally {
    openSpy.mockRestore();
    observeSpy.mockRestore();
    sleepSpy.mockRestore();
    nowSpy.mockRestore();
    ToolRegistry.clearTools();
  }
});

test("registered openLink waits for a known lone panel after a stub activeDisplay stamp", async () => {
  const device: BootedDevice = {
    platform: "ios",
    deviceId: "fake-duo",
    name: "iPhone Duo",
    [displayInventoryOutcome]: { kind: "single" },
    displays: {
      panels: [{ key: "main", role: "inner", sizePx: { width: 200, height: 200 } }],
      postures: [],
    },
  };
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const screen = new FakeObserveScreen();
  screen.setObserveSequence([
    {
      ...makeObservation("locked"),
      display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
    },
    {
      ...makeObservation("closed"),
      display: { key: "main", role: "inner", posture: "unknown", generation: 0 },
    },
  ]);
  const openSpy = spyOn(OpenURL.prototype, "execute").mockResolvedValue({
    success: true,
    url: "example://item",
  });
  const observeSpy = spyOn(RealObserveScreen.prototype, "execute").mockImplementation((options) =>
    screen.execute(options),
  );
  const sleepSpy = spyOn(defaultTimer, "sleep").mockImplementation((ms) => timer.sleep(ms));
  const nowSpy = spyOn(defaultTimer, "now").mockImplementation(() => timer.now());
  try {
    registerInteractionTools();
    const handler = ToolRegistry.getTool("openLink")?.deviceAwareHandler;
    expect(handler).toBeDefined();
    const result = await handler!(device, {
      url: "example://item",
      waitFor: { activeDisplay: "main", timeout: 200 },
    });
    expect(result).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining('"awaitTimeout":false') }],
    });
    expect(screen.getExecuteCallCount()).toBe(2);
  } finally {
    openSpy.mockRestore();
    observeSpy.mockRestore();
    sleepSpy.mockRestore();
    nowSpy.mockRestore();
    ToolRegistry.clearTools();
  }
});

const appOpenAlertObservation = {
  ...makeObservation("system-alert"),
  viewHierarchy: {
    hierarchy: {
      text: 'Open in "Slack Debug"?',
      node: [{ text: "Cancel" }, { text: "Open", clickable: true }],
    },
  },
} as unknown as ObserveResult;
const noAlertHierarchy = {
  hierarchy: { text: "Home" },
} as unknown as NonNullable<ObserveResult["viewHierarchy"]>;

describe("openLinkSchema waitFor / settled", () => {
  test("accepts exact Android chooser package selection in the public tool", () => {
    expect(
      openLinkSchema.parse({
        platform: "android",
        url: "example://item",
        chooserAppPackage: "com.example.app",
      }).chooserAppPackage,
    ).toBe("com.example.app");
  });
  test("accepts opt-in iOS app-open alert handling", () => {
    const parsed = openLinkSchema.parse({
      platform: "ios",
      url: "slack://open",
      acceptOpenAlert: true,
    });
    expect(parsed.acceptOpenAlert).toBe(true);
  });

  test("accepts openLink with an integrated waitFor predicate", () => {
    const parsed = openLinkSchema.parse({
      platform: "ios",
      url: "slack://open",
      waitFor: {
        activeWindow: { appId: "com.tinyspeck.chatlyio" },
        elementId: "home_tab_bar",
        timeout: 25000,
      },
    });
    expect(parsed.waitFor).toMatchObject({
      activeWindow: { appId: "com.tinyspeck.chatlyio" },
      elementId: "home_tab_bar",
    });
  });

  test("accepts openLink with waitFor and settled together", () => {
    const parsed = openLinkSchema.parse({
      platform: "android",
      url: "myapp://home",
      waitFor: { elementId: "home_tab_bar", timeout: 25000 },
      settled: { quietPeriodMs: 500 },
    });
    expect(parsed.settled).toEqual({ quietPeriodMs: 500 });
  });

  test("accepts a plain openLink with no waitFor (unchanged behavior)", () => {
    const parsed = openLinkSchema.parse({
      platform: "android",
      url: "https://example.com",
    });
    expect(parsed.url).toBe("https://example.com");
    expect(parsed.waitFor).toBeUndefined();
  });

  test("rejects settled without waitFor", () => {
    expect(
      openLinkSchema.safeParse({
        platform: "android",
        url: "myapp://home",
        settled: { quietPeriodMs: 500 },
      }).success,
    ).toBe(false);
  });
});

test("openLink chooser path passes the exact package to the handler and surfaces its observation", async () => {
  const device = {
    platform: "android",
    deviceId: "emulator-5554",
    name: "Android",
  } as BootedDevice;
  const calls: unknown[][] = [];
  const chosen = {
    ...makeObservation("selected-app"),
    viewHierarchy: { hierarchy: {}, packageName: "com.example.app", updatedAt: 200 },
  } as ObserveResult;
  const result = await selectAndroidOpenLinkChooser(
    device,
    "com.example.app",
    { success: true, url: "example://item" },
    "example://item",
    {
      execute: async (...args) => {
        calls.push(args);
        return {
          success: true,
          detected: true,
          action: "custom",
          packageVerified: false,
          tappedAt: 199,
          observation: chosen,
        };
      },
    },
  );
  expect(calls).toEqual([["custom", "com.example.app", "example://item"]]);
  expect(result.observation).toBe(chosen);
  expect(result.success).toBe(true);
});

test("registered openLink probes the chooser with the normalized opened URL", async () => {
  const device = { platform: "android", deviceId: "fake", name: "Android" } as BootedDevice;
  const rawUrl = "  example://item  ";
  const chooserCalls: unknown[][] = [];
  const openSpy = spyOn(OpenURL.prototype, "execute").mockImplementation(async (url) => ({
    success: true,
    url: url.trim(),
  }));
  const chooserSpy = spyOn(HandleIntentChooser.prototype, "execute").mockImplementation(
    async (...args) => {
      chooserCalls.push(args);
      return { success: true, detected: true, packageVerified: true };
    },
  );
  try {
    registerInteractionTools();
    const handler = ToolRegistry.getTool("openLink")?.deviceAwareHandler;
    expect(handler).toBeDefined();
    await handler!(device, {
      platform: "android",
      url: rawUrl,
      chooserAppPackage: "com.example.app",
    });

    expect(openSpy).toHaveBeenCalledWith(rawUrl);
    expect(chooserCalls).toEqual([["custom", "com.example.app", "example://item"]]);
  } finally {
    openSpy.mockRestore();
    chooserSpy.mockRestore();
    ToolRegistry.clearTools();
  }
});

test("openLink accepts a device-seconds chooser capture in the tap's coarse second", async () => {
  const device = { platform: "android", deviceId: "fake", name: "Android" } as BootedDevice;
  const adb = new FakeAdbExecutor();
  adb.setDeviceTimestampMs(1000);
  adb.setDeviceTimestampSource("device-seconds");
  const chooser = {
    updatedAt: 100,
    hierarchy: {
      node: {
        class: "com.android.internal.app.ChooserActivity",
        node: [
          {
            "resource-id": "android:id/resolver_list",
            node: [
              {
                clickable: true,
                bounds: { left: 0, top: 100, right: 100, bottom: 140 },
                node: [{ text: "Example" }],
              },
            ],
          },
        ],
      },
    },
  };
  const manager = new DeepLinkManager(device, adb, null, null, undefined, undefined, {
    getLabel: async () => "Example",
    getFreshHierarchy: async (_device, _factory, floor) =>
      (floor < 2000
        ? { ...chooser, updatedAt: floor }
        : { hierarchy: { node: {} }, packageName: "com.example.app", updatedAt: 1000 }) as any,
  });
  const selection = await manager.handleIntentChooser(chooser as any, "custom", "com.example.app");
  expect(selection.success).toBe(true);
  const observation = {
    ...makeObservation("selected-app"),
    viewHierarchy: { hierarchy: {}, packageName: "com.example.app", updatedAt: 1000 },
  } as ObserveResult;
  const result = await selectAndroidOpenLinkChooser(
    device,
    "com.example.app",
    { success: true, url: "example://item" },
    "example://item",
    { execute: async () => ({ ...selection, observation }) },
  );
  expect(selection.tappedAt).toBe(1000);
  expect(result.success).toBe(true);
  expect(result.observation).toBe(observation);
});

test("openLink accepts an exact-package chooser tap without post-tap confirmation", async () => {
  const device = { platform: "android", deviceId: "fake", name: "Android" } as BootedDevice;
  const result = await selectAndroidOpenLinkChooser(
    device,
    "com.example.app",
    { success: true, url: "example://item" },
    "example://item",
    { execute: async () => ({ success: true, detected: true, packageVerified: true }) },
  );
  expect(result.success).toBe(true);
});

test("openLink rejects a pre-tap cached label-only chooser observation", async () => {
  const device = { platform: "android", deviceId: "fake", name: "Android" } as BootedDevice;
  const stale = {
    ...makeObservation("chooser"),
    viewHierarchy: { hierarchy: {}, packageName: "com.example.app", updatedAt: 100 },
  } as ObserveResult;
  const result = await selectAndroidOpenLinkChooser(
    device,
    "com.example.app",
    { success: true, url: "example://item" },
    "example://item",
    {
      execute: async () => ({
        success: true,
        detected: true,
        packageVerified: false,
        tappedAt: 101,
        observation: stale,
      }),
    },
  );
  expect(result.success).toBe(false);
  expect(result.error).toContain("post-tap hierarchy is stale");
});

test("openLink chooser path reports an expected chooser that never appeared", async () => {
  const device = {
    platform: "android",
    deviceId: "emulator-5554",
    name: "Android",
  } as BootedDevice;
  const result = await selectAndroidOpenLinkChooser(
    device,
    "com.example.app",
    { success: true, url: "example://item" },
    "example://item",
    { execute: async () => ({ success: true, detected: false }) },
  );
  expect(result.success).toBe(false);
  expect(result.error).toContain("com.example.app");
});

describe("openLink iOS app-open alert acceptance", () => {
  const iosDevice = {
    name: "iPhone",
    platform: "ios",
    deviceId: "ABCDEF01-1234-1234-1234-1234567890AB",
  } as BootedDevice;

  afterEach(() => {
    resetTapOnElementFactory();
  });

  test("recognizes only an Open button inside an Open in app confirmation", () => {
    expect(isIosAppOpenAlert(appOpenAlertObservation)).toBe(true);
    expect(
      isIosAppOpenAlert({
        ...makeObservation("ordinary"),
        viewHierarchy: {
          hierarchy: { text: "Open channel", node: [{ text: "Open" }] },
        },
      } as unknown as ObserveResult),
    ).toBe(false);
  });

  test("taps Open through the normal hierarchy-driven action", async () => {
    const options: unknown[] = [];
    setTapOnElementFactory(() => ({
      execute: async (received) => {
        options.push(received);
        return {
          success: true,
          action: "tap",
          element: { bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
          observation: makeObservation("slack"),
        } as TapOnElementResult;
      },
    }));

    const result = await acceptIosAppOpenAlert(iosDevice, appOpenAlertObservation);

    expect(result?.success).toBe(true);
    expect(options).toEqual([{ text: "Open", action: "tap" }]);
  });

  test("forces a current hierarchy when the open-time observation is stale", async () => {
    let refreshCalls = 0;
    let tapCalls = 0;
    setTapOnElementFactory(() => ({
      execute: async () => {
        tapCalls += 1;
        return {
          success: true,
          action: "tap",
          element: { bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
        } as TapOnElementResult;
      },
    }));

    const result = await acceptIosAppOpenAlert(
      iosDevice,
      makeObservation("stale-welcome"),
      undefined,
      undefined,
      async () => {
        refreshCalls += 1;
        return refreshCalls === 1
          ? (appOpenAlertObservation.viewHierarchy ?? null)
          : noAlertHierarchy;
      },
    );

    expect(result?.success).toBe(true);
    expect(refreshCalls).toBe(2);
    expect(tapCalls).toBe(1);
  });

  test("falls back to the live SpringBoard button when snapshots omit the alert", async () => {
    let systemTapCalls = 0;

    const result = await acceptIosAppOpenAlert(
      iosDevice,
      makeObservation("stale-welcome"),
      undefined,
      undefined,
      undefined,
      async () => {
        systemTapCalls += 1;
        return { success: true };
      },
    );

    expect(result?.success).toBe(true);
    expect(result?.element.text).toBe("Open");
    expect(systemTapCalls).toBe(1);
  });

  test("retries the live button when the dialog remains after a successful tap", async () => {
    let refreshCalls = 0;
    let systemTapCalls = 0;
    setTapOnElementFactory(() => ({
      execute: async () =>
        ({
          success: true,
          action: "tap",
          element: { text: "Open", bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
        }) as TapOnElementResult,
    }));

    const result = await acceptIosAppOpenAlert(
      iosDevice,
      appOpenAlertObservation,
      undefined,
      undefined,
      async () => {
        refreshCalls += 1;
        return refreshCalls === 1
          ? (appOpenAlertObservation.viewHierarchy ?? null)
          : noAlertHierarchy;
      },
      async () => {
        systemTapCalls += 1;
        return { success: true };
      },
    );

    expect(result?.success).toBe(true);
    expect(refreshCalls).toBe(2);
    expect(systemTapCalls).toBe(1);
  });

  test("rejects inconclusive verification snapshots after tapping", async () => {
    setTapOnElementFactory(() => ({
      execute: async () =>
        ({
          success: true,
          action: "tap",
          element: { text: "Open", bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
        }) as TapOnElementResult,
    }));

    await expect(
      acceptIosAppOpenAlert(
        iosDevice,
        appOpenAlertObservation,
        undefined,
        undefined,
        async () => null,
      ),
    ).rejects.toThrow("dialog remained visible");
  });

  test("uses the locale-independent live system action for localized alerts", async () => {
    let refreshCalls = 0;
    let systemTapCalls = 0;
    const localizedObservation = {
      ...makeObservation("localized-system-alert"),
      viewHierarchy: {
        packageName: "com.apple.springboard",
        hierarchy: {
          className: "UIAlertController",
          text: "In „Slack Debug“ öffnen?",
          node: [
            { className: "UIButton", role: "button", text: "Abbrechen" },
            { className: "UIButton", role: "button", text: "Öffnen", clickable: true },
          ],
        },
      },
    } as unknown as ObserveResult;

    const result = await acceptIosAppOpenAlert(
      iosDevice,
      localizedObservation,
      undefined,
      undefined,
      async () => {
        refreshCalls += 1;
        return refreshCalls === 1 ? (localizedObservation.viewHierarchy ?? null) : noAlertHierarchy;
      },
      async () => {
        systemTapCalls += 1;
        return { success: true };
      },
    );

    expect(result?.success).toBe(true);
    expect(refreshCalls).toBe(2);
    expect(systemTapCalls).toBe(1);
  });

  test("does not treat an unchanged localized dialog as verified dismissal", async () => {
    const localizedHierarchy = {
      packageName: "com.apple.springboard",
      hierarchy: {
        className: "UIActionSheet",
        node: [
          { className: "UIButton", role: "button", text: "Abbrechen" },
          { className: "UIButton", role: "button", text: "Öffnen" },
        ],
      },
    } as unknown as NonNullable<ObserveResult["viewHierarchy"]>;
    let refreshCalls = 0;

    await expect(
      acceptIosAppOpenAlert(
        iosDevice,
        {
          ...makeObservation("localized-system-sheet"),
          viewHierarchy: localizedHierarchy,
        },
        undefined,
        undefined,
        async () => {
          refreshCalls += 1;
          return localizedHierarchy;
        },
        async () => ({ success: true }),
      ),
    ).rejects.toThrow("dialog remained visible");
    expect(refreshCalls).toBe(5);
  });

  test("does nothing when the alert is absent", async () => {
    let calls = 0;
    setTapOnElementFactory(() => ({
      execute: async () => {
        calls += 1;
        throw new Error("must not tap");
      },
    }));

    const result = await acceptIosAppOpenAlert(iosDevice, makeObservation("home"));

    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  test("surfaces failure when the observed alert cannot be accepted", async () => {
    setTapOnElementFactory(() => ({
      execute: async () =>
        ({
          success: false,
          action: "tap",
          error: "Open was no longer hittable",
          element: { bounds: { left: 0, top: 0, right: 0, bottom: 0 } },
        }) as TapOnElementResult,
    }));

    await expect(acceptIosAppOpenAlert(iosDevice, appOpenAlertObservation)).rejects.toThrow(
      "Failed to accept iOS app-open alert: Open was no longer hittable",
    );
  });
});

describe("buildOpenLinkPayload", () => {
  const openResult: OpenURLResult = {
    success: true,
    url: "slack://open",
    observation: makeObservation("open"),
  };

  test("returns the plain open result when no wait occurred", () => {
    const payload = buildOpenLinkPayload("slack://open", openResult, null);
    expect(payload.observation).toBe(openResult.observation);
    expect("awaitTimeout" in payload).toBe(false);
    expect("awaitedElement" in payload).toBe(false);
    expect("timeoutReason" in payload).toBe(false);
    expect(payload).toEqual({ message: "Opened link slack://open", ...openResult });
  });

  test("failure message describes the open error", () => {
    const payload = buildOpenLinkPayload(
      "automobile://playground",
      { success: false, url: "automobile://playground", error: "no app handles this URL" },
      null,
    );
    expect(payload.message).toBe("Failed to open automobile://playground: no app handles this URL");
  });

  test("surfaces the timeout reason when the integrated posture wait times out", () => {
    const timeoutReason =
      'Timed out after 5000 ms waiting for posture "closed"; last observed posture "opened"';
    const payload = buildOpenLinkPayload("slack://open", openResult, {
      observation: makeObservation("opened"),
      awaitDuration: 5000,
      awaitTimeout: true,
      matched: false,
      timedOut: true,
      timeoutReason,
      polls: 3,
      waitMs: 5000,
      candidates: [],
    });
    expect(payload.timeoutReason).toBe(timeoutReason);
    expect(payload.timedOut).toBe(true);
  });

  test("surfaces the awaited observation and await fields when a wait occurred", () => {
    const awaited = makeObservation("home");
    const awaitedElement = { "resource-id": "home_tab_bar" } as unknown as Element;
    const payload = buildOpenLinkPayload("slack://open", openResult, {
      observation: awaited,
      awaitedElement,
      awaitDuration: 1200,
      awaitTimeout: false,
      matched: true,
      timedOut: false,
      polls: 2,
      waitMs: 1200,
      matchedElement: awaitedElement,
      candidates: [],
    });
    expect(payload.observation).toBe(awaited);
    expect(payload.awaitedElement).toBe(awaitedElement);
    expect(payload.awaitDuration).toBe(1200);
    expect(payload.awaitTimeout).toBe(false);
    expect(payload.matched).toBe(true);
    expect(payload.timedOut).toBe(false);
    expect(payload.polls).toBe(2);
    expect(payload.waitMs).toBe(1200);
    expect(payload.matchedElement).toBe(awaitedElement);
    expect(payload.candidates).toEqual([]);
  });
});
