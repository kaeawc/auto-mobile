import { z } from "zod/v4";
import {
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
} from "../../src/daemon/constants";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DEFAULT_MAX_INTERACTIONS, Explore } from "../../src/features/navigation/Explore";
import { NavigateTo } from "../../src/features/navigation/NavigateTo";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import { RealObserveScreen } from "../../src/features/observe/ObserveScreen";
import {
  exploreSchema,
  getNavigationGraphSchema,
  navigateToHandler,
  navigateToSchema,
  registerNavigationTools,
  resetNavigateToFactory,
  setNavigateToFactory,
} from "../../src/server/navigationTools";
import { ToolRegistry, type RegisteredTool } from "../../src/server/toolRegistry";
import { setDebugModeEnabled } from "../../src/utils/debug";
import { PortManager } from "../../src/utils/PortManager";
import { ActionableError, type BootedDevice } from "../../src/models";
import { FakeNavigationGraphManager } from "../fakes/FakeNavigationGraphManager";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";

describe("navigation tool session graph selection", () => {
  const device: BootedDevice = {
    deviceId: "ios-simulator-123",
    name: "iPhone",
    platform: "ios",
  };

  let adbFactorySpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    const fakeAdbFactory = new FakeAdbClientFactory();
    adbFactorySpy = spyOn(defaultAdbClientFactory, "create").mockImplementation((selectedDevice) =>
      fakeAdbFactory.create(selectedDevice),
    );
    ToolRegistry.clearTools();
    setDebugModeEnabled(true);
    registerNavigationTools();
  });

  afterEach(() => {
    adbFactorySpy.mockRestore();
    ToolRegistry.clearTools();
    setDebugModeEnabled(false);
    resetNavigateToFactory();
  });

  test.each(["android", "ios"] as const)(
    "explore rejects missing %s packages in a complete listing before executing",
    async (platform) => {
      const list = {
        executeDetailedResult: async () => ({
          successful: true,
          apps: { profiles: {}, system: [] },
        }),
        executeIosDetailedResult: async () => ({ successful: true, apps: [] }),
      };
      registerNavigationTools({ installedAppsFactory: () => list });
      const graphSpy = spyOn(NavigationGraphManager, "getInstance").mockReturnValue(
        new FakeNavigationGraphManager() as unknown as NavigationGraphManager,
      );
      const execute = spyOn(Explore.prototype, "execute").mockRejectedValue(
        new Error("must not start exploration"),
      );
      try {
        const handler = (
          ToolRegistry as unknown as { tools: Map<string, RegisteredTool> }
        ).tools.get("explore")!.deviceAwareHandler!;
        await expect(
          handler({ ...device, platform }, { packageName: "com.nope.missing" }),
        ).rejects.toThrow("Package not installed: com.nope.missing");
        expect(execute).not.toHaveBeenCalled();
        expect(graphSpy).not.toHaveBeenCalled();
      } finally {
        execute.mockRestore();
        graphSpy.mockRestore();
      }
    },
  );

  test.each(["android", "ios"] as const)(
    "explore rejects an inconclusive %s inventory",
    async (platform) => {
      registerNavigationTools({
        installedAppsFactory: () => ({
          executeDetailedResult: async () => ({
            successful: false,
            apps: { profiles: {}, system: [] },
          }),
          executeIosDetailedResult: async () => ({ successful: false, apps: [] }),
        }),
      });
      const graphSpy = spyOn(NavigationGraphManager, "getInstance").mockReturnValue(
        new FakeNavigationGraphManager() as unknown as NavigationGraphManager,
      );
      const execute = spyOn(Explore.prototype, "execute").mockRejectedValue(
        new Error("must not start exploration"),
      );
      try {
        const handler = (
          ToolRegistry as unknown as { tools: Map<string, RegisteredTool> }
        ).tools.get("explore")!.deviceAwareHandler!;
        await expect(
          handler({ ...device, platform }, { packageName: "com.test.app" }),
        ).rejects.toBeInstanceOf(ActionableError);
        await expect(
          handler({ ...device, platform }, { packageName: "com.test.app" }),
        ).rejects.toThrow("Could not confirm that com.test.app is installed");
        expect(execute).not.toHaveBeenCalled();
      } finally {
        execute.mockRestore();
        graphSpy.mockRestore();
      }
    },
  );

  test.each(["incomplete", "complete"] as const)(
    "explore rejects a %s Android listing without the target with the appropriate error",
    async (listing) => {
      const cause = new Error("work profile listing failed");
      registerNavigationTools({
        installedAppsFactory: () => ({
          executeDetailedResult: async () => ({
            successful: listing === "complete",
            error: cause,
            apps: {
              profiles: {
                personal: [
                  { packageName: "com.other.app", userIds: [0], foreground: false, recent: false },
                ],
              },
              system: [],
            },
          }),
          executeIosDetailedResult: async () => ({ successful: false, apps: [] }),
        }),
      });
      const graphSpy = spyOn(NavigationGraphManager, "getInstance").mockReturnValue(
        new FakeNavigationGraphManager() as unknown as NavigationGraphManager,
      );
      const execute = spyOn(Explore.prototype, "execute").mockRejectedValue(
        new Error("must not start exploration"),
      );
      try {
        const handler = (
          ToolRegistry as unknown as { tools: Map<string, RegisteredTool> }
        ).tools.get("explore")!.deviceAwareHandler!;
        await expect(
          handler({ ...device, platform: "android" }, { packageName: "com.test.app" }),
        ).rejects.toMatchObject({
          message:
            listing === "complete"
              ? "Package not installed: com.test.app. Install the app before exploring it."
              : "Could not confirm that com.test.app is installed: the installed-app listing was incomplete. Retry the installed-app listing.",
          ...(listing === "incomplete" ? { cause } : {}),
        });
        expect(execute).not.toHaveBeenCalled();
        expect(graphSpy).not.toHaveBeenCalled();
      } finally {
        execute.mockRestore();
        graphSpy.mockRestore();
      }
    },
  );

  test.each(["profile", "system"] as const)(
    "explore proceeds when an incomplete Android listing includes the target in %s apps",
    async (location) => {
      const target = {
        packageName: "com.test.app",
        userIds: [0],
        foreground: false,
        recent: false,
      };
      registerNavigationTools({
        installedAppsFactory: () => ({
          executeDetailedResult: async () => ({
            successful: false,
            apps: {
              profiles: location === "profile" ? { personal: [target] } : {},
              system: location === "system" ? [target] : [],
            },
          }),
          executeIosDetailedResult: async () => ({ successful: false, apps: [] }),
        }),
      });
      const graphSpy = spyOn(NavigationGraphManager, "getInstance").mockReturnValue(
        new FakeNavigationGraphManager() as unknown as NavigationGraphManager,
      );
      const result = {
        success: true as const,
        cancelled: false,
        interactionsPerformed: 0,
        screensDiscovered: 0,
        edgesAdded: 0,
        navigationGraph: { nodes: [], edges: [], appId: "com.test.app", currentScreen: null },
        explorationPath: [],
        elementSelections: [],
        coverage: { totalScreens: 0, exploredScreens: 0, percentage: 0 },
        durationMs: 0,
      };
      const execute = spyOn(Explore.prototype, "execute").mockResolvedValue(result);
      try {
        const handler = (
          ToolRegistry as unknown as { tools: Map<string, RegisteredTool> }
        ).tools.get("explore")!.deviceAwareHandler!;
        const response = await handler(
          { ...device, platform: "android" },
          { packageName: "com.test.app" },
        );
        expect(response.isError).toBeUndefined();
        expect(JSON.parse(response.content[0].text)).toMatchObject(result);
        expect(execute).toHaveBeenCalledTimes(1);
      } finally {
        execute.mockRestore();
        graphSpy.mockRestore();
      }
    },
  );

  test.each(["android", "ios"] as const)(
    "explore preserves %s completion and bypasses inventory for dryRun",
    async (platform) => {
      let listings = 0;
      registerNavigationTools({
        installedAppsFactory: () => {
          listings++;
          return {
            executeDetailedResult: async () => ({
              successful: true,
              apps: {
                profiles: {},
                system: [
                  { packageName: "com.test.app", userIds: [0], foreground: false, recent: false },
                ],
              },
            }),
            executeIosDetailedResult: async () => ({
              successful: true,
              apps: [{ CFBundleIdentifier: "com.test.app" }],
            }),
          };
        },
      });
      const graphSpy = spyOn(NavigationGraphManager, "getInstance").mockReturnValue(
        new FakeNavigationGraphManager() as unknown as NavigationGraphManager,
      );
      const normal = {
        success: true as const,
        cancelled: false,
        interactionsPerformed: 0,
        screensDiscovered: 0,
        edgesAdded: 0,
        navigationGraph: { nodes: [], edges: [], appId: "com.test.app", currentScreen: null },
        explorationPath: [],
        elementSelections: [],
        coverage: { totalScreens: 0, exploredScreens: 0, percentage: 0 },
        durationMs: 0,
        stopReason: "Left target app (com.test.app)",
      };
      const execute = spyOn(Explore.prototype, "execute").mockResolvedValue(normal);
      try {
        const handler = (
          ToolRegistry as unknown as { tools: Map<string, RegisteredTool> }
        ).tools.get("explore")!.deviceAwareHandler!;
        const response = await handler({ ...device, platform }, { packageName: " com.test.app " });
        expect(response.isError).toBeUndefined();
        expect(JSON.parse(response.content[0].text)).toMatchObject(normal);
        expect(listings).toBe(1);
        execute.mockResolvedValue({ ...normal, stopReason: "Exploration completed successfully" });
        const completed = await handler({ ...device, platform }, {});
        expect(completed.isError).toBeUndefined();
        expect(JSON.parse(completed.content[0].text).success).toBe(true);
        expect(listings).toBe(1);
        const dryRun = {
          success: true as const,
          dryRun: true as const,
          plannedInteractions: [],
          currentScreen: { name: "Home", interactableElements: 0 },
          estimatedCoverage: {
            screensToVisit: [],
            newScreensExpected: 0,
            existingScreensToRevisit: 0,
          },
          warnings: [],
          durationMs: 0,
        };
        execute.mockResolvedValue(dryRun);
        const dryResponse = await handler(
          { ...device, platform },
          { packageName: "com.nope.missing", dryRun: true },
        );
        expect(dryResponse.isError).toBeUndefined();
        expect(JSON.parse(dryResponse.content[0].text)).toMatchObject(dryRun);
        expect(listings).toBe(1);
      } finally {
        execute.mockRestore();
        graphSpy.mockRestore();
      }
    },
  );

  test("forwards the running request budget through NavigateTo into edge replay", async () => {
    const graph = new FakeNavigationGraphManager();
    const timer = new FakeTimer();
    await graph.setCurrentApp("com.test.app");
    graph.recordToolCall("budgetReplay", {
      text: "Settings",
      sessionUuid: "past-session",
      [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: 2,
      [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: 1,
    });
    for (const [destination, timestamp] of [
      ["Home", 100],
      ["Settings", 200],
      ["Home", 300],
    ] as const) {
      await graph.recordNavigationEvent({ destination, timestamp });
    }
    ToolRegistry.register(
      "budgetReplay",
      "Fake replay",
      z.object({ text: z.string() }),
      async () => {
        await graph.recordNavigationEvent({ destination: "Settings", timestamp: timer.now() });
        return { success: true };
      },
    );
    setNavigateToFactory(
      (selectedDevice) =>
        new NavigateTo(
          selectedDevice,
          new FakeAdbClientFactory(),
          { setupUIState: async () => [], setupScrollPosition: async () => null },
          { waitForScreen: async () => true },
          graph,
          timer,
        ),
    );
    const call = spyOn(ToolRegistry, "callInternal");
    try {
      const args = Object.freeze({
        targetScreen: "Settings",
        sessionUuid: "running-session",
        [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: 500,
        [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: 1500,
      });
      const response = await navigateToHandler(device, args);
      expect(response.isError).toBeUndefined();
      expect(call).toHaveBeenCalledTimes(1);
      expect(call.mock.calls[0]).toEqual([
        "budgetReplay",
        {
          text: "Settings",
          platform: "ios",
          deviceId: device.deviceId,
          sessionUuid: "running-session",
          [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: 500,
          [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: 1500,
        },
      ]);
      expect(args[INTERNAL_MCP_REQUEST_DEADLINE_PARAM]).toBe(1500);
    } finally {
      call.mockRestore();
    }
  });

  test("omits absent request budget keys from handler options", async () => {
    setNavigateToFactory(() => ({
      execute: async (options) => {
        expect(Object.hasOwn(options, INTERNAL_MCP_REQUEST_TIMEOUT_PARAM)).toBe(false);
        expect(Object.hasOwn(options, INTERNAL_MCP_REQUEST_DEADLINE_PARAM)).toBe(false);
        return {
          success: true,
          targetScreen: options.targetScreen,
          stepsExecuted: 0,
          durationMs: 0,
        };
      },
    }));
    for (const budget of [
      {},
      {
        [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: undefined,
        [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: undefined,
      },
    ]) {
      const response = await navigateToHandler(device, { targetScreen: "Settings", ...budget });
      expect(response.isError).toBeUndefined();
    }
  });

  test("omitted platform leaves iOS device resolution open for every navigation tool", async () => {
    const navigateArgs = navigateToSchema.parse({ targetScreen: "Settings" });
    expect(navigateArgs.platform).toBeUndefined();
    expect(getNavigationGraphSchema.parse({}).platform).toBeUndefined();
    expect(exploreSchema.parse({}).platform).toBeUndefined();

    let executedPlatform: string | undefined;
    setNavigateToFactory(() => ({
      execute: async (options) => {
        executedPlatform = options.platform;
        return {
          success: true,
          currentScreen: "Settings",
          targetScreen: "Settings",
          stepsExecuted: 0,
        };
      },
    }));
    await navigateToHandler(device, navigateArgs);
    expect(executedPlatform).toBe("ios");
  });

  test("explicit navigation platform remains authoritative", async () => {
    const navigateArgs = navigateToSchema.parse({ targetScreen: "Settings", platform: "android" });
    expect(getNavigationGraphSchema.parse({ platform: "android" }).platform).toBe("android");
    expect(exploreSchema.parse({ platform: "android" }).platform).toBe("android");

    let executedPlatform: string | undefined;
    setNavigateToFactory(() => ({
      execute: async (options) => {
        executedPlatform = options.platform;
        return {
          success: true,
          currentScreen: "Settings",
          targetScreen: "Settings",
          stepsExecuted: 0,
        };
      },
    }));
    await navigateToHandler(device, navigateArgs);
    expect(executedPlatform).toBe("android");
  });

  test("explore advertises the pinned runtime default of 200 interactions", () => {
    const schema = z.toJSONSchema(exploreSchema);
    expect(DEFAULT_MAX_INTERACTIONS).toBe(200);
    expect(schema.properties?.maxInteractions.description).toBe(
      `Max interactions (default: ${DEFAULT_MAX_INTERACTIONS})`,
    );
  });

  for (const field of ["maxInteractions", "resetInterval"] as const) {
    test(`explore rejects non-positive and fractional ${field}`, () => {
      for (const value of [0, -1, 0.5, 1.5]) {
        const result = exploreSchema.safeParse({ [field]: value });
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].path).toEqual([field]);
        }
      }
      expect(exploreSchema.safeParse({ [field]: 1 }).success).toBe(true);
    });
  }

  test("explore rejects non-positive timeouts and preserves fractional milliseconds", () => {
    for (const timeoutMs of [0, -1]) {
      const result = exploreSchema.safeParse({ timeoutMs });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toEqual(["timeoutMs"]);
      }
    }
    expect(exploreSchema.safeParse({ timeoutMs: 0.5 }).success).toBe(true);
  });

  test("registered navigation tools resolve an omitted platform to the active iOS device", async () => {
    const fakeDevices = new FakeDeviceSessionManager();
    fakeDevices.setConnectedDevices([device]);
    fakeDevices.setCurrentDevice(device, "ios");
    const registry = ToolRegistry as unknown as {
      deviceSessionManager: FakeDeviceSessionManager;
      tools: Map<string, { handler: (args: unknown) => Promise<unknown> }>;
    };
    const originalDevices = registry.deviceSessionManager;
    registry.deviceSessionManager = fakeDevices;
    const restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
    });
    const graph = new FakeNavigationGraphManager();
    Object.assign(graph, {
      getStatsForApp: async () => ({
        nodeCount: 0,
        edgeCount: 0,
        currentScreen: null,
        knownEdgeCount: 0,
        unknownEdgeCount: 0,
      }),
      exportGraphForApp: async () => ({ nodes: [], edges: [] }),
    });
    const graphSpy = spyOn(NavigationGraphManager, "getInstance").mockReturnValue(
      graph as unknown as NavigationGraphManager,
    );
    const exploreSpy = spyOn(Explore.prototype, "execute").mockResolvedValue({
      success: true,
      interactionsPerformed: 0,
      screensDiscovered: 0,
      coverage: { explored: 0, total: 0, percentage: 0 },
    } as Awaited<ReturnType<Explore["execute"]>>);
    setNavigateToFactory(() => ({
      execute: async () => ({
        success: true,
        currentScreen: "Settings",
        targetScreen: "Settings",
        stepsExecuted: 0,
      }),
    }));

    try {
      const calls = [
        ["navigateTo", navigateToSchema.parse({ targetScreen: "Settings" })],
        ["explore", exploreSchema.parse({})],
        ["getNavigationGraph", getNavigationGraphSchema.parse({})],
      ] as const;
      for (const [name, args] of calls) {
        await registry.tools.get(name)!.handler(args);
        expect(fakeDevices.getLastEnsureDeviceReadyPlatform()).toBe("either");
      }
      expect(fakeDevices.getEnsureDeviceReadyCallCount()).toBe(3);

      await expect(
        registry.tools
          .get("navigateTo")!
          .handler(navigateToSchema.parse({ targetScreen: "Settings", platform: "android" })),
      ).rejects.toThrow("No android device found");
      expect(fakeDevices.getLastEnsureDeviceReadyPlatform()).toBe("android");
    } finally {
      restorePipelineOverrides();
      registry.deviceSessionManager = originalDevices;
      graphSpy.mockRestore();
      exploreSpy.mockRestore();
    }
  });

  test("routes navigateTo and explore through the label-resolved session graph", async () => {
    const sessionGraph = new FakeNavigationGraphManager();
    const usedManagers: unknown[] = [];
    const usedSessions: unknown[] = [];
    const sessionManagerSpy = spyOn(
      NavigationGraphManager,
      "getInstanceForSession",
    ).mockReturnValue(sessionGraph as unknown as NavigationGraphManager);
    PortManager.setPortAvailabilityCheckerForTesting({
      isPortAvailable: () => true,
    });
    const navigateExecuteSpy = spyOn(NavigateTo.prototype, "execute").mockImplementation(
      async function () {
        usedManagers.push((this as unknown as { navigationManager: unknown }).navigationManager);
        usedSessions.push((this as unknown as { sessionUuid: unknown }).sessionUuid);
        return {
          success: false,
          error: "No path",
          currentScreen: null,
          targetScreen: "Settings",
          stepsExecuted: 0,
        };
      },
    );
    const exploreExecuteSpy = spyOn(Explore.prototype, "execute").mockImplementation(
      async function () {
        usedManagers.push((this as unknown as { navigationManager: unknown }).navigationManager);
        usedSessions.push((this as unknown as { sessionUuid: unknown }).sessionUuid);
        return {
          success: true,
          interactionsPerformed: 0,
          screensDiscovered: 0,
          coverage: { explored: 0, total: 0, percentage: 0 },
        } as any;
      },
    );

    try {
      const tools = ToolRegistry as unknown as {
        tools: Map<
          string,
          { deviceAwareHandler?: (device: BootedDevice, args: any) => Promise<unknown> }
        >;
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
      PortManager.reset();
      PortManager.setPortAvailabilityCheckerForTesting(null);
    }
  });

  test("reports the target iOS device's observed app instead of a stale graph app", async () => {
    const staleGraph = new FakeNavigationGraphManager();
    staleGraph.setCurrentAppId("com.google.android.settings.intelligence");
    staleGraph.addNode({
      screenName: "Android Settings",
      firstSeenAt: 1,
      lastSeenAt: 1,
      visitCount: 1,
    });
    staleGraph.addEdge({
      from: "Android Settings",
      to: "Android Accessibility",
      timestamp: 1,
      edgeType: "unknown",
    });
    Object.assign(staleGraph, {
      getStatsForApp: async (appId: string | null) => {
        expect(appId).toBe("com.apple.Preferences");
        return {
          nodeCount: 2,
          edgeCount: 1,
          currentScreen: null,
          knownEdgeCount: 1,
          unknownEdgeCount: 0,
          toolCallHistorySize: 0,
        };
      },
      exportGraphForApp: async (appId: string | null) => {
        expect(appId).toBe("com.apple.Preferences");
        return {
          appId,
          currentScreen: null,
          nodes: [
            { screenName: "iOS Settings", firstSeenAt: 1, lastSeenAt: 2, visitCount: 3 },
            { screenName: "iOS General", firstSeenAt: 2, lastSeenAt: 3, visitCount: 1 },
          ],
          edges: [
            {
              from: "iOS Settings",
              to: "iOS General",
              timestamp: 3,
              edgeType: "tool" as const,
              interaction: { toolName: "tapOn", args: { text: "General" }, timestamp: 3 },
            },
          ],
        };
      },
    });
    const managerSpy = spyOn(NavigationGraphManager, "getInstance").mockReturnValue(
      staleGraph as unknown as NavigationGraphManager,
    );
    const observationSpy = spyOn(
      RealObserveScreen,
      "getRecentCachedResultForDevice",
    ).mockReturnValue({
      viewHierarchy: { packageName: "com.apple.Preferences" },
    } as never);

    try {
      const handler = (
        ToolRegistry as unknown as {
          tools: Map<
            string,
            { deviceAwareHandler?: (device: BootedDevice, args: any) => Promise<any> }
          >;
        }
      ).tools.get("getNavigationGraph")?.deviceAwareHandler;

      const response = await handler!(device, { platform: "ios" });

      const result = JSON.parse(response.content[0].text);
      expect(result.message).toBe("Navigation graph for app: com.apple.Preferences");
      expect(result).toMatchObject({
        currentScreen: null,
        nodeCount: 2,
        edgeCount: 1,
        knownEdges: 1,
        unknownEdges: 0,
        screens: [
          { name: "iOS Settings", visitCount: 3 },
          { name: "iOS General", visitCount: 1 },
        ],
        transitions: [
          {
            from: "iOS Settings",
            to: "iOS General",
            type: "tool",
            tool: "tapOn",
            args: { text: "General" },
          },
        ],
      });
    } finally {
      observationSpy.mockRestore();
      managerSpy.mockRestore();
    }
  });

  test("scopes the graph to an explicit appId even when the current app changed to SpringBoard", async () => {
    // Regression for issue #4579: after SDK events reach the fixture app's
    // graph, a concurrent hierarchy push can mark com.apple.springboard current.
    // An explicit appId must read the fixture graph, not the current app's.
    const graph = new FakeNavigationGraphManager();
    Object.assign(graph, {
      getStatsForApp: async (appId: string | null) => {
        expect(appId).toBe("com.apple.reminders");
        return {
          nodeCount: 2,
          edgeCount: 1,
          currentScreen: null,
          knownEdgeCount: 1,
          unknownEdgeCount: 0,
          toolCallHistorySize: 0,
        };
      },
      exportGraphForApp: async (appId: string | null) => {
        expect(appId).toBe("com.apple.reminders");
        return {
          appId,
          currentScreen: null,
          nodes: [
            { screenName: "Issue4460Home", firstSeenAt: 1, lastSeenAt: 2, visitCount: 1 },
            { screenName: "Issue4460Detail", firstSeenAt: 2, lastSeenAt: 3, visitCount: 1 },
          ],
          edges: [
            {
              from: "Issue4460Home",
              to: "Issue4460Detail",
              timestamp: 3,
              edgeType: "unknown" as const,
            },
          ],
        };
      },
    });
    const managerSpy = spyOn(NavigationGraphManager, "getInstance").mockReturnValue(
      graph as unknown as NavigationGraphManager,
    );
    // A concurrent hierarchy update marked SpringBoard current.
    const observationSpy = spyOn(
      RealObserveScreen,
      "getRecentCachedResultForDevice",
    ).mockReturnValue({
      viewHierarchy: { packageName: "com.apple.springboard" },
    } as never);

    try {
      const handler = (
        ToolRegistry as unknown as {
          tools: Map<
            string,
            { deviceAwareHandler?: (device: BootedDevice, args: any) => Promise<any> }
          >;
        }
      ).tools.get("getNavigationGraph")?.deviceAwareHandler;

      const response = await handler!(device, {
        platform: "ios",
        appId: "com.apple.reminders",
      });

      const result = JSON.parse(response.content[0].text);
      // Failures identify the queried app and the current app (diagnostics).
      expect(result.message).toBe("Navigation graph for app: com.apple.reminders");
      expect(result.requestedAppId).toBe("com.apple.reminders");
      expect(result.observedAppId).toBe("com.apple.springboard");
      expect(result).toMatchObject({
        nodeCount: 2,
        edgeCount: 1,
        knownEdges: 1,
        unknownEdges: 0,
        screens: [
          { name: "Issue4460Home", visitCount: 1 },
          { name: "Issue4460Detail", visitCount: 1 },
        ],
        transitions: [{ from: "Issue4460Home", to: "Issue4460Detail", type: "unknown" }],
      });
    } finally {
      observationSpy.mockRestore();
      managerSpy.mockRestore();
    }
  });

  test("reports none when the target device has no cached observation", async () => {
    const staleGraph = new FakeNavigationGraphManager();
    staleGraph.setCurrentAppId("com.google.android.settings.intelligence");
    staleGraph.addNode({
      screenName: "Android Settings",
      firstSeenAt: 1,
      lastSeenAt: 1,
      visitCount: 1,
    });
    Object.assign(staleGraph, {
      getStatsForApp: async (appId: string | null) => {
        expect(appId).toBeNull();
        return {
          nodeCount: 0,
          edgeCount: 0,
          currentScreen: null,
          knownEdgeCount: 0,
          unknownEdgeCount: 0,
          toolCallHistorySize: 0,
        };
      },
      exportGraphForApp: async (appId: string | null) => {
        expect(appId).toBeNull();
        return { appId, currentScreen: null, nodes: [], edges: [] };
      },
    });
    const managerSpy = spyOn(NavigationGraphManager, "getInstance").mockReturnValue(
      staleGraph as unknown as NavigationGraphManager,
    );
    const observationSpy = spyOn(
      RealObserveScreen,
      "getRecentCachedResultForDevice",
    ).mockReturnValue(undefined);

    try {
      const handler = (
        ToolRegistry as unknown as {
          tools: Map<
            string,
            { deviceAwareHandler?: (device: BootedDevice, args: any) => Promise<any> }
          >;
        }
      ).tools.get("getNavigationGraph")?.deviceAwareHandler;

      const response = await handler!(device, { platform: "ios" });

      expect(JSON.parse(response.content[0].text)).toEqual({
        message: "Navigation graph for app: none",
        requestedAppId: null,
        observedAppId: null,
        currentScreen: null,
        nodeCount: 0,
        edgeCount: 0,
        knownEdges: 0,
        unknownEdges: 0,
        screens: [],
        transitions: [],
      });
    } finally {
      observationSpy.mockRestore();
      managerSpy.mockRestore();
    }
  });

  test("keeps the current graph response unchanged when it matches the target observation", async () => {
    const graph = new FakeNavigationGraphManager();
    graph.setCurrentAppId("com.apple.Preferences");
    graph.setCurrentScreenValue("iOS Settings");
    graph.addNode({
      screenName: "iOS Settings",
      firstSeenAt: 1,
      lastSeenAt: 2,
      visitCount: 3,
    });
    Object.assign(graph, {
      getStatsForApp: async (appId: string | null) => {
        expect(appId).toBe("com.apple.Preferences");
        return {
          nodeCount: 1,
          edgeCount: 0,
          currentScreen: "iOS Settings",
          knownEdgeCount: 0,
          unknownEdgeCount: 0,
          toolCallHistorySize: 0,
        };
      },
      exportGraphForApp: async (appId: string | null) => {
        expect(appId).toBe("com.apple.Preferences");
        return {
          appId,
          currentScreen: "iOS Settings",
          nodes: [{ screenName: "iOS Settings", firstSeenAt: 1, lastSeenAt: 2, visitCount: 3 }],
          edges: [],
        };
      },
    });
    const managerSpy = spyOn(NavigationGraphManager, "getInstance").mockReturnValue(
      graph as unknown as NavigationGraphManager,
    );
    const observationSpy = spyOn(
      RealObserveScreen,
      "getRecentCachedResultForDevice",
    ).mockReturnValue({
      viewHierarchy: { packageName: "com.apple.Preferences" },
    } as never);

    try {
      const handler = (
        ToolRegistry as unknown as {
          tools: Map<
            string,
            { deviceAwareHandler?: (device: BootedDevice, args: any) => Promise<any> }
          >;
        }
      ).tools.get("getNavigationGraph")?.deviceAwareHandler;

      const response = await handler!(device, { platform: "ios" });

      expect(JSON.parse(response.content[0].text)).toMatchObject({
        message: "Navigation graph for app: com.apple.Preferences",
        currentScreen: "iOS Settings",
        nodeCount: 1,
        edgeCount: 0,
        screens: [{ name: "iOS Settings", visitCount: 3 }],
        transitions: [],
      });
    } finally {
      observationSpy.mockRestore();
      managerSpy.mockRestore();
    }
  });
});
