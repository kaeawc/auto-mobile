import { z } from "zod";
import { ToolRegistry } from "./toolRegistry";
import { ResourceRegistry } from "./resourceRegistry";
import { RESOURCE_URIS } from "./observationResources";
import { ActionableError } from "../models/ActionableError";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { createJSONToolResponse, createStructuredToolResponse, throwIfAborted } from "../utils/toolUtils";
import { BootedDevice, Element, ObserveResult, ViewHierarchyResult } from "../models";
import { createGlobalPerformanceTracker } from "../utils/PerformanceTracker";
import { NavigationGraphManager } from "../features/navigation/NavigationGraphManager";
import { IdentifyInteractions, IdentifyInteractionsOptions } from "../features/observe/IdentifyInteractions";
import { addDeviceTargetingToSchema, platformSchema } from "./toolSchemaHelpers";
import { elementContainerSchema } from "./elementSelectorSchemas";
import { DefaultElementFinder } from "../features/utility/ElementFinder";
import type { ElementFinder } from "../utils/interfaces/ElementFinder";
import { defaultTimer } from "../utils/SystemTimer";
import { consumeSetupTiming } from "./ToolExecutionContext";
import { AndroidCtrlProxyManager } from "../utils/CtrlProxyManager";
import { logger } from "../utils/logger";
import { serverConfig } from "../utils/ServerConfig";
import {
  accessibilityStateSchema,
  activeWindowSchema,
  elementSchema,
  freshnessSchema,
  predictionsSchema,
  screenSizeSchema,
  selectedElementSchema,
  systemInsetsSchema
} from "./toolOutputSchemas";

// Schema definitions
// waitFor accepts elementId OR text directly (oneOf), plus optional timeout and optional container (same shape as tapOn)
const waitForContainerField = elementContainerSchema
  .optional()
  .describe(
    "Scope the match inside this container. Use when resource IDs repeat (e.g. id/name in a RecyclerView)."
  );

const waitForSchema = z.union([
  z.object({
    elementId: z.string().describe("Element resource ID / accessibility identifier"),
    timeout: z.number().optional().describe("Wait timeout ms (default: 5000)"),
    container: waitForContainerField
  }),
  z.object({
    text: z.string().describe("Element text"),
    timeout: z.number().optional().describe("Wait timeout ms (default: 5000)"),
    container: waitForContainerField
  })
]);

export const observeSchema = addDeviceTargetingToSchema(z.object({
  platform: platformSchema,
  waitFor: waitForSchema.optional().describe("Wait for element to appear before returning observation"),
  raw: z.boolean().optional().describe("When true, include unprocessed view hierarchy in response alongside normal output (default: false)"),
  skipBackStack: z.boolean().optional().describe("When true, skip back stack collection during waitFor polling to reduce ADB overhead (default: false)")
}));

const mediaViewSchema = z.object({
  viewId: z.string().optional(),
  className: z.string(),
  mediaType: z.enum(["image", "video", "loading", "mixed"]),
  bounds: z.object({
    left: z.number(),
    top: z.number(),
    right: z.number(),
    bottom: z.number()
  }),
  contentDescription: z.string().optional(),
  resourceId: z.string().optional(),
  sourceUrl: z.string().optional(),
  isLoading: z.boolean().optional()
});

const observeElementsSchema = z.object({
  clickable: z.array(elementSchema),
  scrollable: z.array(elementSchema),
  text: z.array(elementSchema),
  media: z.array(mediaViewSchema)
});

const observeResultSchema = z.object({
  updatedAt: z.union([z.string(), z.number()]),
  screenSize: screenSizeSchema,
  systemInsets: systemInsetsSchema,
  rotation: z.number().int().optional(),
  viewHierarchy: z.any().optional(),
  activeWindow: activeWindowSchema.optional(),
  elements: observeElementsSchema.optional(),
  selectedElements: z.array(selectedElementSchema).optional(),
  focusedElement: elementSchema.optional(),
  accessibilityFocusedElement: elementSchema.optional(),
  intentChooserDetected: z.boolean().optional(),
  notificationPermissionDetected: z.boolean().optional(),
  wakefulness: z.enum(["Awake", "Asleep", "Dozing"]).optional(),
  userId: z.number().int().optional(),
  backStack: z.any().optional(),
  error: z.string().optional(),
  awaitedElement: elementSchema.optional(),
  awaitDuration: z.number().int().optional(),
  awaitTimeout: z.boolean().optional(),
  perfTiming: z.any().optional(),
  perfTimingTruncated: z.boolean().optional(),
  gfxMetrics: z.any().optional(),
  displayedTimeMetrics: z.array(z.any()).optional(),
  performanceAudit: z.any().optional(),
  accessibilityAudit: z.any().optional(),
  freshness: freshnessSchema.optional(),
  recompositionSummary: z.any().optional(),
  predictions: predictionsSchema.optional(),
  accessibilityState: accessibilityStateSchema.optional(),
  rawViewHierarchy: z.any().optional()
}).passthrough();

