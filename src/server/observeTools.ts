import { z } from "zod";
import { ToolRegistry } from "./toolRegistry";
import { ResourceRegistry } from "./resourceRegistry";
import { RESOURCE_URIS } from "./observationResources";
import { ActionableError } from "../models/ActionableError";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import type { ObserveScreen } from "../features/observe/interfaces/ObserveScreen";
import { createJSONToolResponse, createStructuredToolResponse, throwIfAborted, StructuredToolResponse } from "../utils/toolUtils";
import { BootedDevice, Element, ObserveResult, ObserveToolPayload, ViewHierarchyResult } from "../models";
import { createGlobalPerformanceTracker } from "../utils/PerformanceTracker";
import { NavigationGraphManager } from "../features/navigation/NavigationGraphManager";
import { IdentifyInteractions, IdentifyInteractionsOptions } from "../features/observe/IdentifyInteractions";
import { addDeviceTargetingToSchema, platformSchema } from "./toolSchemaHelpers";
import { elementContainerSchema } from "./elementSelectorSchemas";
import { observeResultSchema } from "./toolOutputSchemas";
import { DefaultElementFinder } from "../features/utility/ElementFinder";
import { DefaultElementParser } from "../features/utility/ElementParser";
import { normalizeQuotes } from "../features/utility/TextMatcher";
import type { ElementFinder } from "../utils/interfaces/ElementFinder";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { consumeSetupTiming } from "./ToolExecutionContext";
import { AndroidCtrlProxyManager } from "../utils/CtrlProxyManager";
import { logger } from "../utils/logger";
import { serverConfig } from "../utils/ServerConfig";

// Schema definitions
// waitFor accepts legacy selectors plus richer predicates. Element predicates are
// evaluated against the same node unless matchType is explicitly "any".
const waitForContainerField = elementContainerSchema
  .optional()
  .describe(
    "Scope match to a container"
  );

const activeWindowWaitForBaseSchema = z.object({
  appId: z.string().optional().describe("Foreground app bundle ID / package name"),
  activityName: z.string().optional().describe("Foreground Android activity name")
}).strict();

const activeWindowWaitForSchema = activeWindowWaitForBaseSchema.and(z.union([
  z.object({ appId: z.string() }),
  z.object({ activityName: z.string() }),
]));

const waitForBaseSchema = z.object({
  elementId: z.string().optional().describe("Element resource ID / accessibility identifier"),
  text: z.string().optional().describe("Element text"),
  textAny: z.array(z.string().min(1)).min(1).optional().describe("Ordered text variants; first visible match wins"),
  className: z.string().optional().describe("Element class name"),
  contentDescription: z.string().optional().describe("Element content description / accessibility label"),
  activeWindow: activeWindowWaitForSchema.optional().describe("Foreground app/window predicates"),
  matchType: z.enum(["all", "any"]).optional().describe("Whether element predicates must all match the same node or any one may match"),
  textMatch: z.enum(["exact", "contains", "regex"]).optional().describe("How to match text predicates"),
  timeout: z.number().optional().describe("Wait timeout ms (default: 5000)"),
  container: waitForContainerField
}).strict().superRefine((value, ctx) => {
  const hasElementPredicate =
    value.elementId !== undefined ||
    value.text !== undefined ||
    value.textAny !== undefined ||
    value.className !== undefined ||
    value.contentDescription !== undefined;
  if (!hasElementPredicate && value.activeWindow === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide at least one waitFor predicate"
    });
  }

  if (
    value.textAny !== undefined &&
    (
      value.elementId !== undefined ||
      value.text !== undefined ||
      value.className !== undefined ||
      value.contentDescription !== undefined ||
      value.textMatch !== undefined ||
      value.matchType !== undefined
    )
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "textAny cannot be combined with element field predicates"
    });
  }

  if (value.textMatch === "regex" && value.text !== undefined) {
    try {
      new RegExp(value.text);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "text must be a valid regular expression when textMatch is regex"
      });
    }
  }
});

const waitForPredicatePresenceSchema = z.union([
  z.object({ elementId: z.string() }),
  z.object({ text: z.string() }),
  z.object({ textAny: z.array(z.string().min(1)).min(1) }),
  z.object({ className: z.string() }),
  z.object({ contentDescription: z.string() }),
  z.object({ activeWindow: activeWindowWaitForSchema }),
]);

