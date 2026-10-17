import { readObservationForInteractions } from "./identifyInteractionsObservation";
import { toActionableError } from "../models/ActionableError";
import { errorMessage } from "../utils/describeUnknownError";
import { displayWaitInventory } from "../utils/deviceMatcher";
import { z } from "zod/v4";
import {
  screenshotOptionsSchema,
  type ObserveScreenshotOptions,
} from "../features/observe/screenshot/screenshotOptions";
import { ToolRegistry } from "./toolRegistry";
import { stripInternalToolParams } from "./internalToolParams";
import { isSessionlessDeviceRead } from "../features/toolSelection/toolSelectionContext";
import { sessionlessDeviceReadFor } from "./deviceObservationAccess";
import { ResourceRegistry } from "./resourceRegistry";
import { RESOURCE_URIS } from "./observationResources";
import { OBSERVE_APP_RESOURCE_URI } from "./observeAppResource";
import { ActionableError } from "../models/ActionableError";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import type { ObserveScreen } from "../features/observe/interfaces/ObserveScreen";
import { createJSONToolResponse } from "../utils/toolUtils";
import { BootedDevice, ObserveResult } from "../models";
import { createGlobalPerformanceTracker } from "../utils/PerformanceTracker";
import { NavigationGraphManager } from "../features/navigation/NavigationGraphManager";
import {
  IdentifyInteractions,
  IdentifyInteractionsOptions,
} from "../features/observe/IdentifyInteractions";
import {
  addDeviceTargetingToSchema,
  platformSchema,
  withAppIdAliases,
  withJsonSchemaOverride,
} from "./toolSchemaHelpers";
import { hierarchyLayerSchema, nestedElementContainerSchema } from "./elementSelectorSchemas";
import {
  scopeHierarchyForSelector,
  scopeObserveResultToLayer,
} from "../features/observe/hierarchyLayer";
import { observeToolResultSchema } from "./toolOutputSchemas";
import { defaultTimer } from "../utils/SystemTimer";
import { consumeSetupTiming } from "./ToolExecutionContext";
import { AndroidCtrlProxyManager } from "../ctrlProxy/CtrlProxyManager";
import { accessibilityDetector } from "../features/accessibility/AccessibilityDetector";
import type { AccessibilityDetector } from "../features/accessibility/interfaces/AccessibilityDetector";
import { DaemonState } from "../daemon/daemonState";
import { logger } from "../utils/logger";
import { type ScreenshotMode } from "../features/observe/automaticScreenshotPolicy";
import { observeCropSchema } from "../features/observe/screenshot/observeCrop";
import { waitForObservation } from "../features/observe/wait/WaitEvaluation";

import {
  overrideWaitForJsonSchema,
  refineWaitForArgs,
  settledSchema,
  waitForSchema,
} from "../features/observe/wait/WaitForSchemas";

// The waitFor / settled schemas live in ../features/observe/wait/WaitForSchemas (#11828); these names stay
// importable from here.
export {
  assertActiveWindowWaitForSupportedOnPlatform,
  overrideWaitForJsonSchema,
  refineWaitForArgs,
  settledSchema,
  waitForSchema,
  type ObserveWaitForOptions,
  type SettledOptions,
  type WaitForConditionDsl,
  type WaitForConditionKind,
  type WaitForWithSettled,
} from "../features/observe/wait/WaitForSchemas";

import {
  attachObserveCrop,
  attachSnapshotReference,
  createObserveResponse,
  createObserveWaitResponse,
  layerScopedObserveResult,
  observeScreenshotOptions,
  prepareObserveOptions,
  recordObservationBackStack,
  screenForObserve,
  type ObserveResponse,
  type ObserveToolDependencies,
} from "./observeResponse";

// The waitFor / settle evaluation lives in ../features/observe/wait/WaitEvaluation (#11828); these names stay
// importable from here.
export {
  buildConditionPredicate,
  findWaitForElement,
  hashHierarchyForSettle,
  waitForObservation,
  type WaitForObservationOutcome,
} from "../features/observe/wait/WaitEvaluation";