export const identifyInteractionsSchema = addDeviceTargetingToSchema(z.object({
  platform: platformSchema,
  filter: z.object({
    types: z.array(z.enum(["navigation", "input", "action", "scroll", "toggle"]))
      .optional()
      .describe("Interaction types"),
    minConfidence: z.number().min(0).max(1).optional().describe("Min confidence (0-1)"),
    limit: z.number().int().positive().optional().describe("Max results")
  }).optional().describe("Filter options"),
  includeContext: z.object({
    navigationGraph: z.boolean().optional().describe("Include nav graph predictions"),
    elementDetails: z.boolean().optional().describe("Include element details"),
    suggestedParams: z.boolean().optional().describe("Include tool params")
  }).optional().describe("Context options")
}));

const WAIT_FOR_POLL_INTERVAL_MS = 100;

type ObserveWaitForOptions = z.infer<typeof waitForSchema>;
type ObserveArgs = z.infer<typeof observeSchema>;

const waitForContainerForFinder = (
  waitFor: ObserveWaitForOptions
): { elementId?: string; text?: string } | null => {
  if (!waitFor.container) {
    return null;
  }
  return "elementId" in waitFor.container
    ? { elementId: waitFor.container.elementId }
    : { text: waitFor.container.text };
};

const findWaitForElement = (
  finder: ElementFinder,
  waitFor: ObserveWaitForOptions,
  viewHierarchy: ViewHierarchyResult
): Element | null => {
  const container = waitForContainerForFinder(waitFor);

  if ("elementId" in waitFor) {
    return finder.findElementByResourceId(
      viewHierarchy,
      waitFor.elementId,
      container
    );
  }

  if ("text" in waitFor) {
    return finder.findElementByText(
      viewHierarchy,
      waitFor.text,
      container,
      true,
      false
    );
  }

  return null;
};

const waitForObservation = async (
  observeScreen: ObserveScreen,
  waitFor: ObserveWaitForOptions,
  signal?: AbortSignal,
  skipBackStack: boolean = false
): Promise<{
  observation: ObserveResult;
  awaitedElement?: Element;
  awaitDuration: number;
  awaitTimeout: boolean;
}> => {
  const startTime = defaultTimer.now();
  const timeoutMs = waitFor.timeout ?? 5000;
  const finder = new DefaultElementFinder();
  const queryOptions = {
    text: "text" in waitFor ? waitFor.text : undefined,
    elementId: "elementId" in waitFor ? waitFor.elementId : undefined
  };

  throwIfAborted(signal);
  let observation = await observeScreen.execute(
    queryOptions,
    createGlobalPerformanceTracker(),
    false,
    startTime,
    signal,
    skipBackStack
  );
  let awaitedElement = observation.viewHierarchy
    ? findWaitForElement(finder, waitFor, observation.viewHierarchy)
    : null;

  if (awaitedElement) {
    return {
      observation,
      awaitedElement,
      awaitDuration: defaultTimer.now() - startTime,
      awaitTimeout: false
    };
  }

  if (defaultTimer.now() - startTime >= timeoutMs) {
    return {
      observation,
      awaitDuration: defaultTimer.now() - startTime,
      awaitTimeout: true
    };
  }

  // When overhead is disabled, skip screenshots and back stack during intermediate polls
  // to reduce ADB contention. Trade-off: if the element is found mid-poll, LATEST_SCREENSHOT
  // will reflect the initial observation (before the element appeared), not the exact moment
  // waitFor resolved.
  const skipPollingOverhead = !serverConfig.isWaitForPollingOverheadEnabled();

  while (defaultTimer.now() - startTime < timeoutMs) {
    await defaultTimer.sleep(WAIT_FOR_POLL_INTERVAL_MS);
    throwIfAborted(signal);

    observation = await observeScreen.execute(
      queryOptions,
      createGlobalPerformanceTracker(),
      false,
      startTime,
      signal,
      skipPollingOverhead || skipBackStack,
      skipPollingOverhead
    );
    awaitedElement = observation.viewHierarchy
      ? findWaitForElement(finder, waitFor, observation.viewHierarchy)
      : null;

    if (awaitedElement) {
      return {
        observation,
        awaitedElement,
        awaitDuration: defaultTimer.now() - startTime,
        awaitTimeout: false
      };
    }
  }

  return {
    observation,
    awaitDuration: defaultTimer.now() - startTime,
    awaitTimeout: true
  };
};