const waitForSchema = waitForBaseSchema.and(waitForPredicatePresenceSchema);

export const observeSchema = addDeviceTargetingToSchema(z.object({
  platform: platformSchema,
  waitFor: waitForSchema.optional().describe("Wait for element to appear before returning observation"),
  raw: z.boolean().optional().describe("Include raw view hierarchy"),
  skipBackStack: z.boolean().optional().describe("Skip back stack during waitFor polling")
}));

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

const isElementCenterOffScreen = (
  element: Element,
  viewHierarchy: ViewHierarchyResult
): boolean => {
  if (!viewHierarchy.screenWidth || !viewHierarchy.screenHeight || !element.bounds) {
    return false;
  }

  const centerX = (element.bounds.left + element.bounds.right) / 2;
  const centerY = (element.bounds.top + element.bounds.bottom) / 2;
  return centerX < 0 || centerX > viewHierarchy.screenWidth ||
    centerY < 0 || centerY > viewHierarchy.screenHeight;
};

export const findWaitForElement = (
  finder: ElementFinder,
  waitFor: ObserveWaitForOptions,
  viewHierarchy: ViewHierarchyResult
): Element | null => {
  const container = waitForContainerForFinder(waitFor);

  if (waitFor.elementId !== undefined && !hasRichElementPredicate(waitFor)) {
    return finder.findElementByResourceId(
      viewHierarchy,
      waitFor.elementId,
      container
    );
  }

  if (waitFor.text !== undefined && !hasRichElementPredicate(waitFor)) {
    return finder.findElementByText(
      viewHierarchy,
      waitFor.text,
      container,
      true,
      false
    );
  }

  if (waitFor.textAny !== undefined) {
    for (const text of waitFor.textAny) {
      const elements = finder.findElementsByText(
        viewHierarchy,
        text,
        container,
        true,
        false
      );
      const element = elements.find(candidate => !isElementCenterOffScreen(candidate, viewHierarchy));
      if (element) {
        return element;
      }
    }
  }

  if (!hasElementPredicate(waitFor)) {
    return null;
  }

  return findRichWaitForElement(finder, waitFor, viewHierarchy);
};

const hasElementPredicate = (waitFor: ObserveWaitForOptions): boolean =>
  waitFor.elementId !== undefined ||
  waitFor.text !== undefined ||
  waitFor.textAny !== undefined ||
  waitFor.className !== undefined ||
  waitFor.contentDescription !== undefined;

const hasRichElementPredicate = (waitFor: ObserveWaitForOptions): boolean =>
  waitFor.className !== undefined ||
  waitFor.contentDescription !== undefined ||
  waitFor.matchType !== undefined ||
  waitFor.textMatch !== undefined ||
  (
    waitFor.elementId !== undefined &&
    waitFor.text !== undefined
  );

const parser = new DefaultElementParser();

const collectCandidateElements = (
  finder: ElementFinder,
  waitFor: ObserveWaitForOptions,
  viewHierarchy: ViewHierarchyResult
): Element[] => {
  const container = waitForContainerForFinder(waitFor);
  const containerNode = container
    ? finder.findContainerNode(viewHierarchy, container)
    : null;
  if (container && !containerNode) {
    return [];
  }

  const roots = containerNode
    ? [containerNode]
    : [
      ...parser.extractRootNodes(viewHierarchy),
      ...parser.extractWindowRootNodes(viewHierarchy, "topmost-first")
    ];
  const elements: Element[] = [];
  for (const root of roots) {
    parser.traverseNode(root, node => {
      const element = parser.parseNodeBounds(node);
      if (element) {
        elements.push(element);
      }
    });
  }
  return elements;
};

const getClassName = (element: Element): string | undefined =>
  typeof element.class === "string"
    ? element.class
    : typeof element.className === "string"
      ? element.className
      : undefined;

const getContentDescription = (element: Element): string | undefined =>
  typeof element["content-desc"] === "string"
    ? element["content-desc"]
    : typeof element["ios-accessibility-label"] === "string"
      ? element["ios-accessibility-label"]
      : typeof element.contentDescription === "string"
        ? element.contentDescription
        : typeof element.accessibilityLabel === "string"
          ? element.accessibilityLabel
          : undefined;

