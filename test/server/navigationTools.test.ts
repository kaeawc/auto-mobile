import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Explore } from "../../src/features/navigation/Explore";
import { NavigateTo } from "../../src/features/navigation/NavigateTo";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import { RealObserveScreen } from "../../src/features/observe/ObserveScreen";
import { registerNavigationTools } from "../../src/server/navigationTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { setDebugModeEnabled } from "../../src/utils/debug";
import type { BootedDevice } from "../../src/models";
import { FakeNavigationGraphManager } from "../fakes/FakeNavigationGraphManager";

describe("navigation tool session graph selection", () => {
  const device: BootedDevice = {
    deviceId: "ios-simulator-123",
    name: "iPhone",
    platform: "ios",
  };

  beforeEach(() => {
    ToolRegistry.clearTools();
    setDebugModeEnabled(true);
    registerNavigationTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    setDebugModeEnabled(false);
  });

  test("routes navigateTo and explore through the label-resolved session graph", async () => {
    const sessionGraph = new FakeNavigationGraphManager();
    const usedManagers: unknown[] = [];
    const usedSessions: unknown[] = [];
    const sessionManagerSpy = spyOn(NavigationGraphManager, "getInstanceForSession")
      .mockReturnValue(sessionGraph as unknown as NavigationGraphManager);
    const navigateExecuteSpy = spyOn(NavigateTo.prototype, "execute").mockImplementation(async function() {
      usedManagers.push((this as unknown as { navigationManager: unknown }).navigationManager);
      usedSessions.push((this as unknown as { sessionUuid: unknown }).sessionUuid);
      return {
        success: false,
        error: "No path",
        currentScreen: null,
        targetScreen: "Settings",
        stepsExecuted: 0,
      };
    });
    const exploreExecuteSpy = spyOn(Explore.prototype, "execute").mockImplementation(async function() {
      usedManagers.push((this as unknown as { navigationManager: unknown }).navigationManager);
      usedSessions.push((this as unknown as { sessionUuid: unknown }).sessionUuid);
      return {
        success: true,
        interactionsPerformed: 0,
        screensDiscovered: 0,
        coverage: { explored: 0, total: 0, percentage: 0 },
      } as any;
    });

    try {
      const tools = ToolRegistry as unknown as {
        tools: Map<string, { deviceAwareHandler?: (device: BootedDevice, args: any) => Promise<unknown> }>;
      };
      const navigateHandler = tools.tools.get("navigateTo")?.deviceAwareHandler;
      const exploreHandler = tools.tools.get("explore")?.deviceAwareHandler;

      expect(navigateHandler).toBeDefined();
      expect(exploreHandler).toBeDefined();

      await navigateHandler!(device, {
        targetScreen: "Settings",
        platform: "ios",
        // ToolRegistry resolves a labelled device's base session to this child
        // session before invoking the device-aware handler.
        sessionUuid: "session-123:B",
      });
      await exploreHandler!(device, {
        platform: "ios",
        sessionUuid: "session-123:B",
      });

      expect(sessionManagerSpy).toHaveBeenCalledTimes(2);
      expect(sessionManagerSpy).toHaveBeenCalledWith("session-123:B");
      expect(usedManagers).toEqual([sessionGraph, sessionGraph]);
      expect(usedSessions).toEqual(["session-123:B", "session-123:B"]);
    } finally {
      sessionManagerSpy.mockRestore();
      navigateExecuteSpy.mockRestore();
      exploreExecuteSpy.mockRestore();
    }
  });

  test("reports the target iOS device's observed app instead of a stale graph app", async () => {
    const staleGraph = new FakeNavigationGraphManager();
    staleGraph.setCurrentAppId("com.google.android.settings.intelligence");
    const managerSpy = spyOn(NavigationGraphManager, "getInstance").mockReturnValue(
      staleGraph as unknown as NavigationGraphManager
    );
    const observationSpy = spyOn(RealObserveScreen, "getRecentCachedResultForDevice").mockReturnValue({
      viewHierarchy: { packageName: "com.apple.Preferences" }
    } as never);

    try {
      const handler = (ToolRegistry as unknown as {
        tools: Map<string, { deviceAwareHandler?: (device: BootedDevice, args: any) => Promise<any> }>;
      }).tools.get("getNavigationGraph")?.deviceAwareHandler;

      const response = await handler!(device, { platform: "ios" });

      expect(JSON.parse(response.content[0].text).message).toBe(
        "Navigation graph for app: com.apple.Preferences"
      );
    } finally {
      observationSpy.mockRestore();
      managerSpy.mockRestore();
    }
  });

  test("reports none when the target device has no cached observation", async () => {
    const staleGraph = new FakeNavigationGraphManager();
    staleGraph.setCurrentAppId("com.google.android.settings.intelligence");
    const managerSpy = spyOn(NavigationGraphManager, "getInstance").mockReturnValue(
      staleGraph as unknown as NavigationGraphManager
    );
    const observationSpy = spyOn(RealObserveScreen, "getRecentCachedResultForDevice").mockReturnValue(undefined);

    try {
      const handler = (ToolRegistry as unknown as {
        tools: Map<string, { deviceAwareHandler?: (device: BootedDevice, args: any) => Promise<any> }>;
      }).tools.get("getNavigationGraph")?.deviceAwareHandler;

      const response = await handler!(device, { platform: "ios" });

      expect(JSON.parse(response.content[0].text).message).toBe("Navigation graph for app: none");
    } finally {
      observationSpy.mockRestore();
      managerSpy.mockRestore();
    }
  });
});
