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
import { addDeviceTargetingToSchema, platformSchema, withAppIdAliases, withJsonSchemaOverride } from "./toolSchemaHelpers";
import { elementContainerSchema } from "./elementSelectorSchemas";
import { observeToolResultSchema } from "./toolOutputSchemas";
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

const publicActiveWindowAppIdAliases = ["packageName", "bundleId"] as const;

const appIdAliasShape = {
  packageName: z.string().optional(),
  bundleId: z.string().optional(),
};

const appIdPresenceBranches = [
  z.object({ appId: z.string() }).passthrough(),
  ...publicActiveWindowAppIdAliases.map(alias => z.object({ [alias]: z.string() }).passthrough())
];

const activeWindowWaitForBaseSchema = z.object({
  appId: z.string().optional().describe("Foreground app bundle ID / package name"),
  ...appIdAliasShape,
  activityName: z.string().optional().describe("Foreground Android activity name")
}).strict();

const activeWindowWaitForSchema = activeWindowWaitForBaseSchema.and(z.union([
  ...appIdPresenceBranches,
  z.object({ activityName: z.string() }).passthrough(),
]));

const waitForCommonShape = {
  activeWindow: activeWindowWaitForSchema.optional().describe("Foreground app/window predicates"),
  timeout: z.number().optional().describe("Wait timeout ms (default: 5000)"),
  container: waitForContainerField
};

const waitForTextAnySchema = z.object({
  textAny: z.array(z.string().min(1)).min(1).describe("Ordered text variants; first visible match wins"),
  elementId: z.never().optional(),
  text: z.never().optional(),
  className: z.never().optional(),
  contentDescription: z.never().optional(),
  matchType: z.never().optional(),
  textMatch: z.never().optional(),
  ...waitForCommonShape,
}).strict();

const waitForElementBaseSchema = z.object({
  elementId: z.string().optional().describe("Element resource ID / accessibility identifier"),
  text: z.string().optional().describe("Element text"),
  textAny: z.never().optional(),
  className: z.string().optional().describe("Element class name"),
  contentDescription: z.string().optional().describe("Element content description / accessibility label"),
  matchType: z.enum(["all", "any"]).optional().describe("Whether element predicates must all match the same node or any one may match"),
  textMatch: z.enum(["exact", "contains", "regex"]).optional().describe("How to match waitFor.text; does not affect contentDescription"),
  ...waitForCommonShape,
}).strict().superRefine((value, ctx) => {

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
  z.object({ elementId: z.string() }).passthrough(),
  z.object({ text: z.string() }).passthrough(),
  z.object({ className: z.string() }).passthrough(),
  z.object({ contentDescription: z.string() }).passthrough(),
  z.object({ activeWindow: activeWindowWaitForSchema }).passthrough(),
]);

const waitForElementSchema = waitForElementBaseSchema.and(waitForPredicatePresenceSchema);

const waitForSchema = z.union([
  waitForTextAnySchema,
  waitForElementSchema,
]);

// Compact advertised JSON schema for `waitFor` (issue: observe input schema
// bloat). The runtime zod `waitForSchema` above stays the source of truth for
// validation — its union/intersection/presence machinery expands to ~2k tokens
// in `tools/list`, which the agent does not need. This flat object advertises
// the same fields + guidance at ~1/4 the token cost; it is swapped in via the
// observe json-schema override below and never used for validation.
// Presence options shared by the two branches below.
const ELEMENT_PREDICATE_REQUIRED = [
  { required: ["elementId"] },
  { required: ["text"] },
  { required: ["className"] },
  { required: ["contentDescription"] },
];
const COMPACT_WAITFOR_ADVERTISED_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  description:
    "Wait for a predicate before returning the observation. Provide at least one of: " +
    "elementId, text, textAny, className, contentDescription, or activeWindow. " +
    "textAny is mutually exclusive with the element predicates.",
  properties: {
    elementId: { type: "string", description: "Element resource ID / accessibility identifier" },
    text: { type: "string", description: "Element text" },
    textAny: {
      type: "array",
      items: { type: "string" },
      description: "Ordered text variants; first visible match wins",
    },
    className: { type: "string", description: "Element class name" },
    contentDescription: {
      type: "string",
      description: "Element content description / accessibility label",
    },
    matchType: {
      type: "string",
      enum: ["all", "any"],
      description: "Whether element predicates must all match one node, or any one may match",
    },
    textMatch: {
      type: "string",
      enum: ["exact", "contains", "regex"],
      description: "How to match waitFor.text; does not affect contentDescription",
    },
    activeWindow: {
      type: "object",
      additionalProperties: false,
      description: "Foreground app/window predicates (provide an app id or activityName)",
      properties: {
        appId: { type: "string", description: "Foreground app bundle ID / package name" },
        packageName: { type: "string", description: "Alias for appId (Android package name)" },
        bundleId: { type: "string", description: "Alias for appId (iOS bundle ID)" },
        activityName: {
          type: "string",
          description: "Foreground Android activity name (Android-only)",
        },
      },
      anyOf: [
        { required: ["appId"] },
        { required: ["packageName"] },
        { required: ["bundleId"] },
        { required: ["activityName"] },
      ],
    },
    container: {
      type: "object",
      description: "Scope the match to a container element (by elementId or text)",
      properties: { elementId: { type: "string" }, text: { type: "string" } },
    },
    timeout: { type: "number", description: "Wait timeout ms (default 5000)" },
  },
  // Enforce the same shape the runtime does: at least one predicate, and textAny
  // mutually exclusive with the element predicates / matchType / textMatch.
  anyOf: [
    {
      required: ["textAny"],
      not: {
        anyOf: [...ELEMENT_PREDICATE_REQUIRED, { required: ["matchType"] }, { required: ["textMatch"] }],
      },
    },
    {
      not: { required: ["textAny"] },
      anyOf: [...ELEMENT_PREDICATE_REQUIRED, { required: ["activeWindow"] }],
    },
  ],
};