const textFieldsForElement = (element: Element): string[] => [
  element.text,
  element["content-desc"],
  element["ios-accessibility-label"],
].filter((value): value is string => typeof value === "string");

const matchesString = (
  actual: string | undefined,
  expected: string,
  matchMode: "exact" | "contains" | "regex" = "contains"
): boolean => {
  if (actual === undefined) {
    return false;
  }

  if (matchMode === "regex") {
    return new RegExp(expected, "i").test(actual);
  }

  const normalizedActual = normalizeQuotes(actual).toLowerCase();
  const normalizedExpected = normalizeQuotes(expected).toLowerCase();
  return matchMode === "exact"
    ? normalizedActual === normalizedExpected
    : normalizedActual.includes(normalizedExpected);
};

const matchesTextPredicate = (element: Element, waitFor: ObserveWaitForOptions): boolean => {
  if (waitFor.text === undefined) {
    return false;
  }
  return textFieldsForElement(element).some(text => matchesString(text, waitFor.text!, waitFor.textMatch ?? "contains"));
};

const elementPredicateResults = (
  element: Element,
  waitFor: ObserveWaitForOptions
): boolean[] => {
  const results: boolean[] = [];
  if (waitFor.elementId !== undefined) {
    results.push(element["resource-id"] === waitFor.elementId);
  }
  if (waitFor.text !== undefined) {
    results.push(matchesTextPredicate(element, waitFor));
  }
  if (waitFor.className !== undefined) {
    results.push(getClassName(element) === waitFor.className);
  }
  if (waitFor.contentDescription !== undefined) {
    results.push(matchesString(getContentDescription(element), waitFor.contentDescription, "exact"));
  }
  return results;
};

const findRichWaitForElement = (
  finder: ElementFinder,
  waitFor: ObserveWaitForOptions,
  viewHierarchy: ViewHierarchyResult
): Element | null => {
  const candidates = collectCandidateElements(finder, waitFor, viewHierarchy)
    .filter(candidate => !isElementCenterOffScreen(candidate, viewHierarchy));
  const matchType = waitFor.matchType ?? "all";

  for (const candidate of candidates) {
    const results = elementPredicateResults(candidate, waitFor);
    if (results.length === 0) {
      continue;
    }
    const matched = matchType === "any"
      ? results.some(Boolean)
      : results.every(Boolean);
    if (matched) {
      return candidate;
    }
  }

  return null;
};

const matchesActiveWindow = (
  observation: ObserveResult,
  waitFor: ObserveWaitForOptions
): boolean => {
  if (!waitFor.activeWindow) {
    return true;
  }

  const activeWindow = observation.activeWindow;
  if (!activeWindow) {
    return false;
  }

  if (waitFor.activeWindow.appId !== undefined && activeWindow.appId !== waitFor.activeWindow.appId) {
    return false;
  }

  if (waitFor.activeWindow.activityName !== undefined && activeWindow.activityName !== waitFor.activeWindow.activityName) {
    return false;
  }

  return true;
};

const evaluateWaitForObservation = (
  finder: ElementFinder,
  waitFor: ObserveWaitForOptions,
  observation: ObserveResult
): { matched: boolean; awaitedElement?: Element } => {
  const activeWindowMatched = matchesActiveWindow(observation, waitFor);
  const needsElementMatch = hasElementPredicate(waitFor);
  const awaitedElement = needsElementMatch && observation.viewHierarchy
    ? findWaitForElement(finder, waitFor, observation.viewHierarchy)
    : null;

  return {
    matched: activeWindowMatched && (!needsElementMatch || awaitedElement !== null),
    awaitedElement: awaitedElement ?? undefined
  };
};

