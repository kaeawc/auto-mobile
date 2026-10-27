import {
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
} from "../daemon/wire/constants";
import { toActionableError } from "../models/ActionableError";
import { z } from "zod/v4";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { ActionableError, BootedDevice } from "../models";
import { NavigateTo, NavigateToOptions } from "../features/navigation/NavigateTo";
import {
  NavigationGraphManager,
  type NavigationGraphService,
} from "../features/navigation/NavigationGraphManager";
import { DefaultPathOptimizer } from "../features/navigation/DefaultPathOptimizer";
import { DEFAULT_MAX_INTERACTIONS, Explore, ExploreOptions } from "../features/navigation/Explore";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { throwIfAborted, createJSONToolResponse } from "../utils/toolUtils";
import { Platform } from "../models";
import { addDeviceTargetingToSchema, platformSchema } from "../utils/schemaHelpers";

import { ListInstalledApps } from "../features/observe/ListInstalledApps";
import { getIosInstalledAppBundleId } from "../utils/ios-cmdline-tools/iosInstalledApp";

// Schema definitions
// #6712: `.strict()` on each of these — the advertised schemas already said
// `additionalProperties: false`, but a plain z.object silently DROPPED an
// undeclared caller argument at runtime. Keep platform optional so device
// resolution can select the active or session-bound device.
export const navigateToSchema = addDeviceTargetingToSchema(
  z
    .object({
      targetScreen: z.string().describe("Target screen name"),
      platform: platformSchema.optional(),
    })
    .strict(),
);

export const getNavigationGraphSchema = addDeviceTargetingToSchema(
  z
    .object({
      platform: platformSchema.optional(),
      appId: z
        .string()
        .optional()
        .describe("Scope the graph to this app id instead of the device's current foreground app"),
    })
    .strict(),
);

