import { readToolResponse, toolJson, schemaPropertyDescription } from "../helpers/toolResponse";
import { z } from "zod/v4";
import {
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
} from "../../src/daemon/wire/constants";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import { underRequestDeadline } from "../helpers/requestDeadline";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DEFAULT_MAX_INTERACTIONS, Explore } from "../../src/features/navigation/Explore";
import { NavigateTo } from "../../src/features/navigation/NavigateTo";
import {
  NavigationGraphManager,
  type NavigationGraphService,
} from "../../src/features/navigation/NavigationGraphManager";
import { RealObserveScreen } from "../../src/features/observe/ObserveScreen";
import {
  exploreSchema,
  getNavigationGraphSchema,
  createNavigateToHandler,
  navigateToSchema,
  registerNavigationTools,
} from "../../src/server/navigationTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { setDebugModeEnabled } from "../../src/utils/debug";
import { PortManager } from "../../src/utils/PortManager";
import { ActionableError, type BootedDevice } from "../../src/models";
import { NavigationRepository } from "../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../src/db/testCoverageRepository";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeNavigationGraphManager } from "../fakes/FakeNavigationGraphManager";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

/** The private collaborators the NavigateTo/Explore spies read off the instance they replace. */
interface ExecuteReceiver {
  navigationManager: unknown;
  sessionUuid: unknown;
}