// Register tools (this will be called when this file is imported)
export function registerObserveTools() {
  // Observe handler
  const observeHandler = async (device: BootedDevice, args: ObserveArgs, _progress?: unknown, signal?: AbortSignal) => {
    try {
      const observeScreen = new RealObserveScreen(device);
      const waitFor = args.waitFor;
      const waitOutcome = waitFor
        ? await waitForObservation(observeScreen, waitFor, signal, args.skipBackStack ?? false)
        : null;
      const result = waitOutcome
        ? waitOutcome.observation
        : await observeScreen.execute(undefined, createGlobalPerformanceTracker(), true, 0, signal);

      // Validate that the returned hierarchy matches the expected platform.
      // This guards against cross-platform data contamination where an iOS
      // hierarchy could be returned for an Android device (or vice versa).
      if (result.viewHierarchy?.hierarchy) {
        const hierarchy = result.viewHierarchy.hierarchy;
        const isIosHierarchy = hierarchy.type === "XCUIElementTypeApplication"
          || hierarchy.elementType === "application"
          || (typeof hierarchy.bundleId === "string" && !hierarchy.node);
        const isAndroidHierarchy = hierarchy.node !== undefined
          || (hierarchy.$ && hierarchy.$.class);

        if (device.platform === "android" && isIosHierarchy && !isAndroidHierarchy) {
          logger.error(
            `[observe] Platform mismatch: device ${device.deviceId} is Android but received iOS hierarchy. ` +
            `Discarding stale iOS data to prevent cross-platform contamination.`
          );
          result.viewHierarchy = undefined;
          result.error = "Platform mismatch detected: received iOS hierarchy for Android device. " +
            "This may indicate a stale connection. Try calling observe again.";
        } else if (device.platform === "ios" && isAndroidHierarchy && !isIosHierarchy) {
          logger.error(
            `[observe] Platform mismatch: device ${device.deviceId} is iOS but received Android hierarchy. ` +
            `Discarding stale Android data to prevent cross-platform contamination.`
          );
          result.viewHierarchy = undefined;
          result.error = "Platform mismatch detected: received Android hierarchy for iOS device. " +
            "This may indicate a stale connection. Try calling observe again.";
        }
      }

      if (args.raw) {
        await observeScreen.appendRawViewHierarchy(result, signal);
      }

      // Include setup timing if this is the first observe after accessibility service setup
      const setupTiming = consumeSetupTiming(device.deviceId);
      if (setupTiming && result.perfTiming) {
        // Prepend setup timing to the observe timing
        result.perfTiming = [setupTiming, ...result.perfTiming];
      } else if (setupTiming) {
        result.perfTiming = [setupTiming];
      }

      // Record back stack information in navigation graph if available
      if (result.backStack && result.activeWindow?.appId) {
        const navGraph = args.sessionUuid
          ? NavigationGraphManager.getInstanceForSession(args.sessionUuid)
          : NavigationGraphManager.getInstance();
        // Only record if we have a current app and screen
        if (navGraph.getCurrentAppId() === result.activeWindow.appId && navGraph.getCurrentScreen()) {
          navGraph.recordBackStack(result.backStack);
        }
      }

      // If accessibility service reports as disabled, reset setup state to force reinstall on next attempt
      // This handles cases where the service was uninstalled externally
      if (device.platform === "android" && result.accessibilityState?.enabled === false) {
        logger.warn("[observe] Accessibility service not enabled, resetting setup state for next attempt");
        try {
          const manager = AndroidCtrlProxyManager.getInstance(device);
          manager.resetSetupState();
        } catch (error) {
          logger.warn("[observe] Failed to reset accessibility setup state", {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      // Notify MCP clients that observation resources have been updated
      await ResourceRegistry.notifyResourcesUpdated([
        RESOURCE_URIS.LATEST_OBSERVATION,
        RESOURCE_URIS.LATEST_SCREENSHOT
      ]);

      if (waitOutcome) {
        return createStructuredToolResponse({
          ...result,
          awaitedElement: waitOutcome.awaitedElement,
          awaitDuration: waitOutcome.awaitDuration,
          awaitTimeout: waitOutcome.awaitTimeout
        });
      }

      return createStructuredToolResponse(result);
    } catch (error) {
      throw new ActionableError(`Failed to execute observe: ${error}`);
    }
  };

  const identifyInteractionsHandler = async (
    device: BootedDevice,
    args: IdentifyInteractionsOptions
  ) => {
    try {
      const observeScreen = new RealObserveScreen(device);
      const cachedResult = await observeScreen.getMostRecentCachedObserveResult();
      const navigationGraph = args.sessionUuid
        ? NavigationGraphManager.getInstanceForSession(args.sessionUuid)
        : NavigationGraphManager.getInstance();
      const currentScreen = navigationGraph.getCurrentScreen();
      const navigationEdges = args.includeContext?.navigationGraph !== false && currentScreen
        ? await navigationGraph.getEdgesFrom(currentScreen)
        : [];

      const analyzer = new IdentifyInteractions();
      const result = analyzer.analyze(cachedResult, args, currentScreen, navigationEdges);

      return createJSONToolResponse(result);
    } catch (error) {
      throw new ActionableError(`Failed to execute identifyInteractions: ${error}`);
    }
  };

  // Register with the tool registry using the new device-aware method
  ToolRegistry.registerDeviceAware(
    "observe",
    "Get screen view hierarchy",
    observeSchema,
    observeHandler,
    false,
    false,
    { outputSchema: observeResultSchema }
  );

  ToolRegistry.registerDeviceAware(
    "identifyInteractions",
    "Suggest likely interactions",
    identifyInteractionsSchema,
    identifyInteractionsHandler,
    false,
    true
  );
}
