import { buildObserveResult } from "../../helpers/observeFixture";
import type { TapCoordinatesRequest } from "../../../src/features/observe/shared/SharedGestureDelegate";
import { describe, it, expect, beforeEach } from "bun:test";
import { AndroidNotificationUIDetector } from "../../../src/features/systemTray/AndroidNotificationUIDetector";
import {
  IosNotificationUIDetector,
  type IosGestureResult,
} from "../../../src/features/systemTray/IosNotificationUIDetector";
import { createNotificationUIDetector } from "../../../src/features/systemTray/createNotificationUIDetector";
import { FakeNotificationUIDetector } from "../../fakes/FakeNotificationUIDetector";
import { ActionableError } from "../../../src/models";
import type {
  BootedDevice,
  Element,
  ObserveResult,
  ViewHierarchyResult,
} from "../../../src/models";
import type { NotificationUIDetector } from "../../../src/utils/interfaces/NotificationUIDetector";
import type { SystemTrayDependencies } from "../../../src/features/systemTray/systemTrayHelpers";
import { FakeTimer } from "../../fakes/FakeTimer";
import { readFileSync } from "node:fs";
import { wireCapture } from "../../helpers/wireCapture";
import { convertIosHierarchy } from "../../helpers/iosHierarchyConverter";
import { springBoardPhotosIcon } from "../../fixtures/observe/iosSpringBoardIcon";
import settings from "../../fixtures/ios/ctrlproxy-golden/settings-tap-general/0002-push-hierarchy_update.json";
import { IOS_NOTIFICATION_CENTER_CLASS_HINTS } from "../../../src/features/systemTray/notificationHints";
import { collectNotificationCandidates } from "../../../src/features/systemTray/systemTrayHelpers";
import {
  getSystemTrayDependencies,
  resetSystemTrayDependencies,
  setSystemTrayDependencies,
} from "../../../src/features/systemTray/helpers/dependencies";

/**
 * Conformance check for the platform-agnostic NotificationUIDetector
 * contract. Each subject is deliberately typed as the abstract interface
 * so a regression that drops one of the shared members surfaces here as
 * a compile error.
 */
