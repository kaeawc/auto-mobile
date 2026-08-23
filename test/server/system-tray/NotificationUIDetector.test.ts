import { describe, it, expect, beforeEach } from "bun:test";
import { AndroidNotificationUIDetector } from "../../../src/server/system-tray/AndroidNotificationUIDetector";
import { IosNotificationUIDetector } from "../../../src/server/system-tray/IosNotificationUIDetector";
import { createNotificationUIDetector } from "../../../src/server/system-tray/createNotificationUIDetector";
import { FakeNotificationUIDetector } from "../../fakes/FakeNotificationUIDetector";
import { ActionableError } from "../../../src/models";
import type {
  BootedDevice,
  Element,
  ObserveResult,
  ViewHierarchyResult,
} from "../../../src/models";
import type { NotificationUIDetector } from "../../../src/utils/interfaces/NotificationUIDetector";
import type { SystemTrayDependencies } from "../../../src/server/systemTrayHelpers";
import { FakeTimer } from "../../fakes/FakeTimer";

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

  const observationWithSize: ObserveResult = {
    updatedAt: 0,
    screenSize: { width: 375, height: 812 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  };

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

  describe("IosNotificationUIDetector behavior", () => {
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
        requestTapCoordinates: async (x, y) => {
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
  });

  describe("createNotificationUIDetector factory", () => {
    const buildDeps = (): SystemTrayDependencies => ({
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

    it("returns an IosNotificationUIDetector for iOS devices", () => {
      const detector = createNotificationUIDetector(iosDevice, buildDeps);
      expect(detector).toBeInstanceOf(IosNotificationUIDetector);
      expect(detector.device).toBe(iosDevice);
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