// Progressive-disclosure scoping of the returned hierarchy (issue #4344). The
// agent picks where to zoom on THIS screen, so region/anchor are per-call inputs
// (not env). Every dimension is always honored when requested — the focus /
// region / overview scoping is on by default and applies only when a call sets
// the matching `scope` field.
const legacyObserveFocusObjectSchema = z.object({
  resourceId: z.string().optional().describe("Anchor by exact resource-id"),
  text: z.string().optional().describe("Anchor by substring text match"),
});
const routedLegacyObserveFocusSchema = withJsonSchemaOverride(
  legacyObserveFocusObjectSchema
    .extend({ elementId: z.never().optional(), container: z.never().optional() })
    .refine((value) => !("elementId" in value || "container" in value)),
  (schema) => {
    const properties = schema.properties as Record<string, unknown>;
    delete properties.elementId;
    delete properties.container;
    schema.not = { anyOf: [{ required: ["elementId"] }, { required: ["container"] }] };
    schema.additionalProperties = true;
  },
);
const observeScopeFocusSchema = z
  .preprocess(
    (value, ctx) => {
      const cleanValue = stripInternalToolParams(value);
      const nested =
        cleanValue !== null &&
        typeof cleanValue === "object" &&
        ("elementId" in cleanValue || "container" in cleanValue);
      const parsed = (
        nested
          ? nestedElementContainerSchema
          : z.union([z.boolean(), legacyObserveFocusObjectSchema])
      ).safeParse(cleanValue);
      if (!parsed.success) {
        // Abort before the permissive legacy arm can consume an invalid nested selector.
        ctx.issues.push(...parsed.error.issues.map((issue) => ({ ...issue, continue: false })));
        return z.NEVER;
      }
      return parsed.data;
    },
    z.union([z.boolean(), routedLegacyObserveFocusSchema, nestedElementContainerSchema]),
  )
  .describe(
    "Scope to a subtree: true = foreground app; objects with elementId or container use the recursive action selector; all other objects keep the legacy resourceId/text anchor with extras ignored.",
  );

const observeScopeRegionBoxSchema = z
  .object({
    x1: z.number().min(0).max(1),
    y1: z.number().min(0).max(1),
    x2: z.number().min(0).max(1),
    y2: z.number().min(0).max(1),
  })
  .refine((b) => b.x1 < b.x2 && b.y1 < b.y2, {
    message: "region requires x1 < x2 and y1 < y2",
  });

const observeScopeSchema = z
  .object({
    focus: observeScopeFocusSchema.optional(),
    region: z
      .union([z.boolean(), observeScopeRegionBoxSchema])
      .optional()
      .describe("Crop to a normalized 0..1 box; true = inset content rect."),
    overview: z.boolean().optional().describe("Collapse to a container skeleton."),
  })
  .describe("Experimental progressive-disclosure scoping of the returned hierarchy (issue #4344)");

const observeBaseSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
        // not required — a device handle from getAndroid/getApple is sufficient on
        // its own.
        platform: platformSchema.optional(),
        waitFor: waitForSchema
          .optional()
          .describe("Wait for element to appear before returning observation"),
        settled: settledSchema
          .optional()
          .describe("After waitFor matches, wait for a quiet hierarchy period (requires waitFor)"),
        raw: z.boolean().optional().describe("Include raw view hierarchy"),
        screenshot: z
          .enum(["settled", "async", "none"])
          .optional()
          .describe(
            "Screenshot mode: await a fresh validated capture, use background capture, or skip",
          ),
        crop: observeCropSchema
          .optional()
          .describe(
            "Exactly one of element (tapOn selector) or rect {x,y,width,height} in native screen units. Implies settled capture; explicit async or none is rejected. Returns a PNG path and scalar metadata only.",
          ),
        screenshotOptions: screenshotOptionsSchema
          .optional()
          .describe("Encoding for a settled screenshot; omitted uses PNG"),
        includeScreenshotImage: z
          .boolean()
          .optional()
          .describe(
            "Opt in to a bounded MCP image block from the completed settled capture (default: path only)",
          ),
        display: z
          .string()
          .optional()
          .describe(
            "Panel key, role (inner, cover, rear, external), active, or opt-in Android all. All adds per-panel displays while retaining the active result; rejects waitFor, raw:true and includeScreenshotImage:true.",
          ),
        project: z
          .enum(["full", "skeleton"])
          .optional()
          .describe(
            "Output projection. 'skeleton' (default) returns a flat, actionable-only list " +
              "(elementId/label/bounds/affordances) in place of viewHierarchy/elements. Each skeleton " +
              "elementId/label is directly usable as a tapOn selector, except the collapsed keyboard " +
              "row `<ime>` (drive it with sendKeys); " +
              "re-request with raw/project:'full' to disambiguate.",
          ),
        skipBackStack: z.boolean().optional().describe("Skip back stack during waitFor polling"),
        scope: observeScopeSchema.optional(),
        layer: hierarchyLayerSchema.optional(),
      })
      .strict(),
  )
    .superRefine(refineWaitForArgs)
    .superRefine((args, ctx) => {
      if (args.crop && args.screenshot && args.screenshot !== "settled") {
        ctx.addIssue({
          code: "custom",
          path: ["screenshot"],
          message:
            "observe crop requires screenshot: settled (or omit screenshot); async and none cannot provide a completed crop. No capture was started.",
        });
      }
      if (args.crop && args.display === "all") {
        ctx.addIssue({
          code: "custom",
          path: ["display"],
          message:
            "observe crop requires one display; select a panel key, role, or active instead of all.",
        });
      }
    })
    .superRefine((args, ctx) => {
      if (args.includeScreenshotImage && args.screenshot && args.screenshot !== "settled") {
        ctx.addIssue({
          code: "custom",
          path: ["screenshot"],
          message: "includeScreenshotImage requires screenshot: settled",
        });
      }
      if (
        args.screenshotOptions !== undefined &&
        (args.crop || args.includeScreenshotImage ? "settled" : args.screenshot) !== "settled"
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["screenshotOptions"],
          message: "screenshotOptions requires screenshot: settled",
        });
      }
    }),
  overrideWaitForJsonSchema,
);

export const observeSchema = withAppIdAliases(observeBaseSchema);

export const identifyInteractionsSchema = addDeviceTargetingToSchema(
  z
    .object({
      // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
      // not required — a device handle from getAndroid/getApple is sufficient on
      // its own.
      platform: platformSchema.optional(),
      filter: z
        .object({
          types: z
            .array(z.enum(["navigation", "input", "action", "scroll", "toggle"]))
            .optional()
            .describe("Interaction types"),
          minConfidence: z.number().min(0).max(1).optional().describe("Min confidence (0-1)"),
          limit: z.number().int().positive().optional().describe("Max results"),
        })
        .optional()
        .describe("Filter options"),
      includeContext: z
        .object({
          navigationGraph: z.boolean().optional().describe("Include nav graph predictions"),
          elementDetails: z.boolean().optional().describe("Include element details"),
          suggestedParams: z.boolean().optional().describe("Include tool params"),
        })
        .optional()
        .describe("Context options"),
      layer: hierarchyLayerSchema.optional(),
    })
    .strict(),
);

export type ObserveArgs = z.infer<typeof observeSchema>;
interface AccessibilityReadinessActions {
  accessibilityDetector?: Pick<
    AccessibilityDetector,
    "isCtrlProxyServiceEnabled" | "invalidateCache"
  >;
  resetSetupState(): void;
  isDaemonInitialized(): boolean;
  invalidateAutomationReadiness(sessionUuid: string, reason: string): void;
}

/** User-facing screen reader state is independent of CtrlProxy automation readiness. */
export async function invalidateReadinessForDisabledAccessibility(
  device: BootedDevice,
  result: ObserveResult,
  sessionUuid: string | undefined,
  actions: AccessibilityReadinessActions,
): Promise<void> {
  if (
    device.platform !== "android" ||
    !result.accessibilityState ||
    result.accessibilityState.detectionSkipped === true
  ) {
    return;
  }
  const detector = actions.accessibilityDetector ?? accessibilityDetector;
  const ctrlProxyEnabled = await detector.isCtrlProxyServiceEnabled(device.deviceId);
  if (ctrlProxyEnabled !== false) {
    return;
  }
  detector.invalidateCache(device.deviceId);
  logger.warn(
    "[observe] Accessibility service not enabled, resetting setup state for next attempt",
  );
  try {
    actions.resetSetupState();
  } catch (error) {
    logger.warn("[observe] Failed to reset accessibility setup state", {
      error: errorMessage(error),
    });
  }
  if (sessionUuid && actions.isDaemonInitialized()) {
    actions.invalidateAutomationReadiness(sessionUuid, "accessibility service disabled");
  } else {
    logger.debug("[observe] No initialized daemon session to invalidate readiness for");
  }
}