describe("navigation tool session graph selection", () => {
  const device: BootedDevice = {
    deviceId: "ios-simulator-123",
    name: "iPhone",
    platform: "ios",
  };

  let adbFactorySpy: ReturnType<typeof spyOn>;
  let activeGraph: NavigationGraphService;
  let resolvedSessions: Array<string | undefined>;
  const navigationManagerFactory = (sessionUuid?: string): NavigationGraphService => {
    resolvedSessions.push(sessionUuid);
    return activeGraph;
  };
  beforeEach(() => {
    activeGraph = new FakeNavigationGraphManager();
    resolvedSessions = [];
    const fakeAdbFactory = new FakeAdbClientFactory();
    adbFactorySpy = spyOn(defaultAdbClientFactory, "create").mockImplementation((selectedDevice) =>
      fakeAdbFactory.create(selectedDevice),
    );
    ToolRegistry.clearTools();
    setDebugModeEnabled(true);
    registerNavigationTools({ navigationManagerFactory });
  });

  afterEach(() => {
    adbFactorySpy.mockRestore();
    ToolRegistry.clearTools();
    setDebugModeEnabled(false);
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
      registerNavigationTools({ navigationManagerFactory, installedAppsFactory: () => list });
      activeGraph = new FakeNavigationGraphManager();
      const execute = spyOn(Explore.prototype, "execute").mockRejectedValue(
        new Error("must not start exploration"),
      );
      try {
        const handler = ToolRegistry.getRegisteredTool("explore")!.deviceAwareHandler!;
        await expect(
          handler({ ...device, platform }, { packageName: "com.nope.missing" }),
        ).rejects.toThrow("Package not installed: com.nope.missing");
        expect(execute).not.toHaveBeenCalled();
        expect(resolvedSessions).toEqual([]);
      } finally {
        execute.mockRestore();
      }
    },
  );

  test.each(["android", "ios"] as const)(
    "explore rejects an inconclusive %s inventory",
    async (platform) => {
      registerNavigationTools({
        navigationManagerFactory,
        installedAppsFactory: () => ({
          executeDetailedResult: async () => ({
            successful: false,
            apps: { profiles: {}, system: [] },
          }),
          executeIosDetailedResult: async () => ({ successful: false, apps: [] }),
        }),
      });
      activeGraph = new FakeNavigationGraphManager();
      const execute = spyOn(Explore.prototype, "execute").mockRejectedValue(
        new Error("must not start exploration"),
      );
      try {
        const handler = ToolRegistry.getRegisteredTool("explore")!.deviceAwareHandler!;
        await expect(
          handler({ ...device, platform }, { packageName: "com.test.app" }),
        ).rejects.toBeInstanceOf(ActionableError);
        await expect(
          handler({ ...device, platform }, { packageName: "com.test.app" }),
        ).rejects.toThrow("Could not confirm that com.test.app is installed");
        expect(execute).not.toHaveBeenCalled();
      } finally {
        execute.mockRestore();
      }
    },
  );

  test.each(["incomplete", "complete"] as const)(
    "explore rejects a %s Android listing without the target with the appropriate error",
    async (listing) => {
      const cause = new Error("work profile listing failed");
      registerNavigationTools({
        navigationManagerFactory,
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
      activeGraph = new FakeNavigationGraphManager();
      const execute = spyOn(Explore.prototype, "execute").mockRejectedValue(
        new Error("must not start exploration"),
      );
      try {
        const handler = ToolRegistry.getRegisteredTool("explore")!.deviceAwareHandler!;
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
        expect(resolvedSessions).toEqual([]);
      } finally {
        execute.mockRestore();
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
        navigationManagerFactory,
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
      activeGraph = new FakeNavigationGraphManager();
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
        const handler = ToolRegistry.getRegisteredTool("explore")!.deviceAwareHandler!;
        const response = await handler(
          { ...device, platform: "android" },
          { packageName: "com.test.app" },
        );
        expect(readToolResponse(response).isError).toBeUndefined();
        expect(toolJson(response)).toMatchObject(result);
        expect(execute).toHaveBeenCalledTimes(1);
      } finally {
        execute.mockRestore();
      }
    },
  );

  test.each(["android", "ios"] as const)(
    "explore preserves %s completion and bypasses inventory for dryRun",
    async (platform) => {
      let listings = 0;
      registerNavigationTools({
        navigationManagerFactory,
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
      activeGraph = new FakeNavigationGraphManager();
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
        const handler = ToolRegistry.getRegisteredTool("explore")!.deviceAwareHandler!;
        const response = await handler({ ...device, platform }, { packageName: " com.test.app " });
        expect(readToolResponse(response).isError).toBeUndefined();
        expect(toolJson(response)).toMatchObject(normal);
        expect(listings).toBe(1);
        execute.mockResolvedValue({ ...normal, stopReason: "Exploration completed successfully" });
        const completed = await handler({ ...device, platform }, {});
        expect(readToolResponse(completed).isError).toBeUndefined();
        expect(toolJson(completed).success).toBe(true);
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
        expect(readToolResponse(dryResponse).isError).toBeUndefined();
        expect(toolJson(dryResponse)).toMatchObject(dryRun);
        expect(listings).toBe(1);
      } finally {
        execute.mockRestore();
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
      await graph.recordNavigationEvent({
        destination,
        timestamp,
        source: "",
        arguments: {},
        metadata: {},
        sequenceNumber: 0,
      });
    }
    ToolRegistry.register(
      "budgetReplay",
      "Fake replay",
      z.object({ text: z.string() }),
      async () => {
        await graph.recordNavigationEvent({
          destination: "Settings",
          timestamp: timer.now(),
          source: "",
          arguments: {},
          metadata: {},
          sequenceNumber: 0,
        });
        return { success: true };
      },
    );
    const navigateToHandler = createNavigateToHandler({
      navigateToFactory: (selectedDevice) =>
        new NavigateTo(selectedDevice, new FakeAdbClientFactory(), {
          uiStateSetup: { setupUIState: async () => [], setupScrollPosition: async () => null },
          screenWaiter: { waitForScreen: async () => true },
          navigationManager: graph,
          timer,
        }),
    });
    const call = spyOn(ToolRegistry, "callInternal");
    try {
      const args = Object.freeze({ targetScreen: "Settings", sessionUuid: "running-session" });
      const response = await underRequestDeadline(
        { timeoutMs: 500, deadlineMs: 1500, startTime: 7, liveDeadlineKey: "navigate-live" },
        () => navigateToHandler(device, args),
      );
      expect(readToolResponse(response).isError).toBeUndefined();
      expect(call).toHaveBeenCalledTimes(1);
      expect(call.mock.calls[0]).toEqual([
        "budgetReplay",
        {
          text: "Settings",
          platform: "ios",
          deviceId: device.deviceId,
          sessionUuid: "running-session",
        },
        // The replay runs under the request's absolute and remaining budget, as before (#15663).
        {
          progress: undefined,
          signal: undefined,
          requestDeadline: { timeoutMs: 500, deadlineMs: 1500 },
        },
      ]);
    } finally {
      call.mockRestore();
    }
  });

  test("omits an absent request budget from handler options", async () => {
    const navigateToHandler = createNavigateToHandler({
      navigateToFactory: () => ({
        execute: async (options) => {
          expect(Object.hasOwn(options, "requestDeadline")).toBe(false);
          return {
            success: true,
            targetScreen: options.targetScreen,
            currentScreen: options.targetScreen,
            stepsExecuted: 0,
            durationMs: 0,
          };
        },
      }),
    });
    // No request deadline, and one carrying neither budget (only a start time).
    for (const requestDeadline of [undefined, { startTime: 1 }]) {
      const response = await runWithToolSelectionContext({ requestDeadline }, () =>
        navigateToHandler(device, { targetScreen: "Settings" }),
      );
      expect(readToolResponse(response).isError).toBeUndefined();
    }
  });

  test("omitted platform leaves iOS device resolution open for every navigation tool", async () => {
    const navigateArgs = navigateToSchema.parse({ targetScreen: "Settings" });
    expect(navigateArgs.platform).toBeUndefined();
    expect(getNavigationGraphSchema.parse({}).platform).toBeUndefined();
    expect(exploreSchema.parse({}).platform).toBeUndefined();

    let executedPlatform: string | undefined;
    const navigateToHandler = createNavigateToHandler({
      navigateToFactory: () => ({
        execute: async (options) => {
          executedPlatform = options.platform;
          return {
            success: true,
            currentScreen: "Settings",
            targetScreen: "Settings",
            stepsExecuted: 0,
          };
        },
      }),
    });
    await navigateToHandler(device, navigateArgs);
    expect(executedPlatform).toBe("ios");
  });

  test("explicit navigation platform remains authoritative", async () => {
    const navigateArgs = navigateToSchema.parse({ targetScreen: "Settings", platform: "android" });
    expect(getNavigationGraphSchema.parse({ platform: "android" }).platform).toBe("android");
    expect(exploreSchema.parse({ platform: "android" }).platform).toBe("android");

    let executedPlatform: string | undefined;
    const navigateToHandler = createNavigateToHandler({
      navigateToFactory: () => ({
        execute: async (options) => {
          executedPlatform = options.platform;
          return {
            success: true,
            currentScreen: "Settings",
            targetScreen: "Settings",
            stepsExecuted: 0,
          };
        },
      }),
    });
    await navigateToHandler(device, navigateArgs);
    expect(executedPlatform).toBe("android");
  });

  test("explore advertises the pinned runtime default of 200 interactions", () => {
    const schema = z.toJSONSchema(exploreSchema);
    expect(DEFAULT_MAX_INTERACTIONS).toBe(200);
    expect(schemaPropertyDescription(schema.properties, "maxInteractions")).toBe(
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
    const fakeDevices = new FakeDeviceReadiness();
    fakeDevices.setConnectedDevices([device]);
    fakeDevices.setExplicitDevicePin(device);
    const originalDevices = ToolRegistry.getCollaboratorsForTesting().deviceReadiness;
    ToolRegistry.setCollaboratorsForTesting({ deviceReadiness: fakeDevices });
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
    activeGraph = graph;
    const exploreSpy = spyOn(Explore.prototype, "execute").mockResolvedValue({
      success: true,
      interactionsPerformed: 0,
      screensDiscovered: 0,
      coverage: { exploredScreens: 0, totalScreens: 0, percentage: 0 },
      edgesAdded: 0,
      navigationGraph: { nodes: [], edges: [], appId: "com.test.app", currentScreen: null },
      explorationPath: [],
      durationMs: 0,
    });
    registerNavigationTools({
      navigationManagerFactory,
      navigateToFactory: () => ({
        execute: async () => ({
          success: true,
          currentScreen: "Settings",
          targetScreen: "Settings",
          stepsExecuted: 0,
        }),
      }),
    });

    try {
      const calls = [
        ["navigateTo", navigateToSchema.parse({ targetScreen: "Settings" })],
        ["explore", exploreSchema.parse({})],
        ["getNavigationGraph", getNavigationGraphSchema.parse({})],
      ] as const;
      for (const [name, args] of calls) {
        await ToolRegistry.getRegisteredTool(name)!.handler(args);
        expect(fakeDevices.getLastEnsureDeviceReadyPlatform()).toBe("either");
      }
      expect(fakeDevices.getEnsureDeviceReadyCallCount()).toBe(3);

      await expect(
        ToolRegistry.getRegisteredTool("navigateTo")!.handler(
          navigateToSchema.parse({ targetScreen: "Settings", platform: "android" }),
        ),
      ).rejects.toThrow("No android device found");
      expect(fakeDevices.getLastEnsureDeviceReadyPlatform()).toBe("android");
    } finally {
      restorePipelineOverrides();
      ToolRegistry.setCollaboratorsForTesting({ deviceReadiness: originalDevices });
      exploreSpy.mockRestore();
    }
  });

  test("routes navigateTo and explore through the label-resolved session graph", async () => {
    const sessionGraph = new FakeNavigationGraphManager();
    const usedManagers: unknown[] = [];
    const usedSessions: unknown[] = [];
    activeGraph = sessionGraph;
    PortManager.setPortAvailabilityCheckerForTesting({
      isPortAvailable: () => true,
    });
    const navigateExecuteSpy = spyOn(NavigateTo.prototype, "execute").mockImplementation(
      async function (this: ExecuteReceiver) {
        usedManagers.push(this.navigationManager);
        usedSessions.push(this.sessionUuid);
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
      async function (this: ExecuteReceiver) {
        usedManagers.push(this.navigationManager);
        usedSessions.push(this.sessionUuid);
        return {
          success: true,
          interactionsPerformed: 0,
          screensDiscovered: 0,
          coverage: { exploredScreens: 0, totalScreens: 0, percentage: 0 },
          edgesAdded: 0,
          navigationGraph: { nodes: [], edges: [], appId: "com.test.app", currentScreen: null },
          explorationPath: [],
          durationMs: 0,
        };
      },
    );

    try {
      const navigateHandler = ToolRegistry.getRegisteredTool("navigateTo")?.deviceAwareHandler;
      const exploreHandler = ToolRegistry.getRegisteredTool("explore")?.deviceAwareHandler;

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

      expect(resolvedSessions).toEqual(["session-123:B", "session-123:B"]);
      expect(usedManagers).toEqual([sessionGraph, sessionGraph]);
      expect(usedSessions).toEqual(["session-123:B", "session-123:B"]);
    } finally {
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
    activeGraph = staleGraph;
    const observationSpy = spyOn(
      RealObserveScreen,
      "getRecentCachedResultForDevice",
    ).mockReturnValue({
      viewHierarchy: { packageName: "com.apple.Preferences" },
    } as never);

    try {
      const handler = ToolRegistry.getRegisteredTool("getNavigationGraph")?.deviceAwareHandler;

      const response = await handler!(device, { platform: "ios" });

      const result = toolJson(response);
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
    activeGraph = graph;
    // A concurrent hierarchy update marked SpringBoard current.
    const observationSpy = spyOn(
      RealObserveScreen,
      "getRecentCachedResultForDevice",
    ).mockReturnValue({
      viewHierarchy: { packageName: "com.apple.springboard" },
    } as never);

    try {
      const handler = ToolRegistry.getRegisteredTool("getNavigationGraph")?.deviceAwareHandler;

      const response = await handler!(device, {
        platform: "ios",
        appId: "com.apple.reminders",
      });

      const result = toolJson(response);
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
    activeGraph = staleGraph;
    const observationSpy = spyOn(
      RealObserveScreen,
      "getRecentCachedResultForDevice",
    ).mockReturnValue(undefined);

    try {
      const handler = ToolRegistry.getRegisteredTool("getNavigationGraph")?.deviceAwareHandler;

      const response = await handler!(device, { platform: "ios" });

      expect(toolJson(response)).toEqual({
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
    activeGraph = graph;
    const observationSpy = spyOn(
      RealObserveScreen,
      "getRecentCachedResultForDevice",
    ).mockReturnValue({
      viewHierarchy: { packageName: "com.apple.Preferences" },
    } as never);

    try {
      const handler = ToolRegistry.getRegisteredTool("getNavigationGraph")?.deviceAwareHandler;

      const response = await handler!(device, { platform: "ios" });

      expect(toolJson(response)).toMatchObject({
        message: "Navigation graph for app: com.apple.Preferences",
        currentScreen: "iOS Settings",
        nodeCount: 1,
        edgeCount: 0,
        screens: [{ name: "iOS Settings", visitCount: 3 }],
        transitions: [],
      });
    } finally {
      observationSpy.mockRestore();
    }
  });
});

describe("getNavigationGraph over a re-traversed graph (#10194)", () => {
  const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
  const APP = "com.example.app";

  beforeEach(() => {
    ToolRegistry.clearTools();
    setDebugModeEnabled(true);
    registerNavigationTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    setDebugModeEnabled(false);
  });

  test("lists one transition and one edge count for N identical traversal rows", async () => {
    const db = await createTestDatabase();
    const repository = new NavigationRepository({ db });
    const manager = NavigationGraphManager.createForTesting(repository, {
      testCoverageRepository: new TestCoverageRepository({ db }),
    });
    await repository.getOrCreateApp(APP);
    const traversals = Array.from({ length: 10 }, (_, index) => ({
      app_id: APP,
      from_screen: "Home",
      to_screen: "Settings",
      tool_name: "tapOn",
      tool_args: JSON.stringify({ text: "Settings" }),
      timestamp: 1_000 + index,
    }));
    await db.insertInto("navigation_edges").values(traversals).execute();
    const managerSpy = spyOn(NavigationGraphManager, "getInstance").mockReturnValue(manager);

    try {
      const handler = ToolRegistry.getRegisteredTool("getNavigationGraph")!.deviceAwareHandler!;

      const response = await handler(device, { platform: "android", appId: APP });

      const result = toolJson(response);
      expect(result).toMatchObject({ edgeCount: 1, knownEdges: 1, unknownEdges: 0 });
      expect(result.transitions).toEqual([
        { from: "Home", to: "Settings", type: "tool", tool: "tapOn", args: { text: "Settings" } },
      ]);
    } finally {
      managerSpy.mockRestore();
      await db.destroy();
    }
  });
});
