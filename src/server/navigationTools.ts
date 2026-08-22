import { z } from "zod/v4";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { ActionableError, BootedDevice } from "../models";
import { NavigateTo, NavigateToOptions } from "../features/navigation/NavigateTo";
import { NavigationGraphManager } from "../features/navigation/NavigationGraphManager";
import { DefaultPathOptimizer } from "../features/navigation/DefaultPathOptimizer";
import { Explore, ExploreOptions } from "../features/navigation/Explore";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { createJSONToolResponse } from "../utils/toolUtils";
import { Platform } from "../models";
import { addDeviceTargetingToSchema, platformSchema } from "./toolSchemaHelpers";

// Schema definitions
export const navigateToSchema = addDeviceTargetingToSchema(
  z.object({
    targetScreen: z.string().describe("Target screen name"),
    platform: platformSchema.default("android"),
  }),
);

export const getNavigationGraphSchema = addDeviceTargetingToSchema(
  z.object({
    platform: platformSchema.default("android"),
    appId: z
      .string()
      .optional()
      .describe("Scope the graph to this app id instead of the device's current foreground app"),
  }),
);

export const exploreSchema = addDeviceTargetingToSchema(
  z.object({
    maxInteractions: z.number().optional().describe("Max interactions (default: 50)"),
    timeoutMs: z.number().optional().describe("Timeout ms (default: 300000)"),
    strategy: z
      .enum(["breadth-first", "depth-first", "weighted"])
      .optional()
      .describe("Strategy (default: weighted)"),
    resetToHome: z.boolean().optional().describe("Reset to home periodically (default: false)"),
    resetInterval: z.number().optional().describe("Reset interval (default: 15)"),
    mode: z.enum(["discover", "validate", "hybrid"]).optional().describe("Mode (default: hybrid)"),
    packageName: z.string().optional().describe("Package to limit exploration"),
    dryRun: z.boolean().optional().describe("Dry run (no interactions)"),
    platform: platformSchema.default("android"),
  }),
);

// Export interfaces for type safety
export interface NavigateToArgs {
  targetScreen: string;
  platform: Platform;
  sessionUuid?: string;
}

export interface GetNavigationGraphArgs {
  platform: Platform;
  appId?: string;
  sessionUuid?: string;
}

export interface ExploreArgs extends ExploreOptions {
  platform: Platform;
  sessionUuid?: string;
}

function getNavigationManager(sessionUuid?: string): NavigationGraphManager {
  return sessionUuid
    ? NavigationGraphManager.getInstanceForSession(sessionUuid)
    : NavigationGraphManager.getInstance();
}

// Register navigation tools
export function registerNavigationTools() {
  // NavigateTo handler
  const navigateToHandler = async (
    device: BootedDevice,
    args: NavigateToArgs,
    progress?: ProgressCallback,
  ) => {
    try {
      const navigationManager = getNavigationManager(args.sessionUuid);
      const navigateTo = new NavigateTo(
        device,
        undefined,
        null,
        null,
        navigationManager,
        undefined,
        new DefaultPathOptimizer(navigationManager),
        args.sessionUuid,
      );
      const options: NavigateToOptions = {
        targetScreen: args.targetScreen,
        platform: args.platform || "android",
        sessionUuid: args.sessionUuid,
      };
      const result = await navigateTo.execute(options, progress);

      if (result.success) {
        return createJSONToolResponse({
          message: result.message || `Navigated to ${args.targetScreen}`,
          ...result,
        });
      } else {
        return createJSONToolResponse({
          error: result.error || "Navigation failed",
          ...result,
        });
      }
    } catch (error) {
      throw new ActionableError(`Failed to navigate: ${error}`);
    }
  };

  // Get navigation graph handler (for debugging)
  const getNavigationGraphHandler = async (device: BootedDevice, args: GetNavigationGraphArgs) => {
    try {
      const manager = getNavigationManager(args.sessionUuid);
      const observation = RealObserveScreen.getRecentCachedResultForDevice(device.deviceId);
      const observedAppId =
        observation?.viewHierarchy?.packageName ?? observation?.activeWindow?.appId ?? null;
      // An explicit appId scopes the read to the requested app so a concurrent
      // hierarchy update that marks a different app current (e.g. SpringBoard)
      // cannot redirect the query away from the app the caller cares about
      // (issue #4579). Fall back to the device's observed foreground app.
      const requestedAppId = args.appId ?? null;
      const appId = requestedAppId ?? observedAppId;
      const stats = await manager.getStatsForApp(appId);
      const graph = await manager.exportGraphForApp(appId);

      return createJSONToolResponse({
        message: `Navigation graph for app: ${appId || "none"}`,
        requestedAppId,
        observedAppId,
        currentScreen: stats.currentScreen,
        nodeCount: stats.nodeCount,
        edgeCount: stats.edgeCount,
        knownEdges: stats.knownEdgeCount,
        unknownEdges: stats.unknownEdgeCount,
        screens: graph.nodes.map((n) => ({
          name: n.screenName,
          visitCount: n.visitCount,
          lastVisited: new Date(n.lastSeenAt).toISOString(),
        })),
        transitions: graph.edges.map((e) => ({
          from: e.from,
          to: e.to,
          type: e.edgeType,
          tool: e.interaction?.toolName,
          args: e.interaction?.args,
          uiState: e.uiState,
        })),
      });
    } catch (error) {
      throw new ActionableError(`Failed to get navigation graph: ${error}`);
    }
  };

  // Register with the tool registry
  ToolRegistry.registerDeviceAware(
    "navigateTo",
    "Navigate to screen using navigation graph",
    navigateToSchema,
    navigateToHandler,
    { defaultEnabled: false, supportsProgress: true, debugOnly: true, embeddedSdkOnly: true },
  );

  ToolRegistry.registerDeviceAware(
    "getNavigationGraph",
    "Get navigation graph for debugging",
    getNavigationGraphSchema,
    getNavigationGraphHandler,
    { defaultEnabled: false, debugOnly: true, embeddedSdkOnly: true },
  );

  // Explore handler
  const exploreHandler = async (
    device: BootedDevice,
    args: ExploreArgs,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    try {
      const explore = new Explore(
        device,
        null,
        undefined,
        getNavigationManager(args.sessionUuid),
        args.sessionUuid,
      );
      const options: ExploreOptions = {
        maxInteractions: args.maxInteractions,
        timeoutMs: args.timeoutMs,
        strategy: args.strategy,
        resetToHome: args.resetToHome,
        resetInterval: args.resetInterval,
        mode: args.mode,
        packageName: args.packageName,
        dryRun: args.dryRun,
      };
      const result = await explore.execute(options, progress, signal);

      if ("dryRun" in result && result.dryRun) {
        return createJSONToolResponse({
          message: `Exploration dry run completed: ${result.plannedInteractions.length} planned interactions`,
          ...result,
        });
      }

      return createJSONToolResponse({
        message: `Exploration completed: ${result.interactionsPerformed} interactions, ${result.screensDiscovered} new screens discovered, ${result.coverage.percentage}% coverage`,
        ...result,
      });
    } catch (error) {
      throw new ActionableError(`Failed to execute exploration: ${error}`);
    }
  };

  ToolRegistry.registerDeviceAware(
    "explore",
    "Automatically explore app to build navigation graph",
    exploreSchema,
    exploreHandler,
    { defaultEnabled: false, supportsProgress: true, debugOnly: true, embeddedSdkOnly: true },
  );
}