export function registerObserveTools(dependencies: ObserveToolDependencies = {}) {
  // Observe handler
  const observeHandler = async (
    device: BootedDevice,
    args: ObserveArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ): Promise<ObserveResponse> => {
    // #6154 follow-up: `platform` is optional on the wire, so the schema's
    // iOS-rejects-activityName check (which runs against the raw request
    // platform) can be skipped entirely when the caller omitted it. Re-validate
    // against the resolved `device.platform`, before the try/catch below so the
    // actionable message isn't re-wrapped as a generic execution failure.
    const { deviceRead, aggregate, timeoutMs, screenshotMode, encoding } = prepareObserveOptions(
      device.platform,
      args,
    );
    try {
      const observeScreen = screenForObserve(device, args, dependencies);
      const screenshotOptions = await observeScreenshotOptions(
        args,
        device,
        deviceRead,
        screenshotMode,
        dependencies,
      );
      // ObserveScreen.execute() rejects stale cross-platform hierarchies at the
      // source, so every observation reaching here is already platform-validated
      // (raw-mode append below is likewise gated on a validated primary hierarchy).
      const waitOutcome = observeWaitRequested(deviceRead, args)
        ? await waitForObservation(
            ...observeWaitParameters(observeScreen, args, signal, dependencies, device, {
              mode: screenshotMode,
              options: screenshotOptions,
            }),
          )
        : null;
      const result = deviceRead
        ? await observeScreen.executeDeviceRead(signal, screenshotMode, encoding, {
            requireFreshScreenshot: requiresFreshObserveScreenshot(args),
            timeoutMs,
          })
        : waitOutcome
          ? waitOutcome.observation
          : await observeScreen.execute({
              perf: createGlobalPerformanceTracker(),
              skipWaitForFresh: true,
              verifyCachedHierarchy: true,
              signal,
              screenshot: screenshotMode,
              screenshotOptions,
              timeoutMs,
            });

      if (!aggregate) {
        await attachObserveCrop(args, result, device, dependencies.crop);
      }

      if (shouldPublishObservation(deviceRead, aggregate)) {
        attachSnapshotReference(device.deviceId, result);
      }

      if (shouldAppendRawObserveHierarchy(args, deviceRead)) {
        await observeScreen.appendRawViewHierarchy(result, signal);
      }

      // The settled capture has resolved before either resource is announced.
      if (shouldPublishObservation(deviceRead, aggregate)) {
        await ResourceRegistry.notifyResourcesUpdated([
          RESOURCE_URIS.LATEST_OBSERVATION,
          RESOURCE_URIS.LATEST_SCREENSHOT,
        ]);
      }

      // Include setup timing if this is the first observe after accessibility service setup
      consumeObserveSetupTiming(deviceRead, device, result, args.sessionUuid);

      // Record back stack information in navigation graph if available
      if (!deviceRead) {
        recordObservationBackStack(result, args.sessionUuid);
      }

      // Consume the audit's cached CtrlProxy signal: a synthetic result or missing
      // cached read is not evidence of loss and must not trigger independent ADB detection.
      if (!deviceRead) {
        await invalidateReadinessForDisabledAccessibility(device, result, args.sessionUuid, {
          resetSetupState: () => AndroidCtrlProxyManager.getInstance(device).resetSetupState(),
          isDaemonInitialized: () => DaemonState.getInstance().isInitialized(),
          invalidateAutomationReadiness: (sessionUuid, reason) =>
            DaemonState.getInstance()
              .getSessionManager()
              .invalidateAutomationReadiness(sessionUuid, reason),
        });
      }

      const served = layerScopedObserveResult(result, args.layer, device.platform, !waitOutcome);

      if (waitOutcome) {
        return await createObserveWaitResponse(served, waitOutcome, args.includeScreenshotImage, {
          signal,
          protection: dependencies.pathProtection,
        });
      }

      return await createObserveResponse(served, args.includeScreenshotImage, {
        signal,
        protection: dependencies.pathProtection,
      });
    } catch (error) {
      throw toActionableError(error, `Failed to execute observe`);
    }
  };

  const identifyInteractionsHandler = async (
    device: BootedDevice,
    args: IdentifyInteractionsOptions,
  ) => {
    try {
      const cachedResult = isSessionlessDeviceRead()
        ? await readWatchedObservationForInteractions(device, dependencies)
        : await readObservationForInteractions(
            dependencies.createScreen?.(device) ?? new RealObserveScreen(device),
          );
      const navigationGraph = args.sessionUuid
        ? NavigationGraphManager.getInstanceForSession(args.sessionUuid)
        : NavigationGraphManager.getInstance();
      const currentScreen = navigationGraph.getCurrentScreen();
      const navigationEdges =
        args.includeContext?.navigationGraph !== false && currentScreen
          ? await navigationGraph.getEdgesFrom(currentScreen)
          : [];

      // Issue #9305: identify interactions on the app or on the prototype only. The cached
      // observation keeps every window; only the copy the analyzer reads is scoped.
      if (args.layer === "prototype" && cachedResult.viewHierarchy) {
        scopeHierarchyForSelector(cachedResult.viewHierarchy, args.layer);
      }
      const scoped = scopeObserveResultToLayer(cachedResult, args.layer, device.platform);

      const analyzer = new IdentifyInteractions();
      const result = analyzer.analyze(scoped, args, currentScreen, navigationEdges);

      return createJSONToolResponse(result);
    } catch (error) {
      throw toActionableError(error, `Failed to execute identifyInteractions`);
    }
  };

  // Register with the tool registry using the new device-aware method.
  // Advertise a machine-readable `ObserveResult` outputSchema (issue #3025) so
  // observe's hierarchy/window/element bounds — the bulk of compacted bounds —
  // are described on the wire, and so its `bounds` fields route through
  // `elementBoundsSchema` (the compact bounds tuple is advertised unconditionally
  // via `advertiseBoundsForCompact` in `getToolDefinitions`). Composes with
  // `--tool-results-no-structured-content`, which suppresses the advertisement.
  ToolRegistry.registerDeviceAware(
    "observe",
    `Android synthetic s2- element ids are valid only for the observation that returned them; re-observe before using an id after the screen changes. Get screen view hierarchy and screenshot, with optional PNG crop from a fresh settled capture of one display. Opt-in Android display:'all' adds per-panel displays to the unchanged active-panel result, without updating observation baselines or transition fences; rejects waitFor, raw:true and includeScreenshotImage:true. An explicit deviceId without sessionUuid creates no session, assigns no device and leaves an idle device idle. It may start an unowned device's hierarchy service using session setup within the read deadline, serialized with acquisition, guarded against ownership/pool transitions, and shared across concurrent reads. hierarchyServiceStarted: true reports this; the service and resident client remain running. Owned devices stay connect-only: this read never starts, restarts or reconfigures their service. With sessionUuid, observe uses the session and deviceId must match the session's device. DeviceId reads reject waitFor, raw: true and skipBackStack: true; use project: 'full' for the full filtered hierarchy. They omit snapshotReference and default to a settled screenshot; async also awaits capture. Each screenshot path is kept for at least 10 minutes after the response that returned it unless evicted early under capacity pressure, so a returned path is not guaranteed to survive until its expiresAt; expiresAt metadata uses the host clock. Returning cached paths extends their lifetime. At the shared 128 MiB / 4096-file cap, new captures are never refused: the least recently returned screenshots are evicted early, unreferenced ones first and then referenced ones, to admit them. Release and device removal leave files until their guarantees expire. Restart uses a ten-minute process-start grace; other processes can only honor the ten-minute mtime floor. Capacity uses a per-process in-memory inventory reconciled on sweeps and near either cap. Concurrent processes can exceed the aggregate cap before reconciliation; discovered files count against subsequent admission. Expired files are swept at initial inventory, near capacity and every minute while idle. Copy files needed beyond the guarantee.`,
    observeSchema,
    observeHandler,
    {
      defaultEnabled: true,
      // Watching is allowed on any device, whichever session holds it (#10730).
      deviceReadOnly: true,
      loudArtifactWrites: true,
      transportRecovery: "replay",
      outputSchema: observeToolResultSchema,
      appUiResourceUri: OBSERVE_APP_RESOURCE_URI,
      sessionlessDeviceRead: sessionlessDeviceReadFor(dependencies.deviceReadAccess),
    },
  );

  ToolRegistry.registerDeviceAware(
    "identifyInteractions",
    "Suggest likely interactions",
    identifyInteractionsSchema,
    identifyInteractionsHandler,
    // Suggests, never acts: a read (#10965). On a held device it reads through the observer
    // capture (`readWatchedObservationForInteractions`), never the holder's session pipeline.
    { defaultEnabled: true, debugOnly: true, deviceReadOnly: true },
  );
}