describe("NotificationUIDetector", () => {
  const androidDevice: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Pixel 7",
    platform: "android",
  };
  const iosDevice: BootedDevice = {
    deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
    name: "iPhone 15",
    platform: "ios",
  };

  beforeEach(() => resetSystemTrayDependencies());

  const trayHierarchy: ViewHierarchyResult = {
    packageName: "com.android.systemui",
    hierarchy: {
      node: {
        $: {
          "resource-id": "com.android.systemui:id/notification_stack_scroller",
          class: "NotificationShade",
          packageName: "com.android.systemui",
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        },
      },
    },
  };

  const closedHierarchy: ViewHierarchyResult = {
    packageName: "com.google.android.apps.nexuslauncher",
    hierarchy: {
      node: {
        $: {
          "resource-id": "launcher_root",
          class: "Launcher",
          packageName: "com.google.android.apps.nexuslauncher",
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        },
      },
    },
  };

  const iosNotificationCenterHierarchy: ViewHierarchyResult = {
    packageName: "com.apple.springboard",
    hierarchy: {
      node: {
        $: {
          class: "NotificationCenter",
          bounds: { left: 0, top: 0, right: 375, bottom: 812 },
        },
      },
    },
  } as ViewHierarchyResult;

  const iosAppHierarchy: ViewHierarchyResult = {
    packageName: "com.example.app",
    hierarchy: {
      node: {
        $: {
          class: "RootView",
          bounds: { left: 0, top: 0, right: 375, bottom: 812 },
        },
      },
    },
  } as ViewHierarchyResult;

  const sampleElement: Element = {
    bounds: { left: 10, top: 20, right: 100, bottom: 80 },
    text: "Hello",
  } as Element;

  const observationWithSize: ObserveResult = buildObserveResult({
    updatedAt: 0,
    screenSize: { width: 375, height: 812 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  });

  describe("FakeNotificationUIDetector", () => {
    let fake: FakeNotificationUIDetector;

    beforeEach(() => {
      fake = new FakeNotificationUIDetector(androidDevice);
    });

    it("records each method invocation", async () => {
      fake.isTrayOpen(trayHierarchy);
      await fake.expandTray(observationWithSize);
      await fake.collapseTray(observationWithSize);
      await fake.getObservationTimestamp();
      await fake.tapElement(sampleElement);
      await fake.swipeElement(sampleElement);

      expect(fake.wasMethodCalled("isTrayOpen")).toBe(true);
      expect(fake.wasMethodCalled("expandTray")).toBe(true);
      expect(fake.wasMethodCalled("collapseTray")).toBe(true);
      expect(fake.wasMethodCalled("getObservationTimestamp")).toBe(true);
      expect(fake.wasMethodCalled("tapElement")).toBe(true);
      expect(fake.wasMethodCalled("swipeElement")).toBe(true);
    });

    it("returns configured stub values", async () => {
      fake.isTrayOpenResult = true;
      fake.observationTimestampResult = 1234;
      expect(fake.isTrayOpen(trayHierarchy)).toBe(true);
      expect(await fake.getObservationTimestamp()).toBe(1234);
    });

    it("counts invocations independently", async () => {
      await fake.getObservationTimestamp();
      await fake.getObservationTimestamp();
      await fake.getObservationTimestamp();
      expect(fake.getCallCount("getObservationTimestamp")).toBe(3);
    });

    it("clears recorded history on demand", () => {
      fake.isTrayOpen(trayHierarchy);
      fake.clearHistory();
      expect(fake.getExecutedOperations()).toEqual([]);
    });

    it("captures call arguments in the recorded operation string", async () => {
      await fake.tapElement(sampleElement);
      expect(fake.getExecutedOperations()).toContain("tapElement:10,20");
    });
  });

  // Three subjects all satisfy NotificationUIDetector — data-driven
  // conformance keeps each one honest without repeating the asserts.
  interface DetectorCase {
    name: string;
    build: () => NotificationUIDetector;
  }

  const cases: ReadonlyArray<DetectorCase> = [
    {
      name: "AndroidNotificationUIDetector",
      build: () =>
        new AndroidNotificationUIDetector(androidDevice, {
          executeAdbCommand: async () => ({ stdout: "", stderr: "" }),
          getDeviceTimestampMs: async () => 0,
        }),
    },
    {
      name: "IosNotificationUIDetector",
      build: () =>
        new IosNotificationUIDetector(iosDevice, {
          requestSwipe: async () => ({ success: true }),
          requestTapCoordinates: async () => ({ success: true }),
          now: () => 0,
        }),
    },
    {
      name: "FakeNotificationUIDetector",
      build: () => new FakeNotificationUIDetector(androidDevice),
    },
  ];

  for (const c of cases) {
    describe(c.name, () => {
      it("satisfies the NotificationUIDetector interface", () => {
        const detector: NotificationUIDetector = c.build();
        expect(typeof detector.isTrayOpen).toBe("function");
        expect(typeof detector.expandTray).toBe("function");
        expect(typeof detector.collapseTray).toBe("function");
        expect(typeof detector.getObservationTimestamp).toBe("function");
        expect(typeof detector.tapElement).toBe("function");
        expect(typeof detector.swipeElement).toBe("function");
        expect(detector.device).toBeDefined();
      });
    });
  }

  describe("AndroidNotificationUIDetector behavior", () => {
    it("detects an open notification shade", () => {
      const detector = new AndroidNotificationUIDetector(androidDevice, {
        executeAdbCommand: async () => ({ stdout: "", stderr: "" }),
        getDeviceTimestampMs: async () => 0,
      });
      expect(detector.isTrayOpen(trayHierarchy)).toBe(true);
      expect(detector.isTrayOpen(closedHierarchy)).toBe(false);
      expect(detector.isTrayOpen(undefined)).toBe(false);
    });

    it("expands and collapses via shell cmd statusbar", async () => {
      const commands: string[] = [];
      const detector = new AndroidNotificationUIDetector(androidDevice, {
        executeAdbCommand: async (cmd) => {
          commands.push(cmd);
          return { stdout: "", stderr: "" };
        },
        getDeviceTimestampMs: async () => 12345,
      });

      await detector.expandTray();
      await detector.collapseTray();
      expect(commands).toEqual([
        "shell cmd statusbar expand-notifications",
        "shell cmd statusbar collapse",
      ]);
    });

    it("returns ADB device timestamp", async () => {
      const detector = new AndroidNotificationUIDetector(androidDevice, {
        executeAdbCommand: async () => ({ stdout: "", stderr: "" }),
        getDeviceTimestampMs: async () => 4242,
      });
      expect(await detector.getObservationTimestamp()).toBe(4242);
    });

    it("issues shell input tap / swipe with element coordinates", async () => {
      const commands: string[] = [];
      const detector = new AndroidNotificationUIDetector(androidDevice, {
        executeAdbCommand: async (cmd) => {
          commands.push(cmd);
          return { stdout: "", stderr: "" };
        },
        getDeviceTimestampMs: async () => 0,
      });
      await detector.tapElement(sampleElement);
      await detector.swipeElement(sampleElement);
      // Full command strings pin the element centre (55,50) and the left-swipe
      // geometry (91,50 -> 19,50) + 300ms duration, so a corner-vs-centre bug
      // or swapped x/y is caught (#4183 R3/R13).
      expect(commands[0]).toBe("shell input tap 55 50");
      expect(commands[1]).toBe("shell input swipe 91 50 19 50 300");
    });

    it("wraps expand failures in ActionableError", async () => {
      const detector = new AndroidNotificationUIDetector(androidDevice, {
        executeAdbCommand: async () => {
          throw new Error("device offline");
        },
        getDeviceTimestampMs: async () => 0,
      });
      await expect(detector.expandTray()).rejects.toThrow(/Failed to expand system tray/);
    });

    it("wraps collapse failures in ActionableError", async () => {
      const detector = new AndroidNotificationUIDetector(androidDevice, {
        executeAdbCommand: async () => {
          throw new Error("device offline");
        },
        getDeviceTimestampMs: async () => 0,
      });
      // Collapse must surface as an ActionableError, not raw ADB noise (#4183 A6).
      await expect(detector.collapseTray()).rejects.toBeInstanceOf(ActionableError);
      await expect(detector.collapseTray()).rejects.toThrow(/Failed to collapse system tray/);
    });
  });

  // Already-converted ViewHierarchyResult from manual-test batch 20261019d,
  // evidence/i1-notification-center-hierarchy.json; do not reconvert compact bounds.
  const ios27NotificationCenterHierarchy = wireCapture(
    JSON.parse(
      readFileSync(
        new URL(
          "../../fixtures/ios-notification-center/ios27-notification-center-hierarchy.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );

  describe("IosNotificationUIDetector behavior", () => {
    // Closest captured home hierarchy: the Photos icon subtree from #8060/#8081.
    // ios-lock-state/observe-unlocked.json has no raw viewHierarchy.
    const capturedIosHomeIconHierarchy = convertIosHierarchy({
      packageName: "com.apple.springboard",
      updatedAt: 0,
      hierarchy: springBoardPhotosIcon,
    });
    const capturedIosSettingsHierarchy = convertIosHierarchy({
      hierarchy: settings.push.data.hierarchy,
      packageName: settings.push.data.packageName,
      updatedAt: settings.push.data.updatedAt,
    });
    const capturedDetector = new IosNotificationUIDetector(iosDevice, {
      requestSwipe: async () => ({ success: true }),
      requestTapCoordinates: async () => ({ success: true }),
      now: () => 0,
    });

    it("detects the captured empty iOS 27 Notification Center", () => {
      expect(capturedDetector.isTrayOpen(ios27NotificationCenterHierarchy)).toBe(true);
      // The captured ListCell is an empty list placeholder, not a notification.
      expect(collectNotificationCandidates(ios27NotificationCenterHierarchy)).toEqual([]);
    });

    it.each([
      ["SpringBoard home icon subtree", capturedIosHomeIconHierarchy],
      ["Settings app", capturedIosSettingsHierarchy],
      [
        "Settings hierarchy with SpringBoard fallback",
        {
          ...capturedIosSettingsHierarchy,
          packageName: "com.apple.springboard",
        },
      ],
      [
        "Notification Center structure in another package",
        {
          ...ios27NotificationCenterHierarchy,
          packageName: "com.example.app",
        },
      ],
    ] as const)("rejects %s", (_name, hierarchy) => {
      expect(capturedDetector.isTrayOpen(hierarchy)).toBe(false);
    });

    it.each(IOS_NOTIFICATION_CENTER_CLASS_HINTS)("preserves legacy %s detection", (hint) => {
      expect(
        capturedDetector.isTrayOpen({
          ...iosNotificationCenterHierarchy,
          hierarchy: { node: { $: { class: hint } } },
        }),
      ).toBe(true);
    });

    it("detects NotificationCenter only under SpringBoard", () => {
      const detector = new IosNotificationUIDetector(iosDevice, {
        requestSwipe: async () => ({ success: true }),
        requestTapCoordinates: async () => ({ success: true }),
        now: () => 0,
      });
      expect(detector.isTrayOpen(iosNotificationCenterHierarchy)).toBe(true);
      expect(detector.isTrayOpen(iosAppHierarchy)).toBe(false);
      expect(detector.isTrayOpen(undefined)).toBe(false);
    });

    it("emits a downward swipe to open NotificationCenter", async () => {
      const swipes: Array<{ x1: number; y1: number; x2: number; y2: number; duration?: number }> =
        [];
      const detector = new IosNotificationUIDetector(iosDevice, {
        requestSwipe: async (x1, y1, x2, y2, duration) => {
          swipes.push({ x1, y1, x2, y2, duration });
          return { success: true };
        },
        requestTapCoordinates: async () => ({ success: true }),
        now: () => 0,
      });
      await detector.expandTray(observationWithSize);
      expect(swipes.length).toBe(1);
      expect(swipes[0].y1).toBe(5);
      expect(swipes[0].y2).toBeGreaterThan(swipes[0].y1);
    });

    it("emits an upward swipe to close NotificationCenter", async () => {
      const swipes: Array<{ x1: number; y1: number; x2: number; y2: number; duration?: number }> =
        [];
      const detector = new IosNotificationUIDetector(iosDevice, {
        requestSwipe: async (x1, y1, x2, y2, duration) => {
          swipes.push({ x1, y1, x2, y2, duration });
          return { success: true };
        },
        requestTapCoordinates: async () => ({ success: true }),
        now: () => 0,
      });
      await detector.collapseTray(observationWithSize);
      expect(swipes.length).toBe(1);
      expect(swipes[0].y1).toBeGreaterThan(swipes[0].y2);
    });

    it.each([
      ["cover sheet", ios27NotificationCenterHierarchy, 1, 0],
      ["legacy Notification Center", iosNotificationCenterHierarchy, 0, 1],
    ] as const)(
      "closes %s with the appropriate action",
      async (_name, hierarchy, homes, swipes) => {
        let homeCalls = 0;
        let swipeCalls = 0;
        const deps = {
          pressHome: async () => {
            homeCalls++;
            return { success: true };
          },
          requestSwipe: async () => {
            swipeCalls++;
            return { success: true };
          },
          requestTapCoordinates: async () => ({ success: true }),
          now: () => 0,
        };
        await new IosNotificationUIDetector(iosDevice, deps).collapseTray({
          ...observationWithSize,
          viewHierarchy: hierarchy,
        });
        expect(homeCalls).toBe(homes);
        expect(swipeCalls).toBe(swipes);
      },
    );

    it("closes the cover sheet without screen dimensions", async () => {
      let homeCalls = 0;
      const deps = {
        pressHome: async () => {
          homeCalls++;
          return { success: true };
        },
        requestSwipe: async () => {
          throw new Error("Cover-sheet close must not swipe");
        },
        requestTapCoordinates: async () => ({ success: true }),
        now: () => 0,
      };
      const observation = {
        ...observationWithSize,
        viewHierarchy: ios27NotificationCenterHierarchy,
      };
      Reflect.deleteProperty(observation, "screenSize");
      await new IosNotificationUIDetector(iosDevice, deps).collapseTray(observation);
      expect(homeCalls).toBe(1);
    });

    it("rejects cover-sheet close when home press is unavailable", async () => {
      await expect(
        capturedDetector.collapseTray({
          ...observationWithSize,
          viewHierarchy: ios27NotificationCenterHierarchy,
        }),
      ).rejects.toThrow("Failed to close Notification Center: home press unavailable");
    });

    it.each([
      [
        { success: false, error: "Runner refused", dispatched: true, acknowledged: true },
        "Failed to close Notification Center: Runner refused",
      ],
      [
        { success: false, error: "Home timed out", dispatched: true, acknowledged: false },
        "Outcome of close Notification Center is indeterminate",
      ],
      [
        { success: false, error: "Press failed" },
        "Failed to close Notification Center: Press failed",
      ],
    ] satisfies Array<[IosGestureResult, string]>)(
      "handles home result %j",
      async (result, message) => {
        const deps = {
          pressHome: async () => result,
          requestSwipe: async () => ({ success: true }),
          requestTapCoordinates: async () => ({ success: true }),
          now: () => 0,
        };
        await expect(
          new IosNotificationUIDetector(iosDevice, deps).collapseTray({
            ...observationWithSize,
            viewHierarchy: ios27NotificationCenterHierarchy,
          }),
        ).rejects.toThrow(message);
      },
    );

    it("rejects expand/collapse without screen dimensions", async () => {
      const detector = new IosNotificationUIDetector(iosDevice, {
        requestSwipe: async () => ({ success: true }),
        requestTapCoordinates: async () => ({ success: true }),
        now: () => 0,
      });
      await expect(detector.expandTray()).rejects.toThrow(/Screen dimensions/);
      await expect(detector.collapseTray()).rejects.toThrow(/Screen dimensions/);
    });

    it("returns host timer timestamp", async () => {
      const detector = new IosNotificationUIDetector(iosDevice, {
        requestSwipe: async () => ({ success: true }),
        requestTapCoordinates: async () => ({ success: true }),
        now: () => 9999,
      });
      expect(await detector.getObservationTimestamp()).toBe(9999);
    });

    it("taps via CtrlProxy client coordinates", async () => {
      const taps: Array<{ x: number; y: number }> = [];
      const detector = new IosNotificationUIDetector(iosDevice, {
        requestSwipe: async () => ({ success: true }),
        requestTapCoordinates: async (request: TapCoordinatesRequest) => {
          const { x, y } = request;

          taps.push({ x, y });
          return { success: true };
        },
        now: () => 0,
      });
      await detector.tapElement(sampleElement);
      expect(taps.length).toBe(1);
      // Pin the exact centre coordinates so a corner-tap or swapped x/y regresses
      // here (#4183 R13).
      expect(taps[0]).toEqual({ x: 55, y: 50 });
    });

    describe("gesture dispatch contract", () => {
      const unconfirmed = {
        success: false,
        error: "Swipe timed out after 5000ms",
        dispatched: true,
        acknowledged: false,
      };
      const gestures: Array<{
        name: string;
        run: (detector: IosNotificationUIDetector) => Promise<void>;
        label: string;
      }> = [
        {
          name: "dismissing a notification",
          label: "dismiss notification",
          run: (detector) => detector.swipeElement(sampleElement),
        },
        {
          name: "tapping a notification",
          label: "tap notification",
          run: (detector) => detector.tapElement(sampleElement),
        },
        {
          name: "opening Notification Center",
          label: "open Notification Center",
          run: (detector) => detector.expandTray(observationWithSize),
        },
        {
          name: "closing Notification Center",
          label: "close Notification Center",
          run: (detector) => detector.collapseTray(observationWithSize),
        },
      ];
      const detectorReturning = (result: {
        success: boolean;
        error?: string;
        dispatched?: boolean;
        acknowledged?: boolean;
      }) =>
        new IosNotificationUIDetector(iosDevice, {
          requestSwipe: async () => result,
          requestTapCoordinates: async () => result,
          now: () => 0,
        });

      for (const gesture of gestures) {
        it(`${gesture.name} sent without a reply is indeterminate`, async () => {
          const error = await gesture.run(detectorReturning(unconfirmed)).catch((e: unknown) => e);

          expect(error).toBeInstanceOf(ActionableError);
          const message = (error as Error).message;
          expect(message).toContain(`Outcome of ${gesture.label} is indeterminate`);
          expect(message).toContain("Swipe timed out after 5000ms");
          expect(message).toContain("Do not retry automatically");
          expect(message).not.toContain("Failed to");
        });

        it(`${gesture.name} refused by the runner stays a plain failure`, async () => {
          await expect(
            gesture.run(
              detectorReturning({
                success: false,
                error: "Runner refused",
                dispatched: true,
                acknowledged: true,
              }),
            ),
          ).rejects.toThrow(`Failed to ${gesture.label}: Runner refused`);
        });

        it(`${gesture.name} never sent stays a plain failure`, async () => {
          await expect(
            gesture.run(
              detectorReturning({
                success: false,
                error: "Not connected",
                dispatched: false,
                acknowledged: false,
              }),
            ),
          ).rejects.toThrow(`Failed to ${gesture.label}: Not connected`);
        });
      }

      it("a result without dispatch markers stays a plain failure", async () => {
        await expect(
          detectorReturning({ success: false, error: "boom" }).swipeElement(sampleElement),
        ).rejects.toThrow("Failed to dismiss notification: boom");
      });
    });
  });

  describe("createNotificationUIDetector factory", () => {
    const buildDeps = (): SystemTrayDependencies => ({
      appInventoryFactory: () => ({
        executeDetailedResult: async () => ({
          successful: true,
          apps: { profiles: {}, system: [] },
        }),
      }),
      appLabelResolver: async () => null,
      observeScreenFactory: () => ({ execute: async () => ({}) as ObserveResult }),
      adbFactory: () => ({
        executeCommand: async () => ({ stdout: "", stderr: "" }),
        getDeviceTimestampMs: async () => 0,
      }),
      iosClientFactory: () => ({
        requestSwipe: async () => ({ success: true }),
        requestTapCoordinates: async () => ({ success: true }),
      }),
      timer: new FakeTimer(),
    });

    it("returns an AndroidNotificationUIDetector for Android devices", () => {
      const detector = createNotificationUIDetector(androidDevice, buildDeps);
      expect(detector).toBeInstanceOf(AndroidNotificationUIDetector);
      expect(detector.device).toBe(androidDevice);
    });
    it("passes cancellation through to Android shade commands", async () => {
      const controller = new AbortController();
      let commandSignal: AbortSignal | undefined;
      const deps = buildDeps();
      deps.adbFactory = () => ({
        getDeviceTimestampMs: async () => 0,
        executeCommand: async (_command, options) => {
          commandSignal = options?.signal;
          return { stdout: "", stderr: "" };
        },
      });
      await createNotificationUIDetector(
        androidDevice,
        () => deps,
        controller.signal,
      ).collapseTray();
      expect(commandSignal).toBe(controller.signal);
    });

    it("returns an IosNotificationUIDetector for iOS devices", () => {
      const detector = createNotificationUIDetector(iosDevice, buildDeps);
      expect(detector).toBeInstanceOf(IosNotificationUIDetector);
      expect(detector.device).toBe(iosDevice);
    });

    it("wires cover-sheet HOME to the factory with the device and signal", async () => {
      const controller = new AbortController();
      const calls: Array<{ device: BootedDevice; signal?: AbortSignal }> = [];
      const deps = {
        ...buildDeps(),
        iosClientFactory: undefined,
        pressHomeFactory: async (device: BootedDevice, signal?: AbortSignal) => {
          calls.push({ device, signal });
          return { success: true };
        },
      };
      await createNotificationUIDetector(iosDevice, () => deps, controller.signal).collapseTray({
        ...observationWithSize,
        viewHierarchy: ios27NotificationCenterHierarchy,
      });
      expect(calls).toEqual([{ device: iosDevice, signal: controller.signal }]);
    });

    it("keeps the iOS client's dispatch markers so an unanswered dismiss swipe is indeterminate", async () => {
      const deps = (): SystemTrayDependencies => ({
        ...buildDeps(),
        iosClientFactory: () => ({
          requestSwipe: async () => ({
            success: false,
            error: "Swipe timed out after 5000ms",
            dispatched: true,
            acknowledged: false,
          }),
          requestTapCoordinates: async () => ({ success: true }),
        }),
      });
      const detector = createNotificationUIDetector(iosDevice, deps);
      await expect(detector.swipeElement(sampleElement)).rejects.toThrow(
        "Outcome of dismiss notification is indeterminate",
      );
    });

    it("maps the production home press result to an indeterminate actionable error", async () => {
      setSystemTrayDependencies({
        pressButtonFactory: () => ({
          execute: async () => ({
            success: false,
            button: "home",
            keyCode: -1,
            code: "indeterminate_outcome",
            error: "Button press outcome is indeterminate: no result was confirmed",
          }),
        }),
      });
      const observation = {
        ...observationWithSize,
        viewHierarchy: ios27NotificationCenterHierarchy,
      };
      const detector = createNotificationUIDetector(iosDevice, getSystemTrayDependencies);
      const collapse = detector.collapseTray(observation);
      await expect(collapse).rejects.toBeInstanceOf(ActionableError);
      await expect(collapse).rejects.toThrow(
        "Outcome of close Notification Center is indeterminate",
      );
    });

    it("keeps a plain production home press failure as a plain actionable error", async () => {
      setSystemTrayDependencies({
        pressButtonFactory: () => ({
          execute: async () => ({
            success: false,
            button: "home",
            keyCode: -1,
            code: "press_failed",
            error: "Home refused",
          }),
        }),
      });
      const detector = createNotificationUIDetector(iosDevice, getSystemTrayDependencies);
      await expect(
        detector.collapseTray({
          ...observationWithSize,
          viewHierarchy: ios27NotificationCenterHierarchy,
        }),
      ).rejects.toThrow("Failed to close Notification Center: Home refused");
    });

    it("throws when iOS client factory is missing", async () => {
      const deps = (): SystemTrayDependencies => ({
        ...buildDeps(),
        iosClientFactory: undefined,
      });
      const detector = createNotificationUIDetector(iosDevice, deps);
      await expect(detector.tapElement(sampleElement)).rejects.toThrow(/iOS CtrlProxy/);
    });
  });
});