export const exploreSchema = addDeviceTargetingToSchema(
  z
    .object({
      maxInteractions: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Max interactions (default: ${DEFAULT_MAX_INTERACTIONS})`),
      timeoutMs: z.number().positive().optional().describe("Timeout ms (default: 300000)"),
      strategy: z
        .enum(["breadth-first", "depth-first", "weighted"])
        .optional()
        .describe("Strategy (default: weighted)"),
      resetToHome: z.boolean().optional().describe("Reset to home periodically (default: false)"),
      resetInterval: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Reset interval (default: 15)"),
      mode: z
        .enum(["discover", "validate", "hybrid"])
        .optional()
        .describe("Mode (default: hybrid)"),
      packageName: z.string().optional().describe("Package to limit exploration"),
      dryRun: z.boolean().optional().describe("Dry run (no interactions)"),
      platform: platformSchema.optional(),
    })
    .strict(),
);

// Export interfaces for type safety
export interface NavigateToArgs {
  [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]?: number;
  [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]?: number;
  targetScreen: string;
  platform?: Platform;
  sessionUuid?: string;
}

export interface GetNavigationGraphArgs {
  platform?: Platform;
  appId?: string;
  sessionUuid?: string;
}

export interface ExploreArgs extends ExploreOptions {
  platform?: Platform;
  sessionUuid?: string;
}

/** Resolves the navigation graph for an optional session; injectable so tests pass a fake directly. */
export type NavigationManagerFactory = (sessionUuid?: string) => NavigationGraphService;

const getNavigationManager: NavigationManagerFactory = (sessionUuid) => {
  return sessionUuid
    ? NavigationGraphManager.getInstanceForSession(sessionUuid)
    : NavigationGraphManager.getInstance();
};

// Narrow executor interface for per-handler dependency injection.
export type NavigateToLike = Pick<NavigateTo, "execute">;

function createDefaultNavigateTo(
  device: BootedDevice,
  args: NavigateToArgs,
  navigationManagerFactory: NavigationManagerFactory = getNavigationManager,
): NavigateToLike {
  const navigationManager = navigationManagerFactory(args.sessionUuid);
  return new NavigateTo(device, undefined, {
    navigationManager,
    pathOptimizer: new DefaultPathOptimizer(navigationManager),
    sessionUuid: args.sessionUuid,
  });
}

export interface NavigateToHandlerDependencies {
  navigateToFactory?: (device: BootedDevice, args: NavigateToArgs) => NavigateToLike;
  navigationManagerFactory?: NavigationManagerFactory;
}

export function createNavigateToHandler({
  navigationManagerFactory = getNavigationManager,
  navigateToFactory = (device, args) =>
    createDefaultNavigateTo(device, args, navigationManagerFactory),
}: NavigateToHandlerDependencies = {}) {
  return async (
    device: BootedDevice,
    args: NavigateToArgs,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    try {
      throwIfAborted(signal);
      const navigateTo = navigateToFactory(device, args);
      const options: NavigateToOptions = {
        ...(args[INTERNAL_MCP_REQUEST_TIMEOUT_PARAM] !== undefined
          ? { [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: args[INTERNAL_MCP_REQUEST_TIMEOUT_PARAM] }
          : {}),
        ...(args[INTERNAL_MCP_REQUEST_DEADLINE_PARAM] !== undefined
          ? { [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: args[INTERNAL_MCP_REQUEST_DEADLINE_PARAM] }
          : {}),
        targetScreen: args.targetScreen,
        platform: args.platform || device.platform,
        sessionUuid: args.sessionUuid,
      };
      const result = await navigateTo.execute(options, progress, signal);
      throwIfAborted(signal);

      if (result.success) {
        return createJSONToolResponse({
          message: result.message || `Navigated to ${args.targetScreen}`,
          ...result,
        });
      } else {
        // A failed navigation must not read as a completed one: mark the MCP
        // envelope `isError`, exactly as tapOn/sendKeys do (#6200, #6251).
        return {
          ...createJSONToolResponse({
            error: result.error || "Navigation failed",
            ...result,
          }),
          isError: true as const,
        };
      }
    } catch (error) {
      throwIfAborted(signal);
      throw toActionableError(error, `Failed to navigate`);
    }
  };
}

export const navigateToHandler = createNavigateToHandler();

// Register navigation tools
export interface NavigationToolDependencies extends NavigateToHandlerDependencies {
  installedAppsFactory?: (
    device: BootedDevice,
  ) => Pick<ListInstalledApps, "executeDetailedResult" | "executeIosDetailedResult">;
}

export function registerNavigationTools({
  navigateToFactory,
  navigationManagerFactory = getNavigationManager,
  installedAppsFactory = (device) =>
    new ListInstalledApps(device, undefined, null, { cacheEnabled: false }),
}: NavigationToolDependencies = {}) {
  // Get navigation graph handler (for debugging)
  const getNavigationGraphHandler = async (device: BootedDevice, args: GetNavigationGraphArgs) => {
    try {
      const manager = navigationManagerFactory(args.sessionUuid);
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
      throw toActionableError(error, `Failed to get navigation graph`);
    }
  };

  // Register with the tool registry
  ToolRegistry.registerDeviceAware(
    "navigateTo",
    "Navigate to screen using navigation graph",
    navigateToSchema,
    createNavigateToHandler({ navigateToFactory, navigationManagerFactory }),
    { defaultEnabled: false, supportsProgress: true, embeddedSdkOnly: true },
  );

  ToolRegistry.registerDeviceAware(
    "getNavigationGraph",
    "Get navigation graph for debugging",
    getNavigationGraphSchema,
    getNavigationGraphHandler,
    // Reads only; read-only access never requires a session (#10965).
    { defaultEnabled: false, embeddedSdkOnly: true, deviceReadOnly: true },
  );

  // Explore handler
  const exploreHandler = async (
    device: BootedDevice,
    args: ExploreArgs,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    try {
      const packageName = args.packageName?.trim();
      // Dry runs inspect the current screen without interacting with a target app.
      if (packageName && !args.dryRun) {
        throwIfAborted(signal);
        const list = installedAppsFactory(device);
        const result =
          device.platform === "ios"
            ? await list.executeIosDetailedResult()
            : await list.executeDetailedResult(signal, { namesOnly: true });
        throwIfAborted(signal);
        const apps = Array.isArray(result.apps)
          ? result.apps.map(getIosInstalledAppBundleId)
          : [...Object.values(result.apps.profiles).flat(), ...result.apps.system].map(
              (app) => app.packageName,
            );
        const installed = apps.includes(packageName);
        if (!installed) {
          throw result.successful
            ? new ActionableError(
                `Package not installed: ${packageName}. Install the app before exploring it.`,
              )
            : new ActionableError(
                `Could not confirm that ${packageName} is installed: the installed-app listing was incomplete. Retry the installed-app listing.`,
                { cause: result.error },
              );
        }
      }
      const explore = new Explore(
        device,
        null,
        undefined,
        navigationManagerFactory(args.sessionUuid),
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

      if ("dryRun" in result) {
        return createJSONToolResponse({
          message: `Exploration dry run completed: ${result.plannedInteractions.length} planned interactions`,
          ...result,
        });
      }

      const completion = result.stopReason?.startsWith("Left target app (")
        ? `Exploration stopped: ${result.stopReason}.`
        : "Exploration completed:";
      return createJSONToolResponse({
        message: `${completion} ${result.interactionsPerformed} interactions, ${result.screensDiscovered} new screens discovered, ${result.coverage.percentage}% coverage`,
        ...result,
      });
    } catch (error) {
      throw toActionableError(error, `Failed to execute exploration`);
    }
  };

  ToolRegistry.registerDeviceAware(
    "explore",
    "Automatically explore app to build navigation graph",
    exploreSchema,
    exploreHandler,
    { defaultEnabled: false, supportsProgress: true, embeddedSdkOnly: true },
  );
}