/**
 * identifyInteractions on the read-only device path (#10965): a fresh observer capture of the
 * watched device, connect-only like `observe {deviceId}`, instead of the session pipeline's cache.
 */
async function readWatchedObservationForInteractions(
  device: BootedDevice,
  dependencies: ObserveToolDependencies,
): Promise<ObserveResult> {
  const screen =
    dependencies.createScreen?.(device) ??
    new RealObserveScreen(device, undefined, { deviceReadOnly: true });
  const result = await screen.executeDeviceRead(undefined, "none");
  if (!result.viewHierarchy || result.viewHierarchy.hierarchy.error) {
    throw new ActionableError("Unable to observe screen to identify interactions.", {
      cause: new Error(result.viewHierarchy?.hierarchy.error ?? "No view hierarchy returned."),
    });
  }
  return result;
}

function attachObserveSetupTiming(
  result: ObserveResult,
  setupTiming: ReturnType<typeof consumeSetupTiming> | undefined,
): void {
  if (setupTiming) {
    const setupEntries = Array.isArray(setupTiming) ? setupTiming : Object.values(setupTiming);
    const observeEntries = result.perfTiming
      ? Array.isArray(result.perfTiming)
        ? result.perfTiming
        : Object.values(result.perfTiming)
      : [];
    result.perfTiming = [...setupEntries, ...observeEntries];
  }
}