export const waitForObservation = async (
  observeScreen: ObserveScreen,
  waitFor: ObserveWaitForOptions,
  signal?: AbortSignal,
  skipBackStack: boolean = false,
  timer: Timer = defaultTimer
): Promise<{
  observation: ObserveResult;
  awaitedElement?: Element;
  awaitDuration: number;
  awaitTimeout: boolean;
}> => {
  const startTime = timer.now();
  const timeoutMs = waitFor.timeout ?? 5000;
  const finder = new DefaultElementFinder();
  const queryOptions = {
    text: waitFor.text ?? waitFor.textAny?.[0] ?? waitFor.contentDescription,
    elementId: waitFor.elementId
  };

  // When overhead is disabled, skip screenshots and back stack during ALL waitFor
  // observations (including the initial one) to reduce ADB contention. This prevents
  // slow back stack fetches (dumpsys activity) and screenshots (screencap) from
  // consuming the timeout budget. Trade-off: LATEST_SCREENSHOT will not reflect the
  // exact screen state when waitFor resolved.
  const skipPollingOverhead = !serverConfig.isWaitForPollingOverheadEnabled();

  throwIfAborted(signal);
  let observation = await observeScreen.execute({
    queryOptions,
    perf: createGlobalPerformanceTracker(),
    skipWaitForFresh: false,
    minTimestamp: startTime,
    signal,
    skipBackStack: skipPollingOverhead || skipBackStack,
    skipScreenshot: skipPollingOverhead,
  });
  let waitEvaluation = evaluateWaitForObservation(finder, waitFor, observation);

  if (waitEvaluation.matched) {
    return {
      observation,
      awaitedElement: waitEvaluation.awaitedElement,
      awaitDuration: timer.now() - startTime,
      awaitTimeout: false
    };
  }

  if (timer.now() - startTime >= timeoutMs) {
    return {
      observation,
      awaitDuration: timer.now() - startTime,
      awaitTimeout: true
    };
  }

  while (timer.now() - startTime < timeoutMs) {
    await timer.sleep(WAIT_FOR_POLL_INTERVAL_MS);
    throwIfAborted(signal);

    observation = await observeScreen.execute({
      queryOptions,
      perf: createGlobalPerformanceTracker(),
      skipWaitForFresh: false,
      minTimestamp: startTime,
      signal,
      skipBackStack: skipPollingOverhead || skipBackStack,
      skipScreenshot: skipPollingOverhead,
    });
    waitEvaluation = evaluateWaitForObservation(finder, waitFor, observation);

    if (waitEvaluation.matched) {
      return {
        observation,
        awaitedElement: waitEvaluation.awaitedElement,
        awaitDuration: timer.now() - startTime,
        awaitTimeout: false
      };
    }
  }

  return {
    observation,
    awaitDuration: timer.now() - startTime,
    awaitTimeout: true
  };
};

// Register tools (this will be called when this file is imported)
export function registerObserveTools() {
  // Observe handler
  const observeHandler = async (device: BootedDevice, args: ObserveArgs, _progress?: unknown, signal?: AbortSignal): Promise<StructuredToolResponse<ObserveToolPayload>> => {
    try {
      const observeScreen = new RealObserveScreen(device);
      const waitFor = args.waitFor;
      // ObserveScreen.execute() rejects stale cross-platform hierarchies at the
      // source, so every observation reaching here is already platform-validated
      // (raw-mode append below is likewise gated on a validated primary hierarchy).
      const waitOutcome = waitFor
        ? await waitForObservation(observeScreen, waitFor, signal, args.skipBackStack ?? false)
        : null;
      const result = waitOutcome
        ? waitOutcome.observation
        : await observeScreen.execute({ perf: createGlobalPerformanceTracker(), skipWaitForFresh: true, signal });

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

  // Register with the tool registry using the new device-aware method.
  // Advertise a machine-readable `ObserveResult` outputSchema (issue #3025) so
  // observe's hierarchy/window/element bounds — the bulk of compacted bounds —
  // are described on the wire, and so its `bounds` fields route through
  // `elementBoundsSchema` (the `--observe-result-compact` tuple is flag-advertised
  // via `advertiseBoundsForCompact` in `getToolDefinitions`). Composes with
  // `--tool-results-no-structured-content`, which suppresses the advertisement.
  ToolRegistry.registerDeviceAware(
    "observe",
    "Get screen view hierarchy",
    observeSchema,
    observeHandler,
    { outputSchema: observeResultSchema }
  );

  ToolRegistry.registerDeviceAware("identifyInteractions", "Suggest likely interactions", identifyInteractionsSchema, identifyInteractionsHandler, { debugOnly: true });
}
