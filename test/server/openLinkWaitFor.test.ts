import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type {
  BootedDevice,
  Element,
  NodeAttributes,
  ObserveResult,
  OpenURLResult,
  TapOnElementResult,
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../src/models";
import {
  type InteractionToolDependencies,
  isIosAppOpenAlert,
  openLinkSchema,
  registerInteractionTools,
} from "../../src/server/interactionTools";
import {
  acceptIosAppOpenAlert,
  buildOpenLinkPayload,
  selectAndroidOpenLinkChooser,
} from "../../src/server/interactionToolHandlers";
import { DeepLinkManager } from "../../src/features/utility/DeepLinkManager";
import { OpenURL } from "../../src/features/action/OpenURL";
import { HandleIntentChooser } from "../../src/features/action/HandleIntentChooser";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { IosOpenAlertError } from "../../src/server/iosOpenAlert";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { displayInventoryOutcome } from "../../src/models/DeviceInfo";
import { RealObserveScreen } from "../../src/features/observe/ObserveScreen";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";

const interactionDeps: InteractionToolDependencies = {};
isolateToolRegistry();

const makeObservation = (marker: string): ObserveResult => ({
  observationId: `obs-${marker}`,
  display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
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
  const wait = spyOn(defaultTimer, "sleep").mockImplementation(async (ms) => timer.advanceTime(ms));
  const nowSpy = spyOn(defaultTimer, "now").mockImplementation(() => timer.now());
  try {
    registerInteractionTools(interactionDeps);
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
    wait.mockRestore();
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
    registerInteractionTools(interactionDeps);
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

/** A hierarchy node in the CtrlProxy shape: attributes under `$`, children under `node`. */
const treeNode = (attrs: NodeAttributes, children?: ViewHierarchyNode[]): ViewHierarchyNode => ({
  $: attrs,
  ...(children && { node: children }),
});
const treeOf = (root: ViewHierarchyNode, packageName?: string): ViewHierarchyResult => ({
  hierarchy: { node: root },
  ...(packageName && { packageName }),
});

const appOpenAlertObservation: ObserveResult = {
  ...makeObservation("system-alert"),
  viewHierarchy: treeOf(
    treeNode({ text: 'Open in "Slack Debug"?' }, [
      treeNode({ text: "Cancel" }),
      treeNode({ text: "Open", clickable: true }),
    ]),
  ),
};
const noAlertHierarchy = treeOf(treeNode({ text: "Home" }));

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
    registerInteractionTools(interactionDeps);
    const handler = ToolRegistry.getTool("openLink")?.deviceAwareHandler;
    expect(handler).toBeDefined();
    await handler!(device, {
      platform: "android",
      url: rawUrl,
      chooserAppPackage: "com.example.app",
    });

    expect(openSpy).toHaveBeenCalledWith(rawUrl, { signal: undefined });
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
  const chooser: ViewHierarchyResult = {
    updatedAt: 100,
    hierarchy: {
      node: treeNode({ class: "com.android.internal.app.ChooserActivity" }, [
        treeNode({ "resource-id": "android:id/resolver_list" }, [
          treeNode({ clickable: true, bounds: { left: 0, top: 100, right: 100, bottom: 140 } }, [
            treeNode({ text: "Example" }),
          ]),
        ]),
      ]),
    },
  };
  const manager = new DeepLinkManager(device, adb, {
    chooserMetadata: {
      getLabel: async () => "Example",
      getFreshHierarchy: async (_device, _factory, floor) =>
        floor < 2000
          ? { ...chooser, updatedAt: floor }
          : { hierarchy: { node: {} }, packageName: "com.example.app", updatedAt: 1000 },
    },
  });
  const selection = await manager.handleIntentChooser(chooser, "custom", "com.example.app");
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
    delete interactionDeps.tapOnElementFactory;
  });

  const autoTimer = (): FakeTimer => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    return timer;
  };

  const okTap =
    (taps: unknown[]): InteractionToolDependencies["tapOnElementFactory"] =>
    () => ({
      execute: async (received) => {
        taps.push(received);
        return {
          success: true,
          action: "tap",
          element: { bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
        } as TapOnElementResult;
      },
    });

  /** Serves `frames` in order, repeating the last one. */
  const framesOf = (frames: (ViewHierarchyResult | null)[]) => {
    let calls = 0;
    return {
      refresh: async () => frames[Math.min(calls++, frames.length - 1)] ?? null,
      calls: () => calls,
    };
  };

  test("waits for an alert that appears late, then accepts it", async () => {
    const timer = autoTimer();
    const taps: unknown[] = [];
    const frames = framesOf([
      noAlertHierarchy,
      noAlertHierarchy,
      noAlertHierarchy,
      appOpenAlertObservation.viewHierarchy ?? null,
      noAlertHierarchy,
    ]);

    const result = await acceptIosAppOpenAlert(
      iosDevice,
      makeObservation("home"),
      undefined,
      undefined,
      { tapOnElementFactory: okTap(taps), refreshHierarchy: frames.refresh, timer },
    );

    expect(result?.success).toBe(true);
    expect(taps).toEqual([{ text: "Open", action: "tap" }]);
    expect(timer.now()).toBeGreaterThanOrEqual(750);
  });

  test("gives up quietly once the bounded wait elapses without an alert", async () => {
    const timer = autoTimer();
    const frames = framesOf([noAlertHierarchy]);

    const result = await acceptIosAppOpenAlert(
      iosDevice,
      makeObservation("home"),
      undefined,
      undefined,
      { refreshHierarchy: frames.refresh, timer, waitTimeoutMs: 1000 },
    );

    expect(result).toBeNull();
    expect(frames.calls()).toBe(5);
    expect(timer.now()).toBe(1000);
  });

  test("honors a configured wait longer than the default window", async () => {
    const timer = autoTimer();
    const frames = framesOf([noAlertHierarchy]);

    await acceptIosAppOpenAlert(iosDevice, makeObservation("home"), undefined, undefined, {
      refreshHierarchy: frames.refresh,
      timer,
      waitTimeoutMs: 12_000,
    });

    expect(timer.now()).toBe(12_000);
  });

  test("taps the alert's last button by role when its label is not Open", async () => {
    const taps: unknown[] = [];
    const localized = treeOf(
      treeNode({ className: "UIAlertController", text: "In „Slack Debug“ öffnen?" }, [
        treeNode({ className: "UIButton", role: "button", text: "Abbrechen" }),
        treeNode({ className: "UIButton", role: "button", text: "Öffnen" }),
      ]),
      "com.apple.springboard",
    );

    const result = await acceptIosAppOpenAlert(
      iosDevice,
      { ...makeObservation("de"), viewHierarchy: localized },
      undefined,
      undefined,
      { tapOnElementFactory: okTap(taps) },
    );

    expect(result?.success).toBe(true);
    expect(taps).toEqual([{ text: "Öffnen", action: "tap" }]);
  });

  test("resolves a SpringBoard-only dialog with no prompt text by its button identifier", async () => {
    const taps: unknown[] = [];
    const springboardOnly = treeOf(
      treeNode({ className: "XCUIElementTypeAlert" }, [
        treeNode({ className: "UIButton", "resource-id": "cancel-action" }),
        treeNode({ className: "UIButton", "resource-id": "default-action" }),
      ]),
      "com.apple.springboard",
    );

    await acceptIosAppOpenAlert(
      iosDevice,
      { ...makeObservation("sb"), viewHierarchy: springboardOnly },
      undefined,
      undefined,
      { tapOnElementFactory: okTap(taps) },
    );

    expect(taps).toEqual([{ elementId: "default-action", action: "tap" }]);
  });

  test("finds the buttons when the prompt label is a sibling of them", async () => {
    const taps: unknown[] = [];
    const sibling = treeOf(
      treeNode({ className: "UIView" }, [
        treeNode({ text: 'Open in "Slack Debug"?' }),
        treeNode({ className: "UIButton", text: "Cancel" }),
        treeNode({ className: "UIButton", text: "Open" }),
      ]),
    );

    await acceptIosAppOpenAlert(
      iosDevice,
      { ...makeObservation("sib"), viewHierarchy: sibling },
      undefined,
      undefined,
      { tapOnElementFactory: okTap(taps) },
    );

    expect(taps).toEqual([{ text: "Open", action: "tap" }]);
  });

  test("keeps polling while the dismissal animation outlasts one verify check", async () => {
    const timer = autoTimer();
    const alert = appOpenAlertObservation.viewHierarchy ?? null;
    const frames = framesOf([alert, alert, alert, alert, noAlertHierarchy]);

    const result = await acceptIosAppOpenAlert(
      iosDevice,
      makeObservation("home"),
      undefined,
      undefined,
      { tapOnElementFactory: okTap([]), refreshHierarchy: frames.refresh, timer },
    );

    expect(result?.success).toBe(true);
    expect(frames.calls()).toBe(5);
  });

  test("reports the verify phase and the button candidates when the dialog never leaves", async () => {
    const alert = appOpenAlertObservation.viewHierarchy ?? null;
    const frames = framesOf([alert]);

    const failure = await acceptIosAppOpenAlert(
      iosDevice,
      makeObservation("home"),
      undefined,
      undefined,
      {
        tapOnElementFactory: okTap([]),
        refreshHierarchy: frames.refresh,
        timer: autoTimer(),
        verifyTimeoutMs: 500,
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IosOpenAlertError);
    expect((failure as IosOpenAlertError).phase).toBe("verify");
    expect((failure as IosOpenAlertError).candidates).toEqual(["Open"]);
  });

  test("reports the detect phase when the alert offers no accept button", async () => {
    const unbuttoned = treeOf(treeNode({ text: 'Open in "Slack"?' }, [treeNode({ text: "Open" })]));
    interactionDeps.tapOnElementFactory = () => ({
      execute: async () =>
        ({
          success: false,
          action: "tap",
          error: "Element not found with provided text 'Open'",
          element: { bounds: { left: 0, top: 0, right: 0, bottom: 0 } },
        }) as TapOnElementResult,
    });

    const failure = await acceptIosAppOpenAlert(
      iosDevice,
      { ...makeObservation("nobutton"), viewHierarchy: unbuttoned },
      undefined,
      undefined,
      { tapOnElementFactory: interactionDeps.tapOnElementFactory },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IosOpenAlertError);
    expect((failure as IosOpenAlertError).phase).toBe("detect");
    expect((failure as Error).message).toContain("offers no accept button");
  });

  test("falls back to the live system tap when the selected button cannot be tapped", async () => {
    interactionDeps.tapOnElementFactory = () => ({
      execute: async () =>
        ({
          success: false,
          action: "tap",
          error: "not hittable",
          element: { bounds: { left: 0, top: 0, right: 0, bottom: 0 } },
        }) as TapOnElementResult,
    });
    let liveTaps = 0;

    const result = await acceptIosAppOpenAlert(
      iosDevice,
      appOpenAlertObservation,
      undefined,
      undefined,
      {
        tapOnElementFactory: interactionDeps.tapOnElementFactory,
        // The first live tap (during the wait) misses; the post-failure one lands.
        tapSystemAlert: async () => ({ success: ++liveTaps > 1 }),
        timer: autoTimer(),
      },
    );

    expect(result?.success).toBe(true);
    expect(liveTaps).toBe(2);
  });

  test("recognizes only an Open button inside an Open in app confirmation", () => {
    expect(isIosAppOpenAlert(appOpenAlertObservation)).toBe(true);
    expect(
      isIosAppOpenAlert({
        ...makeObservation("ordinary"),
        viewHierarchy: treeOf(treeNode({ text: "Open channel" }, [treeNode({ text: "Open" })])),
      }),
    ).toBe(false);
  });

  test("taps Open through the normal hierarchy-driven action", async () => {
    const options: unknown[] = [];
    interactionDeps.tapOnElementFactory = () => ({
      execute: async (received) => {
        options.push(received);
        return {
          success: true,
          action: "tap",
          element: { bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
          observation: makeObservation("slack"),
        } as TapOnElementResult;
      },
    });

    const result = await acceptIosAppOpenAlert(
      iosDevice,
      appOpenAlertObservation,
      undefined,
      undefined,
      { tapOnElementFactory: interactionDeps.tapOnElementFactory },
    );

    expect(result?.success).toBe(true);
    expect(options).toEqual([{ text: "Open", action: "tap" }]);
  });

  test("forces a current hierarchy when the open-time observation is stale", async () => {
    let refreshCalls = 0;
    let tapCalls = 0;
    interactionDeps.tapOnElementFactory = () => ({
      execute: async () => {
        tapCalls += 1;
        return {
          success: true,
          action: "tap",
          element: { bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
        } as TapOnElementResult;
      },
    });

    const result = await acceptIosAppOpenAlert(
      iosDevice,
      makeObservation("stale-welcome"),
      undefined,
      undefined,
      {
        tapOnElementFactory: interactionDeps.tapOnElementFactory,
        timer: autoTimer(),
        refreshHierarchy: async () => {
          refreshCalls += 1;
          return refreshCalls === 1
            ? (appOpenAlertObservation.viewHierarchy ?? null)
            : noAlertHierarchy;
        },
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
      {
        tapOnElementFactory: interactionDeps.tapOnElementFactory,
        tapSystemAlert: async () => {
          systemTapCalls += 1;
          return { success: true };
        },
      },
    );

    expect(result?.success).toBe(true);
    expect(result?.element.text).toBe("Open");
    expect(systemTapCalls).toBe(1);
  });

  test("retries the live button when the dialog remains after a successful tap", async () => {
    let refreshCalls = 0;
    let systemTapCalls = 0;
    interactionDeps.tapOnElementFactory = () => ({
      execute: async () =>
        ({
          success: true,
          action: "tap",
          element: { text: "Open", bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
        }) as TapOnElementResult,
    });

    const result = await acceptIosAppOpenAlert(
      iosDevice,
      appOpenAlertObservation,
      undefined,
      undefined,
      {
        tapOnElementFactory: interactionDeps.tapOnElementFactory,
        timer: autoTimer(),
        refreshHierarchy: async () => {
          refreshCalls += 1;
          return refreshCalls === 1
            ? (appOpenAlertObservation.viewHierarchy ?? null)
            : noAlertHierarchy;
        },
        tapSystemAlert: async () => {
          systemTapCalls += 1;
          return { success: true };
        },
      },
    );

    expect(result?.success).toBe(true);
    expect(refreshCalls).toBe(2);
    expect(systemTapCalls).toBe(1);
  });

  test("rejects inconclusive verification snapshots after tapping", async () => {
    interactionDeps.tapOnElementFactory = () => ({
      execute: async () =>
        ({
          success: true,
          action: "tap",
          element: { text: "Open", bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
        }) as TapOnElementResult,
    });

    await expect(
      acceptIosAppOpenAlert(iosDevice, appOpenAlertObservation, undefined, undefined, {
        tapOnElementFactory: interactionDeps.tapOnElementFactory,
        timer: autoTimer(),
        refreshHierarchy: async () => null,
      }),
    ).rejects.toThrow("dialog remained visible");
  });

  test("uses the locale-independent live system action for localized alerts", async () => {
    let refreshCalls = 0;
    let systemTapCalls = 0;
    const localizedObservation: ObserveResult = {
      ...makeObservation("localized-system-alert"),
      viewHierarchy: treeOf(
        treeNode({ className: "UIAlertController", text: "In „Slack Debug“ öffnen?" }, [
          treeNode({ className: "UIButton", role: "button", text: "Abbrechen" }),
          treeNode({ className: "UIButton", role: "button", text: "Öffnen", clickable: true }),
        ]),
        "com.apple.springboard",
      ),
    };

    const result = await acceptIosAppOpenAlert(
      iosDevice,
      localizedObservation,
      undefined,
      undefined,
      {
        tapOnElementFactory: interactionDeps.tapOnElementFactory,
        timer: autoTimer(),
        refreshHierarchy: async () => {
          refreshCalls += 1;
          return refreshCalls === 1
            ? (localizedObservation.viewHierarchy ?? null)
            : noAlertHierarchy;
        },
        tapSystemAlert: async () => {
          systemTapCalls += 1;
          return { success: true };
        },
      },
    );

    expect(result?.success).toBe(true);
    expect(refreshCalls).toBe(2);
    expect(systemTapCalls).toBe(1);
  });

  test("does not treat an unchanged localized dialog as verified dismissal", async () => {
    const localizedHierarchy = treeOf(
      treeNode({ className: "UIActionSheet" }, [
        treeNode({ className: "UIButton", role: "button", text: "Abbrechen" }),
        treeNode({ className: "UIButton", role: "button", text: "Öffnen" }),
      ]),
      "com.apple.springboard",
    );
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
        {
          tapOnElementFactory: interactionDeps.tapOnElementFactory,
          timer: autoTimer(),
          refreshHierarchy: async () => {
            refreshCalls += 1;
            return localizedHierarchy;
          },
          tapSystemAlert: async () => ({ success: true }),
          verifyTimeoutMs: 1000,
        },
      ),
    ).rejects.toThrow("dialog remained visible");
    expect(refreshCalls).toBe(6);
  });

  test("does nothing when the alert is absent", async () => {
    let calls = 0;
    interactionDeps.tapOnElementFactory = () => ({
      execute: async () => {
        calls += 1;
        throw new Error("must not tap");
      },
    });

    const result = await acceptIosAppOpenAlert(
      iosDevice,
      makeObservation("home"),
      undefined,
      undefined,
      { tapOnElementFactory: interactionDeps.tapOnElementFactory },
    );

    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  test("surfaces failure when the observed alert cannot be accepted", async () => {
    interactionDeps.tapOnElementFactory = () => ({
      execute: async () =>
        ({
          success: false,
          action: "tap",
          error: "Open was no longer hittable",
          element: { bounds: { left: 0, top: 0, right: 0, bottom: 0 } },
        }) as TapOnElementResult,
    });

    await expect(
      acceptIosAppOpenAlert(iosDevice, appOpenAlertObservation, undefined, undefined, {
        tapOnElementFactory: interactionDeps.tapOnElementFactory,
      }),
    ).rejects.toThrow("Failed to accept iOS app-open alert: Open was no longer hittable");
  });
});

/** Narrows the payload union to the wait-carrying shape, failing when no wait fields are present. */
function waitedPayload(payload: ReturnType<typeof buildOpenLinkPayload>) {
  if (!("polls" in payload)) {
    throw new Error(`payload carries no wait outcome: ${JSON.stringify(payload)}`);
  }
  return payload;
}

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
    expect<unknown>(payload).toEqual({ message: "Opened link slack://open", ...openResult });
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
    const payload = waitedPayload(
      buildOpenLinkPayload("slack://open", openResult, {
        observation: makeObservation("opened"),
        awaitDuration: 5000,
        awaitTimeout: true,
        matched: false,
        timedOut: true,
        timeoutReason,
        polls: 3,
        waitMs: 5000,
        candidates: [],
      }),
    );
    expect(payload.timeoutReason).toBe(timeoutReason);
    expect(payload.timedOut).toBe(true);
  });

  test("surfaces the awaited observation and await fields when a wait occurred", () => {
    const awaited = makeObservation("home");
    const awaitedElement: Element = {
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      "resource-id": "home_tab_bar",
    };
    const payload = waitedPayload(
      buildOpenLinkPayload("slack://open", openResult, {
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
      }),
    );
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