function shouldPublishObservation(deviceRead: boolean, aggregate: boolean): boolean {
  return !deviceRead && !aggregate;
}

function observeWaitRequested(
  deviceRead: boolean,
  args: ObserveArgs,
): args is ObserveArgs & { waitFor: NonNullable<ObserveArgs["waitFor"]> } {
  return Boolean(!deviceRead && args.waitFor);
}

function requiresFreshObserveScreenshot(args: ObserveArgs): boolean {
  return (
    args.crop !== undefined || args.screenshot === "settled" || args.includeScreenshotImage === true
  );
}

function observeWaitParameters(
  observeScreen: ObserveScreen,
  args: ObserveArgs & { waitFor: NonNullable<ObserveArgs["waitFor"]> },
  signal: AbortSignal | undefined,
  dependencies: ObserveToolDependencies,
  device: BootedDevice,
  screenshot: { mode: ScreenshotMode | undefined; options: ObserveScreenshotOptions | undefined },
): Parameters<typeof waitForObservation> {
  return [
    observeScreen,
    { ...args.waitFor, settled: args.settled, layer: args.layer },
    signal,
    args.skipBackStack ?? false,
    dependencies.timer ?? defaultTimer,
    device.platform,
    screenshot.mode,
    screenshot.options,
    ...displayWaitInventory(device),
  ];
}

function consumeObserveSetupTiming(
  deviceRead: boolean,
  device: BootedDevice,
  result: ObserveResult,
  sessionId?: string,
): void {
  const setupTiming = deviceRead ? undefined : consumeSetupTiming(device.deviceId, sessionId);
  attachObserveSetupTiming(result, setupTiming);
}

function shouldAppendRawObserveHierarchy(args: ObserveArgs, deviceRead: boolean): boolean {
  return Boolean(args.raw && !deviceRead);
}