const observeBaseSchema = withJsonSchemaOverride(addDeviceTargetingToSchema(z.object({
  platform: platformSchema,
  waitFor: waitForSchema.optional().describe("Wait for element to appear before returning observation"),
  raw: z.boolean().optional().describe("Include raw view hierarchy"),
  project: z.enum(["full", "skeleton"]).optional().describe(
    "Output projection. 'full' (default) returns the whole view hierarchy; " +
    "'skeleton' returns a flat, actionable-only list (id/label/bounds/affordances) " +
    "in place of viewHierarchy/elements. Each skeleton id/label is directly usable " +
    "as a tapOn selector; re-request with raw/project:'full' to disambiguate."
  ),
  skipBackStack: z.boolean().optional().describe("Skip back stack during waitFor polling")
})).superRefine((value, ctx) => {
  const activeWindow = value.waitFor?.activeWindow;
  if (
    value.platform === "ios" &&
    activeWindow?.activityName !== undefined &&
    activeWindow.appId === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["waitFor", "activeWindow", "activityName"],
      message: "activityName is Android-only; use appId/bundleId on iOS"
    });
  }
}), jsonSchema => {
  jsonSchema.if = {
    required: ["platform", "waitFor"],
    properties: {
      platform: { const: "ios" },
      waitFor: {
        required: ["activeWindow"],
        properties: {
          activeWindow: {
            required: ["activityName"],
            not: {
              anyOf: [
                { required: ["appId"] },
                { required: ["bundleId"] },
                { required: ["packageName"] }
              ]
            }
          }
        }
      }
    }
  };
  jsonSchema.then = false;

  // Replace the verbose generated `waitFor` schema with the compact advertised
  // form. Runtime validation still uses the full zod `waitForSchema`; this only
  // shrinks what `tools/list` carries (~2064 -> ~473 tokens). The `if`/`then`
  // above evaluates against the request data, not this schema, so it is
  // unaffected.
  const props = jsonSchema.properties as Record<string, unknown> | undefined;
  if (props && props.waitFor) {
    props.waitFor = COMPACT_WAITFOR_ADVERTISED_SCHEMA;
  }
});

export const observeSchema = withAppIdAliases(observeBaseSchema);

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
  viewHierarchy: ViewHierarchyResult,
  platform?: BootedDevice["platform"]
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

  return findRichWaitForElement(finder, waitFor, viewHierarchy, platform);
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
    : undefined;

const getContentDescription = (element: Element, platform?: BootedDevice["platform"]): string | undefined =>
  typeof element["content-desc"] === "string"
    ? element["content-desc"]
    : typeof element["ios-accessibility-label"] === "string"
      ? element["ios-accessibility-label"]
      : platform === "ios" && typeof element.text === "string"
        ? element.text
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
  waitFor: ObserveWaitForOptions,
  platform?: BootedDevice["platform"]
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
    results.push(matchesString(getContentDescription(element, platform), waitFor.contentDescription, "exact"));
  }
  return results;
};

const findRichWaitForElement = (
  finder: ElementFinder,
  waitFor: ObserveWaitForOptions,
  viewHierarchy: ViewHierarchyResult,
  platform?: BootedDevice["platform"]
): Element | null => {
  const candidates = collectCandidateElements(finder, waitFor, viewHierarchy)
    .filter(candidate => !isElementCenterOffScreen(candidate, viewHierarchy));
  const matchType = waitFor.matchType ?? "all";

  for (const candidate of candidates) {
    const results = elementPredicateResults(candidate, waitFor, platform);
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
  waitFor: ObserveWaitForOptions,
  platform?: BootedDevice["platform"]
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

  if (
    platform === "ios" &&
    waitFor.activeWindow.activityName !== undefined &&
    waitFor.activeWindow.appId === undefined
  ) {
    return false;
  }

  if (
    platform !== "ios" &&
    waitFor.activeWindow.activityName !== undefined &&
    activeWindow.activityName !== waitFor.activeWindow.activityName
  ) {
    return false;
  }

  return true;
};

const evaluateWaitForObservation = (
  finder: ElementFinder,
  waitFor: ObserveWaitForOptions,
  observation: ObserveResult,
  platform?: BootedDevice["platform"]
): { matched: boolean; awaitedElement?: Element } => {
  const activeWindowMatched = matchesActiveWindow(observation, waitFor, platform);
  const needsElementMatch = hasElementPredicate(waitFor);
  const awaitedElement = needsElementMatch && observation.viewHierarchy
    ? findWaitForElement(finder, waitFor, observation.viewHierarchy, platform)
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
  timer: Timer = defaultTimer,
  platform?: BootedDevice["platform"]
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
  let waitEvaluation = evaluateWaitForObservation(finder, waitFor, observation, platform);

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
    waitEvaluation = evaluateWaitForObservation(finder, waitFor, observation, platform);

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
        ? await waitForObservation(observeScreen, waitFor, signal, args.skipBackStack ?? false, defaultTimer, device.platform)
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
    { outputSchema: observeToolResultSchema }
  );

  ToolRegistry.registerDeviceAware("identifyInteractions", "Suggest likely interactions", identifyInteractionsSchema, identifyInteractionsHandler, { debugOnly: true });
}
