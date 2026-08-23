import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { ObserveResult } from "../../../src/models/ObserveResult";
import { BootedDevice } from "../../../src/models/DeviceInfo";
import { logger } from "../../../src/utils/logger";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";

describe("ObserveScreen", function () {
  describe("Unit Tests for Extracted Methods", function () {
    let observeScreen: RealObserveScreen;
    let fakeAdb: FakeAdbExecutor;
    let mockDevice: BootedDevice;

    beforeAll(function () {
      RealObserveScreen.clearCache();
      mockDevice = {
        deviceId: "test-device",
        name: "Test Device",
        platform: "android",
      };
      fakeAdb = new FakeAdbExecutor();
      observeScreen = new RealObserveScreen(mockDevice, new FakeAdbClientFactory(fakeAdb));
    });

    test("should create base result with correct structure", function () {
      const result = observeScreen.createBaseResult();

      expect(result).toHaveProperty("updatedAt");
      expect(result).toHaveProperty("screenSize");
      expect(result).toHaveProperty("systemInsets");

      expect(typeof result.updatedAt).toBe("string");
      expect(result.screenSize).toEqual({ width: 0, height: 0 });
      expect(result.systemInsets).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    });

    test("stamps updatedAt from the injected clock, not the wall clock", function () {
      const timer = new FakeTimer();
      timer.setCurrentTime(Date.parse("2023-06-15T12:00:00.000Z"));
      const pinnedObserveScreen = new RealObserveScreen(
        mockDevice,
        new FakeAdbClientFactory(fakeAdb),
        undefined,
        timer,
      );

      const result = pinnedObserveScreen.createBaseResult();

      expect(result.updatedAt).toBe("2023-06-15T12:00:00.000Z");
    });

    test("should append error message to empty error field", function () {
      const result: ObserveResult = {
        updatedAt: "2023-01-01T00:00:00.000Z",
        screenSize: { width: 0, height: 0 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      };

      observeScreen.appendError(result, "Test error");

      expect(result.error).toBe("Test error");
    });

    test("should append error message to existing error field", function () {
      const result: ObserveResult = {
        updatedAt: "2023-01-01T00:00:00.000Z",
        screenSize: { width: 0, height: 0 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        error: "Existing error",
      };

      observeScreen.appendError(result, "New error");

      expect(result.error).toBe("Existing error; New error");
    });

    // The join rules (semicolon separator, empty-message handling, N-way
    // accumulation) are exercised directly in ObserveError.test.ts. appendError
    // is only a thin delegate, so these two tests pin the delegation itself
    // (empty -> set, existing -> joined) and the rest were removed (issue #4172 D9).

    test("should populate observable element lists", async function () {
      const viewHierarchy = new FakeViewHierarchy();
      viewHierarchy.configureHierarchy({
        updatedAt: 123,
        screenWidth: 1080,
        screenHeight: 1920,
        systemInsets: { top: 24, right: 0, bottom: 48, left: 0 },
        wakefulness: "Awake",
        hierarchy: {
          node: {
            bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
            node: [
              {
                "resource-id": "com.example:id/action",
                bounds: { left: 900, top: 1700, right: 1020, bottom: 1820 },
                actions: ["click"],
              },
              {
                text: "Ready",
                bounds: { left: 0, top: 100, right: 200, bottom: 160 },
              },
            ],
          },
        },
      } as any);

      try {
        const screen = new RealObserveScreen(mockDevice, new FakeAdbClientFactory(fakeAdb), {
          viewHierarchy,
          cacheStore: new FakeObserveCacheStore(new FakeTimer()),
          performanceAuditor: { run: async () => undefined } as any,
          accessibilityAuditor: { run: async () => undefined } as any,
          accessibilityStateDetector: { run: async () => undefined } as any,
        });

        const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

        expect(result.elements?.clickable).toHaveLength(1);
        expect(result.elements?.clickable[0]["resource-id"]).toBe("com.example:id/action");
        expect(result.elements?.text).toHaveLength(1);
        expect(result.elements?.text[0].text).toBe("Ready");
      } finally {
        resetObserveCacheStore();
      }
    });

    test("should populate iOS heuristic screen identity from the view hierarchy", async function () {
      const viewHierarchy = new FakeViewHierarchy();
      viewHierarchy.configureHierarchy({
        packageName: "com.apple.reminders",
        updatedAt: 123,
        screenScale: 3,
        screenWidth: 402,
        screenHeight: 874,
        systemInsets: { top: 59, right: 0, bottom: 34, left: 0 },
        hierarchy: {
          node: {
            $: { class: "XCUIApplication" },
            node: [
              {
                $: { class: "UINavigationBar", text: "New Reminder" },
                node: [{ $: { class: "_UINavigationBarTitleControl", text: "New Reminder" } }],
              },
              {
                $: {
                  class: "UITextField",
                  text: "Title",
                  "resource-id": "Quick Entry Title Field",
                  focused: "true",
                },
              },
            ],
          },
        },
      } as any);

      try {
        const screen = new RealObserveScreen(
          { deviceId: "ios-test-device", name: "iPhone", platform: "ios" },
          new FakeAdbClientFactory(fakeAdb),
          {
            viewHierarchy,
            cacheStore: new FakeObserveCacheStore(new FakeTimer()),
            performanceAuditor: { run: async () => undefined } as any,
            accessibilityAuditor: { run: async () => undefined } as any,
            accessibilityStateDetector: { run: async () => undefined } as any,
          },
        );

        const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

        expect(result.screenIdentity?.platform).toBe("ios");
        expect(result.screenIdentity?.source).toBe("heuristic");
        expect(result.screenIdentity?.confidence).toBe("high");
        expect(result.screenIdentity?.components.bundleId).toBe("com.apple.reminders");
        expect(result.screenIdentity?.components.navigationTitle).toBe("New Reminder");
        expect(result.screenIdentity?.components.focusedElementId).toBe("Quick Entry Title Field");
        expect(result.systemInsets).toEqual({ top: 59, right: 0, bottom: 34, left: 0 });
      } finally {
        resetObserveCacheStore();
      }
    });

    test("prefers an SDK-backed iOS screen identity for the observed bundle", async function () {
      const viewHierarchy = new FakeViewHierarchy();
      viewHierarchy.configureHierarchy({
        packageName: "dev.jasonpearson.automobile.Playground",
        updatedAt: 123,
        screenScale: 3,
        screenWidth: 402,
        screenHeight: 874,
        hierarchy: { node: { $: { class: "XCUIApplication" } } },
      } as any);
      viewHierarchy.configureScreenIdentity({
        platform: "ios",
        source: "sdk",
        confidence: "high",
        key: '[["bundle","dev.jasonpearson.automobile.Playground"],["route","SettingsTab"]]',
        components: {
          bundleId: "dev.jasonpearson.automobile.Playground",
          navigationRoute: "SettingsTab",
        },
      });

      try {
        const screen = new RealObserveScreen(
          { deviceId: "ios-test-device", name: "iPhone", platform: "ios" },
          new FakeAdbClientFactory(fakeAdb),
          {
            viewHierarchy,
            cacheStore: new FakeObserveCacheStore(new FakeTimer()),
            performanceAuditor: { run: async () => undefined } as any,
            accessibilityAuditor: { run: async () => undefined } as any,
            accessibilityStateDetector: { run: async () => undefined } as any,
          },
        );

        const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

        expect(result.screenIdentity).toMatchObject({
          source: "sdk",
          confidence: "high",
          components: { navigationRoute: "SettingsTab" },
        });
      } finally {
        resetObserveCacheStore();
      }
    });

    test("prefers a live iOS modal boundary over a cached SDK route", async function () {
      const viewHierarchy = new FakeViewHierarchy();
      viewHierarchy.configureHierarchy({
        packageName: "dev.jasonpearson.automobile.Playground",
        screenScale: 3,
        screenWidth: 402,
        screenHeight: 874,
        hierarchy: {
          node: {
            $: { class: "XCUIApplication" },
            node: [
              {
                $: { class: "XCUIElementTypeAlert" },
                node: [{ $: { class: "XCUIElementTypeStaticText", text: "Allow Notifications?" } }],
              },
            ],
          },
        },
      } as any);
      viewHierarchy.configureScreenIdentity({
        platform: "ios",
        source: "sdk",
        confidence: "high",
        key: '["route","SettingsTab"]',
        components: { navigationRoute: "SettingsTab" },
      });

      try {
        const screen = new RealObserveScreen(
          { deviceId: "ios-test-device", name: "iPhone", platform: "ios" },
          new FakeAdbClientFactory(fakeAdb),
          {
            viewHierarchy,
            cacheStore: new FakeObserveCacheStore(new FakeTimer()),
            performanceAuditor: { run: async () => undefined } as any,
            accessibilityAuditor: { run: async () => undefined } as any,
            accessibilityStateDetector: { run: async () => undefined } as any,
          },
        );

        const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

        expect(result.screenIdentity).toMatchObject({
          source: "heuristic",
          components: { modalClass: "XCUIElementTypeAlert", modalTitle: "Allow Notifications?" },
        });
      } finally {
        resetObserveCacheStore();
      }
    });

    test("falls back to a hierarchy identity when SDK identity refresh rejects", async function () {
      const viewHierarchy = new FakeViewHierarchy();
      viewHierarchy.configureHierarchy({
        packageName: "com.apple.reminders",
        screenWidth: 402,
        screenHeight: 874,
        hierarchy: {
          node: {
            $: { class: "XCUIApplication" },
            node: [{ $: { class: "UINavigationBar", text: "New Reminder" } }],
          },
        },
      } as any);
      viewHierarchy.getScreenIdentity = () => {
        throw new Error("SDK refresh unavailable");
      };

      try {
        const screen = new RealObserveScreen(
          { deviceId: "ios-test-device", name: "iPhone", platform: "ios" },
          new FakeAdbClientFactory(fakeAdb),
          {
            viewHierarchy,
            cacheStore: new FakeObserveCacheStore(new FakeTimer()),
            performanceAuditor: { run: async () => undefined } as any,
            accessibilityAuditor: { run: async () => undefined } as any,
            accessibilityStateDetector: { run: async () => undefined } as any,
          },
        );

        const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

        expect(result.screenIdentity).toMatchObject({
          source: "heuristic",
          components: { bundleId: "com.apple.reminders", navigationTitle: "New Reminder" },
        });
      } finally {
        resetObserveCacheStore();
      }
    });

    test("does not return an SDK identity for a different observed bundle", async function () {
      const viewHierarchy = new FakeViewHierarchy();
      viewHierarchy.configureHierarchy({
        packageName: "com.apple.reminders",
        screenWidth: 402,
        screenHeight: 874,
        hierarchy: {
          node: {
            $: { class: "XCUIApplication" },
            node: [{ $: { class: "UINavigationBar", text: "New Reminder" } }],
          },
        },
      } as any);
      viewHierarchy.configureScreenIdentity({
        platform: "ios",
        source: "sdk",
        confidence: "high",
        key: '[["bundle","com.example.other"]]',
        components: { bundleId: "com.example.other" },
      });

      try {
        const screen = new RealObserveScreen(
          { deviceId: "ios-test-device", name: "iPhone", platform: "ios" },
          new FakeAdbClientFactory(fakeAdb),
          {
            viewHierarchy,
            cacheStore: new FakeObserveCacheStore(new FakeTimer()),
            performanceAuditor: { run: async () => undefined } as any,
            accessibilityAuditor: { run: async () => undefined } as any,
            accessibilityStateDetector: { run: async () => undefined } as any,
          },
        );

        const result = await screen.execute({ skipScreenshot: true, skipBackStack: true });

        expect(result.screenIdentity).toMatchObject({
          source: "heuristic",
          components: { bundleId: "com.apple.reminders", navigationTitle: "New Reminder" },
        });
      } finally {
        resetObserveCacheStore();
      }
    });
  });

  describe("Unit Tests for Focused Element Functionality", function () {
    let viewHierarchy: any;
    let mockDevice: BootedDevice;

    beforeAll(function () {
      mockDevice = {
        deviceId: "test-device",
        name: "Test Device",
        platform: "android",
      };
      const fakeAdb = new FakeAdbExecutor();
      const observeScreen = new RealObserveScreen(mockDevice, new FakeAdbClientFactory(fakeAdb));
      viewHierarchy = (observeScreen as any).viewHierarchy;
    });

    test("should detect focused element from view hierarchy", function () {
      const mockViewHierarchy = {
        hierarchy: {
          node: [
            {
              text: "Button 1",
              "resource-id": "com.example:id/button1",
              bounds: { left: 0, top: 0, right: 100, bottom: 50 },
              clickable: "true",
              focused: "false",
            },
            {
              text: "Input Field",
              "resource-id": "com.example:id/input",
              bounds: { left: 0, top: 60, right: 200, bottom: 100 },
              clickable: "true",
              focused: "true",
            },
            {
              text: "Button 2",
              "resource-id": "com.example:id/button2",
              bounds: { left: 0, top: 110, right: 100, bottom: 160 },
              clickable: "true",
              focused: "false",
            },
          ],
        },
      };

      const focusedElement = viewHierarchy.findFocusedElement(mockViewHierarchy);

      expect(focusedElement).not.toBeNull();
      expect(focusedElement!.text).toBe("Input Field");
      expect(focusedElement!["resource-id"]).toBe("com.example:id/input");
      expect(focusedElement!.focused).toBe(true);
    });

    test("should return null when no element is focused", function () {
      const mockViewHierarchy = {
        hierarchy: {
          node: [
            {
              text: "Button 1",
              "resource-id": "com.example:id/button1",
              bounds: { left: 0, top: 0, right: 100, bottom: 50 },
              clickable: "true",
              focused: "false",
            },
            {
              text: "Button 2",
              "resource-id": "com.example:id/button2",
              bounds: { left: 0, top: 110, right: 100, bottom: 160 },
              clickable: "true",
              focused: "false",
            },
          ],
        },
      };

      const focusedElement = viewHierarchy.findFocusedElement(mockViewHierarchy);

      expect(focusedElement).toBeNull();
    });

    test("should return null when view hierarchy is empty", function () {
      const emptyViewHierarchy = {
        hierarchy: null,
      };

      const focusedElement = viewHierarchy.findFocusedElement(emptyViewHierarchy);

      expect(focusedElement).toBeNull();
    });

    test("should find focused element in nested hierarchy", function () {
      const mockViewHierarchy = {
        hierarchy: {
          node: {
            text: "Container",
            "resource-id": "com.example:id/container",
            bounds: { left: 0, top: 0, right: 300, bottom: 200 },
            focused: "false",
            node: [
              {
                text: "Nested Button",
                "resource-id": "com.example:id/nested_button",
                bounds: { left: 10, top: 10, right: 90, bottom: 40 },
                clickable: "true",
                focused: "false",
              },
              {
                text: "Nested Input",
                "resource-id": "com.example:id/nested_input",
                bounds: { left: 10, top: 50, right: 200, bottom: 80 },
                clickable: "true",
                focused: "true",
              },
            ],
          },
        },
      };

      const focusedElement = viewHierarchy.findFocusedElement(mockViewHierarchy);

      expect(focusedElement).not.toBeNull();
      expect(focusedElement!.text).toBe("Nested Input");
      expect(focusedElement!["resource-id"]).toBe("com.example:id/nested_input");
      expect(focusedElement!.focused).toBe(true);
    });

    test("should handle boolean focused property", function () {
      const mockViewHierarchy = {
        hierarchy: {
          node: {
            text: "Button",
            "resource-id": "com.example:id/button",
            bounds: { left: 0, top: 0, right: 100, bottom: 50 },
            clickable: "true",
            focused: true, // Boolean instead of string
          },
        },
      };

      const focusedElement = viewHierarchy.findFocusedElement(mockViewHierarchy);

      expect(focusedElement).not.toBeNull();
      expect(focusedElement!.text).toBe("Button");
      expect(focusedElement!.focused).toBe(true);
    });

    test("should handle element with $ properties", function () {
      const mockViewHierarchy = {
        hierarchy: {
          node: {
            $: {
              text: "Button with $",
              "resource-id": "com.example:id/button_dollar",
              bounds: { left: 0, top: 0, right: 100, bottom: 50 },
              clickable: "true",
              focused: "true",
            },
          },
        },
      };

      const focusedElement = viewHierarchy.findFocusedElement(mockViewHierarchy);

      expect(focusedElement).not.toBeNull();
      expect(focusedElement!.text).toBe("Button with $");
      expect(focusedElement!["resource-id"]).toBe("com.example:id/button_dollar");
      expect(focusedElement!.focused).toBe(true);
    });
  });

  describe("Integration Tests", function () {
    let observeScreen: RealObserveScreen;
    let mockDevice: BootedDevice;

    beforeEach(async function () {
      // Clear cache before each test to prevent interference between tests
      RealObserveScreen.clearCache();

      // Skip integration tests by default - they require a real device
      // To run integration tests, set a real device ID
      mockDevice = null as any;
      return;
    });

    afterEach(async function () {
      // No cleanup needed since integration tests are skipped
    });

    test("should get complete observation data with all features enabled", async function () {
      if (!mockDevice) {
        return;
      } // Skip if no device available

      // Execute observe with all features enabled
      const result = await observeScreen.execute();

      // Verify it contains all the required data
      expect(result).toHaveProperty("updatedAt");
      expect(result).toHaveProperty("screenSize");
      expect(result.screenSize).toHaveProperty("width");
      expect(result.screenSize).toHaveProperty("height");
      expect(result.screenSize.width).toBeGreaterThan(0);
      expect(result.screenSize.height).toBeGreaterThan(0);

      expect(result).toHaveProperty("systemInsets");
      expect(result.systemInsets).toHaveProperty("top");
      expect(result.systemInsets).toHaveProperty("right");
      expect(result.systemInsets).toHaveProperty("bottom");
      expect(result.systemInsets).toHaveProperty("left");

      expect(result).toHaveProperty("viewHierarchy");
      expect(result.viewHierarchy).toHaveProperty("hierarchy");
      expect(result.viewHierarchy.hierarchy).not.toBeNull();

      expect(result).toHaveProperty("activeWindow");
      expect(result.activeWindow).toHaveProperty("appId");
      expect(typeof result.activeWindow!.appId).toBe("string");
      expect(result.activeWindow!.appId.length).toBeGreaterThan(0);
    });

    test("should detect and report screen size correctly", async function () {
      if (!mockDevice) {
        return;
      } // Skip if no device available

      const result = await observeScreen.execute();

      // Check screen size is reasonable
      const { width, height } = result.screenSize;
      expect(typeof width).toBe("number");
      expect(typeof height).toBe("number");
      expect(width).toBeGreaterThan(200); // Any reasonable device should be wider than 200px
      expect(height).toBeGreaterThan(300); // Any reasonable device should be taller than 300px

      logger.info(`Detected screen size: ${width}x${height}`);
    });

    test("should detect system insets correctly", async function () {
      if (!mockDevice) {
        return;
      } // Skip if no device available

      const result = await observeScreen.execute();

      // Check system insets are reasonable
      const { top, right, bottom, left } = result.systemInsets;
      expect(typeof top).toBe("number");
      expect(typeof right).toBe("number");
      expect(typeof bottom).toBe("number");
      expect(typeof left).toBe("number");

      // At least one inset should be non-zero on modern devices (status bar, navigation bar)
      expect(top > 0 || right > 0 || bottom > 0 || left > 0).toBe(true);

      logger.info(
        `Detected system insets: top=${top}, right=${right}, bottom=${bottom}, left=${left}`,
      );
    });

    test("should include active window information with the package name", async function () {
      if (!mockDevice) {
        return;
      } // Skip if no device available

      const result = await observeScreen.execute();

      expect(result).toHaveProperty("activeWindow");
      expect(result.activeWindow).toHaveProperty("appId");

      // Instead of expecting a specific package, just verify we get a valid package name
      expect(typeof result.activeWindow!.appId).toBe("string");
      expect(result.activeWindow!.appId.length).toBeGreaterThan(0);

      // Log the actual package for debugging but don't assert on it
      logger.info(`Active window package: ${result.activeWindow!.appId}`);
    });

    test("should execute observe command multiple times maintaining consistency", async function () {
      if (!mockDevice) {
        return;
      } // Skip if no device available

      // First observation
      const firstResult = await observeScreen.execute();

      // Second observation
      const secondResult = await observeScreen.execute();

      // Screen size should be consistent
      expect(secondResult.screenSize.width).toBe(firstResult.screenSize.width);
      expect(secondResult.screenSize.height).toBe(firstResult.screenSize.height);

      // Both should have activeWindow with valid package names
      expect(firstResult.activeWindow).toBeDefined();
      expect(secondResult.activeWindow).toBeDefined();
      if (firstResult.activeWindow && secondResult.activeWindow) {
        expect(typeof firstResult.activeWindow.appId).toBe("string");
        expect(firstResult.activeWindow.appId.length).toBeGreaterThan(0);
        expect(typeof secondResult.activeWindow.appId).toBe("string");
        expect(secondResult.activeWindow.appId.length).toBeGreaterThan(0);
      }

      // Both observations should have view hierarchy
      expect(firstResult.viewHierarchy).toBeDefined();
      expect(secondResult.viewHierarchy).toBeDefined();
    });

    test("should handle errors gracefully if device is disconnected", async function () {
      if (!mockDevice) {
        return;
      } // Skip if no device available

      // Check if there's only one device connected
      const devices = await adb.executeCommand("devices");
      const deviceLines = devices.stdout
        .split("\n")
        .filter((line) => line.trim() && !line.includes("List of devices"));
      if (deviceLines.length !== 1) {
        // Note: Bun does not support dynamic test skipping // Skip if multiple devices or no devices
        return;
      }

      // Create a new ObserveScreen with an invalid device ID
      const invalidDevice: BootedDevice = {
        deviceId: "invalid-device-id",
        name: "Invalid Device",
        platform: "android",
      };
      // Pass fakeAdb to avoid creating real AdbClient
      const invalidObserveScreen = new RealObserveScreen(
        invalidDevice,
        new FakeAdbClientFactory(fakeAdb),
      );

      // Should still return a result object with error info
      const result = await invalidObserveScreen.execute();

      expect(result).toHaveProperty("updatedAt");
      expect(result).toHaveProperty("screenSize");
      expect(result).toHaveProperty("systemInsets");
      expect(result).toHaveProperty("error");
      expect(typeof result.error).toBe("string");
    });

    test("should produce complete data that can be serialized to JSON", async function () {
      if (!mockDevice) {
        return;
      } // Skip if no device available

      const result = await observeScreen.execute();

      // Verify the entire result can be serialized to JSON
      const serialized = JSON.stringify(result);
      expect(typeof serialized).toBe("string");

      // Verify it can be parsed back
      const parsed = JSON.parse(serialized) as ObserveResult;
      expect(parsed).toHaveProperty("screenSize");
      expect(parsed.screenSize.width).toBe(result.screenSize.width);
      expect(parsed.screenSize.height).toBe(result.screenSize.height);
    });
  });

  describe("extractScreenSizeFromHierarchy", function () {
    let observeScreen: RealObserveScreen;

    beforeAll(function () {
      RealObserveScreen.clearCache();
      observeScreen = new RealObserveScreen(
        { deviceId: "test", name: "Test", platform: "android" },
        new FakeAdbClientFactory(new FakeAdbExecutor()),
      );
    });

    const extract = (viewHierarchy: any) =>
      (observeScreen as any).extractScreenSizeFromHierarchy(viewHierarchy);

    test("should extract from Android-style object bounds", function () {
      const result = extract({
        hierarchy: {
          node: { $: { bounds: { left: 0, top: 0, right: 1080, bottom: 2400 } } },
        },
      });
      expect(result).toEqual({ width: 1080, height: 2400 });
    });

    test("should extract from iOS-style bounds object", function () {
      const result = extract({
        hierarchy: {
          bounds: { left: 0, top: 0, right: 1032, bottom: 1376 },
          className: "XCUIApplication",
        },
      });
      expect(result).toEqual({ width: 1032, height: 1376 });
    });

    test("should handle iOS bounds with non-zero origin", function () {
      const result = extract({
        hierarchy: {
          bounds: { left: 10, top: 20, right: 410, bottom: 820 },
          className: "XCUIApplication",
        },
      });
      expect(result).toEqual({ width: 400, height: 800 });
    });

    test("should return null for missing hierarchy", function () {
      expect(extract(undefined)).toBeNull();
      expect(extract({})).toBeNull();
      expect(extract({ hierarchy: {} })).toBeNull();
    });

    test("should return null for zero-dimension bounds", function () {
      expect(
        extract({
          hierarchy: { bounds: { left: 0, top: 0, right: 0, bottom: 0 } },
        }),
      ).toBeNull();
    });
  });

  describe("Multi-device cache isolation", function () {
    const deviceA: BootedDevice = {
      deviceId: "emulator-5554",
      name: "Pixel A",
      platform: "android",
    };
    const deviceB: BootedDevice = {
      deviceId: "emulator-5556",
      name: "Pixel B",
      platform: "android",
    };

    beforeEach(function () {
      RealObserveScreen.clearCache();
    });

    test("getRecentCachedResultForDevice returns only that device's entries", async function () {
      const screenA = new RealObserveScreen(
        deviceA,
        new FakeAdbClientFactory(new FakeAdbExecutor()),
      );
      const screenB = new RealObserveScreen(
        deviceB,
        new FakeAdbClientFactory(new FakeAdbExecutor()),
      );

      const resultA: ObserveResult = {
        ...screenA.createBaseResult(),
        viewHierarchy: "hierarchy-A",
      };
      const resultB: ObserveResult = {
        ...screenB.createBaseResult(),
        viewHierarchy: "hierarchy-B",
      };

      await screenA.cacheObserveResult(resultA);
      await screenB.cacheObserveResult(resultB);

      const cachedA = RealObserveScreen.getRecentCachedResultForDevice(deviceA.deviceId);
      const cachedB = RealObserveScreen.getRecentCachedResultForDevice(deviceB.deviceId);

      expect(cachedA?.viewHierarchy).toBe("hierarchy-A");
      expect(cachedB?.viewHierarchy).toBe("hierarchy-B");
    });

    test("cached-result getters bound an uncapped layoutWarnings list (issue #5074)", async function () {
      // The audit is cached UNCAPPED so the observe tool's scope-then-cap path sees
      // the full set; the resource/registry getters that serialize the cache
      // directly must still be bounded.
      const screen = new RealObserveScreen(
        deviceA,
        new FakeAdbClientFactory(new FakeAdbExecutor()),
      );
      const result: ObserveResult = {
        ...screen.createBaseResult(),
        layoutWarnings: {
          scope: "full",
          warnings: Array.from({ length: 150 }, () => ({
            type: "important-content-under-inset",
            severity: "info",
            element: { bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
            categories: ["text"],
            insetTypes: ["systemBars"],
            sides: ["top"],
            overflowPx: { top: 1 },
            insetPx: { top: 1 },
            overlapPercent: 10,
            confidence: "medium",
          })),
        },
      };
      await screen.cacheObserveResult(result);

      const cachedForDevice = RealObserveScreen.getRecentCachedResultForDevice(deviceA.deviceId);
      expect(cachedForDevice?.layoutWarnings?.scope).toBe("truncated");
      expect(cachedForDevice?.layoutWarnings?.warnings).toHaveLength(100);
      expect(cachedForDevice?.layoutWarnings?.total).toBe(150);

      const cachedRecent = RealObserveScreen.getRecentCachedResult();
      expect(cachedRecent?.layoutWarnings?.warnings).toHaveLength(100);
    });

    test("getRecentCachedResult returns most recent across all devices", async function () {
      const now = Date.now();
      const timerA = new FakeTimer();
      timerA.setCurrentTime(now - 1000);
      const timerB = new FakeTimer();
      timerB.setCurrentTime(now);
      const screenA = new RealObserveScreen(
        deviceA,
        new FakeAdbClientFactory(new FakeAdbExecutor()),
        undefined,
        timerA,
      );
      const screenB = new RealObserveScreen(
        deviceB,
        new FakeAdbClientFactory(new FakeAdbExecutor()),
        undefined,
        timerB,
      );

      await screenA.cacheObserveResult({ ...screenA.createBaseResult(), viewHierarchy: "A" });
      await screenB.cacheObserveResult({ ...screenB.createBaseResult(), viewHierarchy: "B" });

      // Most recent should be B (timerB is 1s newer than timerA)
      const recent = RealObserveScreen.getRecentCachedResult();
      expect(recent?.viewHierarchy).toBe("B");
    });

    test("clearCache with deviceId only clears that device", async function () {
      const screenA = new RealObserveScreen(
        deviceA,
        new FakeAdbClientFactory(new FakeAdbExecutor()),
      );
      const screenB = new RealObserveScreen(
        deviceB,
        new FakeAdbClientFactory(new FakeAdbExecutor()),
      );

      await screenA.cacheObserveResult(screenA.createBaseResult());
      await screenB.cacheObserveResult(screenB.createBaseResult());

      RealObserveScreen.clearCache(deviceA.deviceId);

      expect(RealObserveScreen.getRecentCachedResultForDevice(deviceA.deviceId)).toBeUndefined();
      expect(RealObserveScreen.getRecentCachedResultForDevice(deviceB.deviceId)).toBeDefined();
    });

    test("clearCache without deviceId clears all devices", async function () {
      const screenA = new RealObserveScreen(
        deviceA,
        new FakeAdbClientFactory(new FakeAdbExecutor()),
      );
      const screenB = new RealObserveScreen(
        deviceB,
        new FakeAdbClientFactory(new FakeAdbExecutor()),
      );

      await screenA.cacheObserveResult(screenA.createBaseResult());
      await screenB.cacheObserveResult(screenB.createBaseResult());

      RealObserveScreen.clearCache();

      expect(RealObserveScreen.getRecentCachedResultForDevice(deviceA.deviceId)).toBeUndefined();
      expect(RealObserveScreen.getRecentCachedResultForDevice(deviceB.deviceId)).toBeUndefined();
    });

    test("getMostRecentCachedObserveResult returns only own device results", async function () {
      const screenA = new RealObserveScreen(
        deviceA,
        new FakeAdbClientFactory(new FakeAdbExecutor()),
      );
      const screenB = new RealObserveScreen(
        deviceB,
        new FakeAdbClientFactory(new FakeAdbExecutor()),
      );

      const resultA: ObserveResult = {
        ...screenA.createBaseResult(),
        viewHierarchy: "A-hierarchy",
      };
      await screenA.cacheObserveResult(resultA);
      await screenB.cacheObserveResult({
        ...screenB.createBaseResult(),
        viewHierarchy: "B-hierarchy",
      });

      // screenA's getMostRecentCachedObserveResult should return A's result, not B's
      const cached = await screenA.getMostRecentCachedObserveResult();
      expect(cached.viewHierarchy).toBe("A-hierarchy");
    });
  });
});
