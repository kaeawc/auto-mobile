import { deviceDescriptionSchema } from "./deviceDescription";
import { deviceClockInputSchema } from "../features/utility/DeviceClock";
import {
  biometricEnrollmentSchema,
  doNotDisturbModeSchema,
  networkConditionProfileSchema,
  DEVICE_STATE_READABLE_FIELDS,
} from "../features/utility/DeviceState";
import { platformSchema } from "./toolSchemaHelpers";
import { z } from "zod/v4";
import { withJsonSchemaOverride, withPostFlattenJsonSchemaOverride } from "./toolSchemaHelpers";

const displayInventoryUnavailableSchema = z.object({
  pin: z.string().optional(),
  retryable: z.literal(true),
});

const pinnedDisplaySchema = z.object({
  pin: z.string(),
  availablePanels: z.array(
    z.object({ key: z.string(), role: z.enum(["inner", "cover", "rear", "external", "unknown"]) }),
  ),
});

const staleDisplaySchema = z.object({
  observedGeneration: z.number().int().nonnegative(),
  currentGeneration: z.number().int().nonnegative(),
  currentDisplayKey: z.string().optional(),
  retry: z.literal("observe"),
});

/** Evidence from the existing boot, runner setup, and session recording steps. */
export const startDeviceReadinessSchema = z.object({
  level: z.literal("automationReady"),
  checks: z.array(z.enum(["bootCompleted", "runnerReady", "sessionBound"])),
  elapsedMs: z.number().nonnegative(),
  recovered: z.boolean().optional(),
});

export type StartDeviceReadiness = z.infer<typeof startDeviceReadinessSchema>;

/** Shared acquisition description plus startDevice's successful structured result. */
export const startDeviceOutputSchema = z
  .object({
    ...deviceDescriptionSchema.partial().shape,
    message: z.string(),
    deviceIdentity: z.unknown().optional(),
    processId: z.number().nullable().optional(),
    isReady: z.literal(true).optional(),
    acquisition: z.enum(["already-booted", "cold-boot"]).optional(),
    readiness: startDeviceReadinessSchema.optional(),
    // PerformanceTracker emits nested arrays/records rather than a flat numeric map.
    timing: z.unknown().optional(),
  })
  .passthrough();

/** A successful openurl may still need a foreground confirmation before the next action. */
export const openLinkResultSchema = z
  .object({
    success: z.boolean(),
    url: z.string(),
    message: z.string(),
    error: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  })
  .passthrough();

const keyboardIdentitySchema = z.object({
  component: z.string(),
  package: z.string(),
  versionName: z.string().optional(),
  subtype: z.string().optional(),
});

const imeCapabilitiesSchema = z.object({
  visibleKeyTap: z.boolean(),
  gesture: z.boolean(),
  suggestion: z.boolean(),
  clipboard: z.boolean(),
  semanticText: z.boolean(),
});

/** Keyboard has several actions; these fields describe its installed-IME results. */
export const keyboardResultSchema = z
  .object({
    method: z.enum(["escape", "dismissKey", "returnKey"]).optional(),
    installed: z
      .array(
        z
          .object({
            id: z.string(),
            enabled: z.boolean(),
            active: z.boolean(),
            capabilities: imeCapabilitiesSchema,
          })
          .passthrough(),
      )
      .optional(),
    backend: z.literal("installedIme").optional(),
    capability: z.literal("visibleKeyTap").optional(),
    keyboard: keyboardIdentitySchema.optional(),
  })
  .passthrough();

/** IME fields live on each command result, never on the sendKeys envelope. */
export const sendKeysResultSchema = z
  .object({
    pinnedDisplay: pinnedDisplaySchema.optional(),
    displayInventory: displayInventoryUnavailableSchema.optional(),
    staleDisplay: staleDisplaySchema.optional(),
    commands: z
      .array(
        z
          .object({
            pinnedDisplay: pinnedDisplaySchema.optional(),
            displayInventory: displayInventoryUnavailableSchema.optional(),
            staleDisplay: staleDisplaySchema.optional(),
            backend: z.literal("autoMobileIme").optional(),
            capability: z.literal("semanticText").optional(),
            keyboard: keyboardIdentitySchema.optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

// Android accessibility returns boolean attributes as strings ("true"/"false")
// This schema accepts both for compatibility
const booleanOrString = z.union([z.boolean(), z.literal("true"), z.literal("false")]).optional();

const semanticLinkSchema = z.object({
  text: z.string().min(1),
  occurrence: z.number().int().nonnegative(),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
});

// Default (verbose) bounds shape: the four-key object plus optional centers.
//
// Coordinates are plain numbers, NOT `.int()` (issue #3206): Android bounds are
// integer pixels (accessibility-service `Rect`s), but iOS bounds are XCUITest
// points — a coordinate space where fractional values (retina point→pixel,
// sub-point layout) are legitimate. The iOS runner happens to truncate to `Int`
// today (`ios/control-proxy/.../ElementLocator.swift`), but the TS model layer
// (`ElementBounds`) is `number` end-to-end and nothing between the model and the
// wire enforces integrality, so advertising `integer` would make a strict MCP
// client reject a real observation the moment any producer emits a `.5`.
const boundsObjectSchema = z.object({
  left: z.number(),
  top: z.number(),
  right: z.number(),
  bottom: z.number(),
  centerX: z.number().optional(),
  centerY: z.number().optional(),
});

// Compact bounds shape, now emitted unconditionally: every `bounds` object is
// flattened to the positional tuple `[left, top, right, bottom]` (issue #2990).
// The tuple carries no centers — a consumer derives them as (left+right)/2,
// (top+bottom)/2. This is a fixed-length 4-tuple so it round-trips losslessly.
const compactBoundsTupleSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .describe(
    "Compact bounds tuple [left, top, right, bottom], emitted in place of the " +
      "{left, top, right, bottom} object.",
  );

/**
 * Bounds as advertised on the wire. The server emits the positional tuple
 * `[left, top, right, bottom]` (bounds compaction is an unconditional default);
 * the `{left, top, right, bottom}` object arm remains schema-valid for backward
 * compatibility. Every output schema that carries a `bounds` field (elements,
 * focused/selected elements, …) routes through this union so the advertised
 * `outputSchema` describes — and a strict MCP client validates — the tuple the
 * server actually emits (issue #2990).
 *
 * The union is advertised in `tools/list` as-is: `advertiseBoundsForCompact`
 * (`compactBoundsAdvertisement.ts`) is now always called in the compaction-on
 * state, so it passes the union through unchanged. The `.describe()` prefix below
 * is the stable marker that helper keys off — keep them in sync.
 */
export const elementBoundsSchema = z
  .union([boundsObjectSchema, compactBoundsTupleSchema])
  .describe(
    "Element bounds. Default: positional tuple [left, top, right, bottom]; the " +
      "object {left, top, right, bottom} (+ optional centerX/centerY) is also " +
      "schema-valid. Coordinates share screenSize's current-orientation native space " +
      "and can be passed to tapAt without density, inset, Retina, canonical-pixel, or rotation conversion.",
  );

export const elementSchema = z
  .object({
    bounds: elementBoundsSchema,
    text: z.string().optional(),
    "resource-id": z.string().optional(),
    "view-id": z.string().optional(),
    "content-desc": z.string().optional(),
    occlusionState: z.string().optional(),
    occludedBy: z.string().optional(),
    occludedByViewId: z.string().optional(),
    class: z.string().optional(),
    package: z.string().optional(),
    checkable: booleanOrString,
    checked: booleanOrString,
    clickable: booleanOrString,
    enabled: booleanOrString,
    focusable: booleanOrString,
    focused: booleanOrString,
    "accessibility-focused": booleanOrString,
    scrollable: booleanOrString,
    selected: booleanOrString,
    "semantic-links": z.array(semanticLinkSchema).optional(),
  })
  .passthrough();

const selectedElementStateSchema = z.object({
  method: z.enum(["accessibility", "visual"]),
  confidence: z.number(),
  reason: z.string().optional(),
});

export const selectedElementSchema = z
  .object({
    text: z.string().optional(),
    resourceId: z.string().optional(),
    testTag: z.string().optional(),
    contentDesc: z.string().optional(),
    bounds: elementBoundsSchema.optional(),
    indexInMatches: z.number().int().optional(),
    totalMatches: z.number().int().optional(),
    selectionStrategy: z.string().optional(),
    selectedState: selectedElementStateSchema.optional(),
  })
  .passthrough();

export const activeWindowSchema = z
  .object({
    appId: z.string().optional(),
    activityName: z.string().optional(),
    layoutSeqSum: z.number().int().optional(),
    type: z.string().optional(),
    // True when a focused SystemUI surface (notification shade, quick settings,
    // keyguard) owns focus; `appId` then mirrors com.android.systemui so
    // `waitFor.activeWindow.appId` fails closed for the occluded app (#6078).
    systemOverlay: z.boolean().optional(),
  })
  .passthrough();

const screenIdentitySchema = z
  .object({
    platform: z.enum(["ios", "android"]),
    source: z.enum(["heuristic", "sdk"]),
    confidence: z.enum(["high", "medium", "low"]),
    key: z.string(),
    components: z
      .object({
        bundleId: z.string().optional(),
        navigationRoute: z.string().optional(),
        navigationTitle: z.string().optional(),
        selectedTab: z.string().optional(),
        presentation: z.string().optional(),
        modalClass: z.string().optional(),
        modalTitle: z.string().optional(),
        focusedElementId: z.string().optional(),
        keyboardVisible: z.boolean().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const observationDiffScreenIdentitySchema = z
  .object({
    activeWindow: activeWindowSchema.optional(),
    hierarchyPackageName: z.string().optional(),
    screenIdentity: screenIdentitySchema.optional(),
  })
  .passthrough();

const observationDiffMetadataSchema = z
  .object({
    mode: z.enum(["diff", "full"]),
    reason: z.enum([
      "diff_emitted",
      "missing_baseline",
      "screen_changed",
      "missing_session",
      "unrenderable_hierarchy",
      "disabled",
      "stripped_by_actions_no_observe",
    ]),
    hint: z.string().optional(),
    fromScreen: observationDiffScreenIdentitySchema.optional(),
    toScreen: observationDiffScreenIdentitySchema.optional(),
  })
  .passthrough();

export const toolOutputArtifactDetailsSchema = z
  .object({
    path: z.string(),
    format: z.literal("json"),
    payload: z.string(),
    bytes: z.number().int().nonnegative(),
    tool: z.string(),
    // In-band companion to `path` (issue #5882). Optional so historical/inline
    // payloads without it still validate; the writer always populates it.
    resourceUri: z
      .string()
      .optional()
      .describe("automobile: resource URI to fetch this artifact's JSON in-band"),
  })
  .passthrough();

export const toolOutputArtifactMetadataSchema = z
  .object({
    artifact: toolOutputArtifactDetailsSchema,
  })
  .passthrough();

const tapOnSearchUntilSchema = z
  .object({
    durationMs: z.number().int(),
    requestCount: z.number().int(),
    changeCount: z.number().int(),
  })
  .passthrough();

const screenReaderNavigationSchema = z
  .object({
    reachable: z.boolean().describe("Whether the accessibility cursor was moved onto the target"),
    traversalOrder: z.array(elementSchema).describe("Focused nodes in cursor traversal order"),
    focusTrapDetected: z
      .boolean()
      .describe(
        "Always false: a cursor that cannot be moved onto the target fails the call instead",
      ),
  })
  .passthrough();

const tapEffectSchema = z
  .object({
    screenChanged: z.boolean(),
    basis: z.enum([
      "screenIdentity changed",
      "screenIdentity unchanged",
      "activeWindow changed",
      "activeWindow unchanged",
      "viewHierarchy changed",
      "viewHierarchy unchanged",
      "insufficient observation data",
    ]),
  })
  .passthrough();

/**
 * Current-orientation MCP screen dimensions: Android physical pixels or iOS
 * XCTest logical points, in the same native space as hierarchy/skeleton bounds.
 */
export const screenSizeSchema = z
  .object({
    width: z.number().int(),
    height: z.number().int(),
    units: z.enum(["physical-pixels", "points", "unknown"]).optional(),
  })
  .describe(
    "Current-orientation native screen size for observe bounds and absolute tapAt input: " +
      "Android physical pixels or iOS XCTest logical points. Valid points satisfy " +
      "0 <= x < width and 0 <= y < height. No density, inset, Retina, canonical-pixel, " +
      "or rotation transform applies to an already-native point.",
  );

export const systemInsetsSchema = z.object({
  top: z.number(),
  right: z.number(),
  bottom: z.number(),
  left: z.number(),
});

const edgeInsetsSchema = z.object({
  top: z.number(),
  right: z.number(),
  bottom: z.number(),
  left: z.number(),
});

const displayCutoutBoundsSchema = z.union([
  boundsObjectSchema,
  z.array(z.number()).min(4).max(4).describe("Compact bounds tuple [left, top, right, bottom]."),
]);

const displayCutoutInfoSchema = z.object({
  classification: z.enum(["none", "notch", "dynamic_island", "hole_punch", "unknown"]),
  // Platform metadata reports a list of bounds objects. The tuple arm preserves
  // forward compatibility should a producer compact those rectangles.
  bounds: z.array(displayCutoutBoundsSchema).nullish(),
});

const systemChromeSchema = z.object({
  visibility: z.enum(["visible", "hidden", "partial", "unknown"]),
  statusBar: z.enum(["visible", "hidden", "unknown"]),
  navigationBar: z.enum(["visible", "hidden", "unknown"]).optional(),
  homeIndicatorAutoHideRequested: z.boolean().nullish(),
  source: z.enum(["android-window-insets", "ios-status-bar-manager"]),
});

const observationInsetsSchema = z.object({
  available: z.boolean(),
  source: z.enum([
    "android-window-metrics",
    "android-resource-fallback",
    "ios-sdk-safe-area",
    "unavailable",
  ]),
  units: z.enum(["physical-pixels", "points", "unknown"]),
  // Android's Kotlin payload serializes unavailable typed inset categories as
  // null (rather than omitting them), particularly on older API levels.
  systemBars: z.object({ visible: edgeInsetsSchema, stable: edgeInsetsSchema }).nullish(),
  displayCutout: edgeInsetsSchema.nullish(),
  displayCutoutInfo: displayCutoutInfoSchema.optional(),
  systemGestures: edgeInsetsSchema.nullish(),
  mandatorySystemGestures: edgeInsetsSchema.nullish(),
  tappableElement: edgeInsetsSchema.nullish(),
  safeArea: edgeInsetsSchema.optional(),
  systemChrome: systemChromeSchema.nullish(),
});

const layoutWarningSchema = z.object({
  type: z.enum(["important-content-under-inset", "interaction-in-system-gesture-region"]),
  severity: z.enum(["warning", "info"]),
  element: z.object({
    viewId: z.string().optional(),
    resourceId: z.string().optional(),
    text: z.string().optional(),
    contentDesc: z.string().optional(),
    bounds: elementBoundsSchema,
  }),
  categories: z.array(z.enum(["text", "interaction"])),
  insetTypes: z.array(
    z.enum([
      "systemBars",
      "displayCutout",
      "safeArea",
      "systemGestures",
      "mandatorySystemGestures",
    ]),
  ),
  sides: z.array(z.enum(["top", "right", "bottom", "left"])),
  overflowPx: edgeInsetsSchema.partial(),
  insetPx: edgeInsetsSchema.partial(),
  overlapPercent: z.number().int(),
  confidence: z.enum(["high", "medium"]),
});

const layoutWarningsPerEntryDiffSchema = z
  .object({
    added: z.array(layoutWarningSchema),
    removed: z.array(layoutWarningSchema),
    scope: z
      .object({
        from: z.enum(["full", "truncated", "scoped"]).optional(),
        to: z.enum(["full", "truncated", "scoped"]).optional(),
      })
      .strict()
      .optional(),
    total: z.object({ from: z.number().optional(), to: z.number().optional() }).strict().optional(),
  })
  .strict();

const layoutWarningsDiffFieldSchema = z.union([
  z.object({ from: z.unknown().optional(), to: z.unknown().optional() }).strict(),
  layoutWarningsPerEntryDiffSchema,
]);

const predictionTargetSchema = z
  .object({
    text: z.string().optional(),
    elementId: z.string().optional(),
    contentDesc: z.string().optional(),
    container: z
      .object({
        text: z.string().optional(),
        elementId: z.string().optional(),
        contentDesc: z.string().optional(),
      })
      .optional(),
    lookFor: z
      .object({
        text: z.string().optional(),
        elementId: z.string().optional(),
        contentDesc: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

const predictedActionSchema = z
  .object({
    action: z.string(),
    target: predictionTargetSchema,
    predictedScreen: z.string(),
    predictedElements: z.array(z.string()).optional(),
    confidence: z.number(),
  })
  .passthrough();

const interactablePredictionSchema = z
  .object({
    elementId: z.string().optional(),
    elementText: z.string().optional(),
    elementContentDesc: z.string().optional(),
    predictedOutcome: z
      .object({
        screenName: z.string(),
        basedOn: z.enum(["navigation_graph"]),
      })
      .optional(),
  })
  .passthrough();

export const predictionsSchema = z
  .object({
    likelyActions: z.array(predictedActionSchema),
    interactableElements: z.array(interactablePredictionSchema),
  })
  .passthrough();

export const freshnessSchema = z
  .object({
    requestedAfter: z.number().int().optional(),
    actualTimestamp: z.number().int().optional(),
    /** Wall-clock age of `actualTimestamp` at report time. */
    ageMs: z.number().int().optional(),
    /** Whether the hierarchy was verified against the device on this call, vs. served from cache. */
    verified: z.boolean().optional(),
    isFresh: z.boolean(),
    staleDurationMs: z.number().int().optional(),
    warning: z.string().optional(),
    unavailableReason: z
      .enum([
        "runner_not_running",
        "connection_lost",
        "simulator_not_booted",
        "request_timed_out",
        "auto_setup_failed",
        "unknown",
        "service_recovering",
        "device_locked",
        "incomplete_capture",
      ])
      .optional(),
    unavailableDetail: z.string().max(500).optional(),
    /** Stable discriminant for WHY freshness failed (only when `isFresh` is false). */
    category: z
      .enum([
        "cache_age",
        "window_identity",
        "requested_min",
        "no_timestamp",
        "unavailable",
        "effect_inconsistent",
      ])
      .optional(),
  })
  .passthrough();

// Unavailable status reads (TalkBack on Android, VoiceOver on iOS) return service + reason
// without asserting enabled.
export const accessibilityStateSchema = z
  .object({
    enabled: z.boolean().optional(),
    service: z.enum(["talkback", "voiceover", "unknown"]),
    warning: z.string().optional(),
    blockingPrompt: z
      .object({
        kind: z.literal("runtime-permission"),
        package: z.string(),
        activity: z.string(),
      })
      .optional(),
  })
  .passthrough();

export const accessibilityFocusResultSchema = z
  .object({
    success: z.boolean(),
    error: z.string().optional(),
    warning: z.string().optional(),
    focusedElement: elementSchema.optional(),
    confirmed: z.boolean().optional(),
  })
  .passthrough();

/**
 * A recursive view-hierarchy / element node (issue #3025). Its `bounds` routes
 * through {@link elementBoundsSchema} so the compact tuple is advertised at
 * every depth, and `node` is polymorphic — a single object OR an array, as real
 * captures vary (the fixture's root `node` is an array while nested children can
 * be either). `.passthrough()` keeps the polymorphic `$` attribute bag and any
 * per-node metadata (`view-id`, `occlusionState`, `test-tag`, …) the model does
 * not enumerate, so the schema describes the bounds shape without over-fitting
 * the large, dynamic node payload.
 */
export const viewHierarchyNodeSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      bounds: elementBoundsSchema.optional(),
      occlusionState: z.string().optional(),
      occludedBy: z.string().optional(),
      occludedByViewId: z.string().optional(),
      node: z.union([viewHierarchyNodeSchema, z.array(viewHierarchyNodeSchema)]).optional(),
    })
    .passthrough(),
);

const hierarchyNodeField = z
  .union([viewHierarchyNodeSchema, z.array(viewHierarchyNodeSchema)])
  .optional();

const contentHiddenRegionSchema = z
  .object({
    bounds: elementBoundsSchema,
    reason: z.string(),
    areaPercent: z.number(),
  })
  .passthrough();

const viewHierarchyWindowSchema = z
  .object({
    bounds: elementBoundsSchema.optional(),
    hierarchy: viewHierarchyNodeSchema.optional(),
    truncationReasons: z
      .array(z.string())
      .nullish()
      .describe(
        "Per-window capture truncation codes (max_nodes, max_depth, max_children, cancelled, or newer APK codes). " +
          "Absent or null when unavailable; complete windows omit reasons. Full/raw output keeps these here.",
      ),
  })
  .passthrough();

const windowTruncationsSchema = z
  .array(
    z.object({
      windowId: z.number().int(),
      package: z.string().optional(),
      reasons: z.array(z.string()),
    }),
  )
  .optional()
  .describe(
    "Current capture's incomplete windows: one entry per window with non-empty capture reasons, " +
      "identified by windowId; package is included only from that window or its linked root. " +
      "Codes include max_nodes (window node budget exhausted), max_depth (depth cap), max_children (device per-node child cap), cancelled " +
      "(capture cancelled), and unknown codes passed through unchanged. Host-output caps are excluded. " +
      "Present only in skeleton/diff output, including each display:all entry; absent when none are " +
      "truncated or the APK predates per-window reasons. Diff entries describe only the current capture, " +
      "not the baseline. Full/raw observations retain viewHierarchy.windows[].truncationReasons instead.",
  );

/**
 * The `viewHierarchy` sub-tree of an observe result (issue #3025). The
 * bounds-carrying sites are typed — the root `hierarchy.node`, per-window
 * `bounds`/`hierarchy`, `contentHiddenRegions[].bounds`, and the
 * accessibility-focused node — so those `bounds` advertise the compact union.
 *
 * The iOS root `Hierarchy.bounds` is deliberately NOT routed through the union:
 * its `left`/`top` are optional (`{left?, top?, right, bottom}`, points), so the
 * element union (which requires all four keys, and whose compact tuple cannot
 * express the `[null, null, r, b]` holes `compactObserveBounds` emits for a
 * partial root) would wrongly reject a real iOS observation. It rides
 * `.passthrough()` on the hierarchy object instead — honest by omission rather
 * than advertising a shape the server never emits for that site. Everything else
 * (`packageName`, `sources`, screen/density metadata, …) also passes through.
 */
export const viewHierarchyResultSchema = z
  .object({
    hierarchy: z
      .object({
        error: z.string().optional(),
        node: hierarchyNodeField,
      })
      .passthrough()
      .optional(),
    // Real captures emit `null` (not an absent key) for the empty case, so these
    // are nullish rather than merely optional.
    windows: z.array(viewHierarchyWindowSchema).nullish(),
    contentHiddenRegions: z.array(contentHiddenRegionSchema).nullish(),
    "accessibility-focused-element": viewHierarchyNodeSchema.optional(),
    systemInsets: systemInsetsSchema.optional(),
    insets: observationInsetsSchema.optional(),
    truncationReasons: z
      .array(z.string())
      .optional()
      .describe(
        "Why the captured hierarchy is incomplete (issue #6601). Present only " +
          "when rows were dropped — a device-side stop (max_nodes, max_depth, max_children, cancelled) or " +
          "the host per-node child cap (max_children[<node> kept N of M]). This is the " +
          "nested location `sanitizeObserveResult` leaves raw hierarchy reasons under " +
          '`project:"full"` or `raw:true`; capture-fidelity reasons may also be lifted ' +
          "to the top-level `truncationReasons` field for skeleton/diff output, while a " +
          "host-output max_children cap is not lifted to a non-diff skeleton.",
      ),
  })
  .passthrough();

/**
 * `observationId` is the join key for observation-scoped screenshot resources.
 * The runtime mints it on every emitted observation (`RealObserveScreen`), so
 * the advertised output contract lists it as required. The same zod schemas
 * also validate recorded captures that predate the field, so the parse schema
 * keeps it optional; {@link requireObservationJoinKeysOnTheWire} adds it to the
 * advertised JSON Schema `required` list without touching runtime validation.
 */
const observationIdSchema = z
  .string()
  .optional()
  .describe("Observation-scoped screenshot resource URI join key.");

/**
 * The concrete device this observation resolved to and ran against (issue
 * #7018). Same wire contract as {@link observationIdSchema}: optional on parse
 * (recorded captures predate it) but advertised required on the wire, because a
 * client needs BOTH `deviceId` and `observationId` to build the
 * observation-scoped screenshot resource URI.
 */
const observationDeviceIdSchema = z
  .string()
  .optional()
  .describe(
    "Resolved device this observation ran against; join key (with observationId) for the observation-scoped screenshot resource.",
  );

/** Parse old captures leniently while requiring the stamp on emitted observations. */
const observationDisplaySchema = z
  .object({
    key: z.string(),
    pinned: z
      .literal(true)
      .optional()
      .describe("This call selected the panel using its session display pin."),
    role: z.enum(["inner", "cover", "rear", "external", "unknown"]),
    posture: z.enum([
      "closed",
      "half_opened",
      "opened",
      "rear_display",
      "flipped",
      "tent",
      "unknown",
    ]),
    generation: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Generation advances on notifyTransition calls for panel key, role, or posture changes, Android non-swap size changes and accepted pushed display_transition events (changed with a different panel key or non-swap size, added, removed, or device_state changes), iOS multi-panel rotation, and iOS setPosture hinge, observed identity, and settled notifications (potentially several increments per request), but not on captures, Android pure width/height swaps, or iOS same-observation geometry corrections. " +
          "Generation is comparable only within one session: it restarts at 0 when the device is released or the session ends, and on daemon restart.",
      ),
  })
  .optional();

const otherDisplaysSchema = z
  .array(
    z.object({
      key: z.string(),
      role: z.enum(["inner", "cover", "rear", "external", "unknown"]),
      size: z.object({ width: z.number(), height: z.number() }),
    }),
  )
  .optional();

/**
 * Fully-encoded observation-scoped screenshot resource URI (issue #7018), built
 * from `deviceId` + `observationId` so a client can read the paired screenshot
 * without assembling the URI itself. Same wire contract as
 * {@link observationIdSchema}.
 */
const observationScreenshotResourceUriSchema = z
  .string()
  .optional()
  .describe(
    "Fully-encoded automobile:observation/{deviceId}/{observationId}/screenshot resource URI for this observation.",
  );

const observationRotationSchema = z
  .number()
  .int()
  .min(0)
  .max(3)
  .optional()
  .describe(
    "Rotation: 0 portrait; 1 landscape with device top toward the left (counter-clockwise, iOS landscapeLeft / Android ROTATION_90); 2 portrait upside down; 3 landscape right (iOS landscapeRight / Android ROTATION_270). iOS prefers runner interface orientation, preserving portrait on unfolded landscape-shaped panels and reconciling landscape on fixed portrait displays to 0. Without runner orientation, settled screen shape distinguishes only 0 (width < height) or 1 (width >= height, including square screens).",
  );

const snapshotReferenceSchema = z
  .object({ snapshotId: z.string(), expiresAt: z.number() })
  .optional()
  .describe("Process-local full-screen coordinate reference; expires after at most five minutes.");

const snapshotReferenceUnavailableSchema = z
  .array(z.string())
  .optional()
  .describe(
    "Missing snapshot capture preconditions (display, screenSize, rotation, nativeScale, frameContext); only present when a session observe could not produce a reference.",
  );

const cropNativeBoundsSchema = boundsObjectSchema
  .pick({ left: true, top: true, right: true, bottom: true })
  .strict();

const screenshotRasterFields = {
  imageSize: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .strict(),
  pixelsPerNativeUnit: z.object({ x: z.number().positive(), y: z.number().positive() }).strict(),
  scaleProvenance: z.enum(["raster-dimensions", "native-scale-confirmed"]),
};

export const observeCropResultSchema = z
  .object({
    cropPath: z.string(),
    expiresAt: z.number().optional(),
    unit: z.enum(["pixels", "points"]),
    requestedBounds: cropNativeBoundsSchema,
    clippedBounds: cropNativeBoundsSchema,
    clipped: z.boolean(),
    screenSize: z.object({ width: z.number().positive(), height: z.number().positive() }).strict(),
    ...screenshotRasterFields,
    imageSize: screenshotRasterFields.imageSize.describe(
      "Pixel dimensions of the upright output crop PNG.",
    ),
    rasterBounds: z
      .object({
        left: z.number().int().nonnegative(),
        top: z.number().int().nonnegative(),
        right: z.number().int().positive(),
        bottom: z.number().int().positive(),
      })
      .strict()
      .describe(
        "Bounds read from the captured source raster before crop orientation normalization.",
      ),
    screenshotOrientation: z
      .enum(["display", "native"])
      .describe(
        "Orientation of the output crop PNG; display after native iOS quarter/half-turn normalization. The full screenshot retains its own orientation metadata.",
      ),
  })
  .strict();

const observationScreenshotOutputFields = {
  screenshotImageSize: screenshotRasterFields.imageSize.optional(),
  screenshotPixelsPerNativeUnit: screenshotRasterFields.pixelsPerNativeUnit.optional(),
  screenshotScaleProvenance: screenshotRasterFields.scaleProvenance.optional(),
  screenshotSettled: z.boolean().optional(),
  screenshotSettledError: z.string().optional(),
  screenshotOrientation: z.enum(["native", "display"]).optional(),
  screenshotPath: z.string().optional(),
  screenshotExpiresAt: z.number().optional(),
  screenshotSource: z.enum(["fresh", "cached"]).optional(),
  screenshotCaptureSource: z.enum(["device", "observation-cache"]).optional(),
  screenshotCapturedAt: z.string().optional(),
  screenshotAgeMs: z.number().optional(),
  screenshotFreshFailure: z
    .object({ code: z.string(), message: z.string(), retryable: z.boolean() })
    .optional(),
  screenshotFormat: z.enum(["png", "jpeg", "webp"]).optional(),
  screenshotMimeType: z.enum(["image/png", "image/jpeg", "image/webp"]).optional(),
  screenshotImage: z
    .union([
      z.object({ included: z.literal(true), mimeType: z.string(), sizeBytes: z.number() }),
      z.object({
        included: z.literal(false),
        reason: z.string(),
        sizeBytes: z.number().optional(),
        capBytes: z.number().optional(),
      }),
    ])
    .optional(),
};

/**
 * Observation screenshot-resource properties (issue #7018). All three stay
 * optional on the zod parse schema so recorded captures that predate them still
 * validate. The URI is declared but not wire-required: observations that
 * deliberately skip capture have no screenshot resource to advertise.
 */
const OBSERVATION_JOIN_KEY_PROPERTIES = [
  "observationId",
  "deviceId",
  "display",
  "observationScreenshotResourceUri",
] as const;

/** Identity keys every successful observation has on the advertised wire contract. */
const OBSERVATION_WIRE_REQUIRED_KEYS = ["observationId", "deviceId", "display"] as const;

/**
 * Advertise the observation join keys as required (in property order, so the
 * generated `required` list is stable) while the zod schema still parses
 * captures that omit them. Registers by schema identity, so call it on the
 * final exported schema object. It detects every declared screenshot-resource
 * property, but promotes only the identity keys; the URI remains optional.
 */
function requireObservationJoinKeysOnTheWire(schema: z.ZodTypeAny): void {
  withJsonSchemaOverride(schema, (jsonSchema) => {
    const properties = jsonSchema.properties as Record<string, unknown> | undefined;
    if (!properties) {
      return;
    }
    const required = new Set(Array.isArray(jsonSchema.required) ? jsonSchema.required : []);
    const joinKeyProperties = OBSERVATION_JOIN_KEY_PROPERTIES.filter((key) =>
      Object.hasOwn(properties, key),
    );
    if (joinKeyProperties.length === 0) {
      return;
    }
    for (const key of OBSERVATION_WIRE_REQUIRED_KEYS) {
      if (Object.hasOwn(properties, key)) {
        required.add(key);
      }
    }
    // Keep `additionalProperties` as the trailing key so the generated
    // `schemas/tool-definitions.json` stays byte-stable.
    const { additionalProperties, ...rest } = jsonSchema;
    for (const key of Object.keys(jsonSchema)) {
      delete jsonSchema[key];
    }
    Object.assign(jsonSchema, rest, {
      required: Object.keys(properties).filter((key) => required.has(key)),
    });
    if (additionalProperties !== undefined) {
      jsonSchema.additionalProperties = additionalProperties;
    }
  });
}

/**
 * The advertised output schema of the `observe` tool is a `z.union` of the
 * ordinary observation ({@link observeResultSchema}) and the hard-ceiling
 * artifact-spill metadata ({@link toolOutputArtifactMetadataSchema}). The
 * registry flattens that top-level union into ONE object schema for `tools/list`
 * (top-level `anyOf`/`oneOf` is rejected by the Anthropic API and many MCP
 * clients), and flattening reduces each arm's `required` to the cross-arm
 * intersection — dropping the join keys entirely — then re-homes the observe
 * arm's arm-only `required` under whatever single-const property it finds first
 * (`accessibilityAuditSkipped`). That leaves the join keys advertised as required
 * ONLY when `accessibilityAuditSkipped` is present, so an ordinary successful
 * observation wrongly advertises them as optional (issue #7018).
 *
 * A per-node {@link requireObservationJoinKeysOnTheWire} cannot fix this: it runs
 * before flattening. Re-assert the contract on the POST-flatten object instead —
 * the join keys are required on the successful-observation arm (every shape
 * except the artifact spill, which is the only arm carrying `artifact`), not on
 * the artifact/spill arm where they do not apply. The requirement is expressed as
 * an `if artifact present -> then no join keys / else join keys required`
 * conditional, the same `if/then/else` construct the flattener already emits for
 * branch-only required fields.
 */
function requireObservationJoinKeysOnFlattenedUnion(schema: z.ZodTypeAny): void {
  withPostFlattenJsonSchemaOverride(schema, (jsonSchema) => {
    const properties = jsonSchema.properties as Record<string, unknown> | undefined;
    if (!properties) {
      return;
    }
    const joinKeyProperties = OBSERVATION_JOIN_KEY_PROPERTIES.filter((key) =>
      Object.hasOwn(properties, key),
    );
    const requiredJoinKeys = OBSERVATION_WIRE_REQUIRED_KEYS.filter((key) =>
      Object.hasOwn(properties, key),
    );
    // Only act on the flattened observe union: it declares the join keys and the
    // `artifact` spill arm's discriminating property.
    if (joinKeyProperties.length === 0 || !Object.hasOwn(properties, "artifact")) {
      return;
    }
    // The flattener emits a single `if/then` (no `else`) whose `then.required` is
    // exactly the observe arm's arm-only required (the join keys) gated on a
    // bogus discriminator. Only rewrite when the pre-flatten conditional is
    // either absent or exactly that join-key requirement; if it is anything else
    // (a future arm added its own branch-only required), bail rather than clobber
    // it — the assumptions here no longer hold and must be revisited deliberately.
    const then = jsonSchema.then as { required?: unknown } | undefined;
    const thenRequired = Array.isArray(then?.required) ? (then.required as string[]) : undefined;
    const hasConditional = "if" in jsonSchema || "then" in jsonSchema || "else" in jsonSchema;
    const isJoinKeyOnlyConditional =
      !("else" in jsonSchema) &&
      thenRequired !== undefined &&
      thenRequired.every((key) => (requiredJoinKeys as string[]).includes(key));
    if (hasConditional && !isJoinKeyOnlyConditional) {
      return;
    }
    delete jsonSchema.if;
    delete jsonSchema.then;
    delete jsonSchema.else;
    // Require the join keys on every shape except the artifact spill arm.
    jsonSchema.if = { required: ["artifact"] };
    jsonSchema.then = {};
    jsonSchema.else = { required: [...requiredJoinKeys] };
  });
}

// This is one arm of the `observation` discriminated union documented on
// `observationOutputSchema` further down this module (issue #6221 item 4): the
// FULL-object arm, identified by the ABSENCE of `isDiff` (the diff arm,
// `observeDiffSchema`, always carries `isDiff: true`). A consumer branches on
// `"isDiff" in observation && observation.isDiff === true`.
//
// `isDiff: z.literal(false).optional()` (PR #6242 review PRRT_kwDOP-GF5M6fq3iN)
// makes this arm GENUINELY reject a diff-shaped object rather than silently
// accepting it via `.passthrough()`: every OTHER field here is optional, so
// without this an invalid diff (e.g. `{isDiff: true, added: [], removed: [],
// changed: []}` missing the mandatory `skeleton`) would fail `observeDiffSchema`
// and then fall through to match this permissive arm anyway. `isDiff` is a
// genuinely-typed member of this schema, so a real `isDiff: true` payload now
// fails HERE too — the union as a whole rejects the malformed diff instead of
// silently accepting it under the wrong arm. The server itself never emits
// `isDiff: false` explicitly (absence is the real-world full-observation
// shape); the literal exists purely to close this validation gap.
export const observationSummarySchema = z
  .object({
    isDiff: z.literal(false).optional(),
    observationId: observationIdSchema,
    deviceId: observationDeviceIdSchema,
    display: observationDisplaySchema,
    otherDisplays: otherDisplaysSchema,
    observationScreenshotResourceUri: observationScreenshotResourceUriSchema,
    snapshotReference: snapshotReferenceSchema,
    snapshotReferenceUnavailable: snapshotReferenceUnavailableSchema,
    rotation: observationRotationSchema,
    ...observationScreenshotOutputFields,
    selectedElements: z.array(selectedElementSchema).optional(),
    focusedElement: elementSchema.optional(),
    accessibilityFocusedElement: elementSchema.optional(),
    activeWindow: activeWindowSchema.optional(),
    screenIdentity: screenIdentitySchema.optional(),
    hierarchyServiceStarted: z
      .boolean()
      .optional()
      .describe(
        "Present only when this session-less read started the hierarchy service on an unowned device.",
      ),
    freshness: freshnessSchema.optional(),
    // Full/raw action projections place the raw ObserveResult (the observe tool's shape) under `.observation`.
    viewHierarchy: viewHierarchyResultSchema.optional(),
    truncationReasons: z
      .array(z.string())
      .optional()
      .describe(
        "Why the captured hierarchy is incomplete (issue #6601) — the same field " +
          "a diff-mode observation carries, so a client reads it the same way in both " +
          "modes. On this non-diff arm, it contains only capture-fidelity reasons " +
          "(device-side max_nodes, max_depth, max_children, cancelled); its presence means " +
          "`skeleton`/`context` omit rows. A host-output max_children[<node> kept N of M] " +
          "cap trims only rendered `viewHierarchy` and is not lifted here.",
      ),
    windowTruncations: windowTruncationsSchema,
    settled: z
      .boolean()
      .optional()
      .describe(
        "Whether this observation passed the hierarchy-stability gate (issue #6866): two consecutive structurally-equal captures. `false` means the bound expired, the action was not navigation-class, or the action failed — in every case the capture was never confirmed stable. Stamped on every embedded action observation.",
      ),
    accessibilityAuditSkipped: z
      .literal("settled_capture_adopted")
      .optional()
      .describe(
        "Why a requested accessibility audit was omitted from this observation (issue #6926): `settled_capture_adopted` means a settled capture replaced the action's original capture, so its audit was deliberately dropped rather than mismatched onto the returned hierarchy.",
      ),
  })
  .passthrough();
requireObservationJoinKeysOnTheWire(observationSummarySchema);

/**
 * A `MediaView` entry from the `elements.media` array. Real captures carry an
 * object `bounds`, and `compactObserveBounds` flattens it to a tuple like every
 * other bounds, so it routes through {@link elementBoundsSchema} too (its other
 * fields — `mediaType`, `className`, `resourceId`, … — ride `.passthrough()`).
 */
const observeMediaSchema = z
  .object({
    bounds: elementBoundsSchema.optional(),
  })
  .passthrough();

/**
 * The flattened `elements` block of an observe result. Each category is an array
 * of bounds-carrying entries — `clickable`/`scrollable`/`text` are
 * hierarchy-node-shaped (bounds + nested `node`), `media` is a MediaView — so
 * every entry's `bounds` routes through the union and advertises the compact
 * tuple at every depth.
 */
const observeElementsSchema = z
  .object({
    clickable: z.array(viewHierarchyNodeSchema),
    scrollable: z.array(viewHierarchyNodeSchema),
    text: z.array(viewHierarchyNodeSchema),
    media: z.array(observeMediaSchema),
  })
  .passthrough();

/**
 * Machine-readable `outputSchema` for the headline `observe` tool (issue #3025).
 *
 * `observe`'s payload is large and dynamic (the hierarchy `node` field is
 * polymorphic; `elements` duplicates the tree), so this follows the pragmatic
 * middle ground the issue calls for: a `.passthrough()` top level with typed
 * `viewHierarchy`/`elements`/`bounds` sub-schemas. The value it buys is that
 * *every* `bounds` field — hierarchy nodes, window/root/region, `elements`, and
 * the focused/awaited element fields — routes through {@link elementBoundsSchema},
 * so the compact bounds tuple is advertised here (via `advertiseBoundsForCompact`
 * in `getToolDefinitions`) exactly as it is on the schema-declaring action tools
 * (`tapOn`, `accessibilityFocus`). Unmodeled fields
 * (perf timing, back stack, wakefulness, user id, errors, …) pass through so the
 * advertisement never rejects a real observation.
 */
/** Android and iOS simulator device-lock signal; `secure` omitted when undeterminable. */
export const deviceLockSchema = z.object({
  locked: z.boolean(),
  keyguardShowing: z.boolean(),
  secure: z.boolean().optional(),
});

/**
 * One row of the Interactable Skeleton Projection (issue #4388). The observe
 * output projects to `"skeleton"` by default (a per-call `project: "full"` or
 * `raw: true` opts out); it then replaces `viewHierarchy` / `elements`. Bounds
 * are always the compact `[left, top, right, bottom]` tuple, so this uses the
 * tuple schema directly rather than the `elementBoundsSchema` union.
 */
export const skeletonElementSchema = z
  .object({
    elementId: z.string().optional(),
    label: z.string().optional(),
    sublabel: z.string().optional(),
    testTag: z.string().optional(),
    semanticLinks: z.array(semanticLinkSchema).optional(),
    bounds: compactBoundsTupleSchema.describe(
      "Bounds as the compact [left, top, right, bottom] tuple — always this shape " +
        "for skeleton entries, in the same current-orientation native space as screenSize and tapAt.",
    ),
    affordances: z.array(z.enum(["tap", "long-press", "input", "scroll", "toggle"])),
    occluded: z
      .literal(true)
      .optional()
      .describe(
        "Fully covered by the Android IME window or the visible iOS keyboard; this row has no actionable affordance.",
      ),
    checked: z.boolean().optional(),
    enabled: z
      .literal(false)
      .optional()
      .describe("Explicit disabled state on Android and iOS; omitted means enabled."),
    index: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Disambiguator present when a replay-eligible row's elementId, or id-less label, " +
          "repeats among other replay-eligible rows (issue #6221). Eligibility requires valid bounds " +
          "and an affordance; a known viewport excludes off-screen rows unless raw element search is enabled. " +
          "Pass verbatim as tapOn({ selector, index }) to hit this exact entry.",
      ),
  })
  .passthrough();

/**
 * A selector recovered for a diff node/change (issue #6221 item 4). Same
 * vocabulary the `skeleton` rows use (`elementId` / `label` — see {@link
 * skeletonElementSchema}), derived from the SAME `resource-id ?? view-id` /
 * `text ?? content-desc` precedence `SkeletonProjection` applies, so a client
 * can act on a diff entry the same way it acts on a skeleton entry:
 * `tapOn({ elementId })` (falling back to `tapOn({ text: label })` when
 * `elementId` is absent). Omitted when the node carries neither.
 */
export const observeDiffSelectorSchema = z
  .object({
    elementId: z.string().optional(),
    label: z.string().optional(),
    index: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Replay disambiguator from the next observation's skeleton for a repeated elementId " +
          "or id-less label. Omitted when the node is absent or its own group contains " +
          "a promotable inert match. Unique selectors carry neither index nor ambiguous.",
      ),
    ambiguous: z
      .boolean()
      .optional()
      .describe(
        "True when this selector matches multiple candidates, including inert nodes, " +
          "and a safe replay index cannot be emitted. Never present with index or on a unique selector.",
      ),
  })
  .describe(
    "Real, tapOn-usable selector for this diff entry, when one could be derived " +
      "from its resource-id/view-id/text/content-desc — the same vocabulary skeleton " +
      "rows use. Prefer this over `key` (issue #6221 item 4).",
  );

/** One `added`/`removed` node in an observation diff (issue #2761 / #6221 item 4). */
export const observeDiffNodeSchema = z
  .object({
    key: z
      .string()
      .describe(
        "INTERNAL positional identity key (NUL-delimited resource-id/bounds/text/" +
          "sibling-index). NOT a selector — never pass this to tapOn or any other " +
          "selector-accepting field. `attributes` already carries the real " +
          "resource-id/view-id/text/content-desc — read a selector from there, or " +
          "act on a `skeleton` row instead (issue #6221 item 4).",
      ),
    attributes: z
      .record(z.string(), z.unknown())
      .describe(
        "This node's full raw attributes (including resource-id/view-id/text/" +
          "content-desc — the real selector fields), so it can be reconstructed " +
          "without the baseline.",
      ),
  })
  .passthrough();

/** A node matched across baseline/next whose non-key attributes changed. */
export const observeDiffNodeChangeSchema = z
  .object({
    key: z
      .string()
      .describe(
        "INTERNAL positional identity key — see observeDiffNodeSchema.key. NOT a selector.",
      ),
    fromKey: z
      .string()
      .optional()
      .describe(
        "The node's INTERNAL key on the baseline side, present only on content-identity re-pairs.",
      ),
    selector: observeDiffSelectorSchema.optional(),
    changes: z.record(
      z.string(),
      z.object({ from: z.unknown().optional(), to: z.unknown().optional() }),
    ),
  })
  .passthrough();

/**
 * Compact diff of one observation against the previous one
 * (`--actions-diff-observe`, issue #2761). This is the DIFF arm of the
 * `observation` discriminated union (issue #6221 item 4): identified by
 * `isDiff: true`, which the full-object arm ({@link observationSummarySchema})
 * never carries.
 *
 * `skeleton` is ALWAYS present here (issue #6221 item 4.1) — the same
 * actionable-only rows `observe`/action tools emit on a full observation — so a
 * client always has a selector surface to act on, regardless of whether a
 * diff baseline happened to exist. Every entry's internal `key` is documented
 * as non-selector so it is never mistaken for one (item 4.3): `added`/`removed`
 * entries already carry a real selector directly in their `attributes`
 * (resource-id/view-id/text/content-desc), and `changed` entries — which do NOT
 * carry full attributes — get an explicit `selector` field recovered from the
 * same precedence.
 */
export const observeDiffSchema = z
  .object({
    keyboard: z.object({ visible: z.literal(true), package: z.string() }).optional(),
    isDiff: z.literal(true),
    observationId: observationIdSchema,
    deviceId: observationDeviceIdSchema,
    display: observationDisplaySchema,
    otherDisplays: otherDisplaysSchema,
    displayChanged: z
      .object({
        from: observationDisplaySchema.unwrap().pick({ key: true, role: true, posture: true }),
        to: observationDisplaySchema.unwrap().pick({ key: true, role: true, posture: true }),
      })
      .optional(),
    observationScreenshotResourceUri: observationScreenshotResourceUriSchema,
    snapshotReference: snapshotReferenceSchema,
    snapshotReferenceUnavailable: snapshotReferenceUnavailableSchema,
    rotation: observationRotationSchema,
    ...observationScreenshotOutputFields,
    skeleton: z
      .array(skeletonElementSchema)
      .describe(
        "Always present alongside a diff (issue #6221 item 4.1): the same " +
          "actionable-only selector surface a full observation's `skeleton` carries.",
      ),
    context: z
      .array(skeletonElementSchema)
      .optional()
      .describe(
        "Non-actionable state-readout rows from the same projection as `skeleton` " +
          "(issue #6221 item 1, #6256) — a timer countdown, a toggle's current-state " +
          "text — present only when at least one such row survived. Populated " +
          "alongside `skeleton` so a diff-mode response never silently drops the " +
          "readout a client needs to tell a failed input from a successful one.",
      ),
    activeWindow: activeWindowSchema
      .optional()
      .describe(
        "Same name/shape as a full observation's `activeWindow` (issue #6258): a " +
          "diff-mode response otherwise carries no `activeWindow` at all, leaving a " +
          "client no single accessor for 'what screen am I on' across full and diff " +
          "modes. Populated from the post-transition observation, not by " +
          "`diffObserveResult` itself.",
      ),
    freshness: freshnessSchema
      .optional()
      .describe(
        "Same name/shape as a full observation's `freshness` (issue #6258): a " +
          "diff-mode response otherwise carries no `freshness` at all, leaving a " +
          "client no single accessor for 'is this capture fresh' across full and " +
          "diff modes. Populated from the post-transition observation, not by " +
          "`diffObserveResult` itself.",
      ),
    screenSize: screenSizeSchema
      .optional()
      .describe(
        "Same platform-native coordinate space as a full observation's `screenSize` " +
          "and hierarchy/skeleton bounds; `units` identifies that space when present. " +
          "Populated from the post-action observation, " +
          "not by `diffObserveResult` itself.",
      ),
    truncationReasons: z
      .array(z.string())
      .optional()
      .describe(
        "Why the captured hierarchy is incomplete (issue #6601) — the same field " +
          "a full observation carries, so a client reads it the same way in both modes. " +
          "In diff mode (issue #6933), any reason — host-cap (max_children[...]) or " +
          "capture-fidelity (max_nodes, max_depth, max_children, cancelled) — may originate from either " +
          "comparison input (baseline or current capture), so its presence means the " +
          "comparison may be incomplete, not that this diff's own `skeleton`/`context` " +
          "omit rows.",
      ),
    windowTruncations: windowTruncationsSchema,
    settled: z
      .boolean()
      .optional()
      .describe(
        "Same name/meaning as a full observation's `settled` (issue #6866): whether " +
          "the observation this diff was computed from passed the hierarchy-stability " +
          "gate. Populated from the post-action observation, not by `diffObserveResult` " +
          "itself, so a diff-mode client has the same accessor as a full-mode one.",
      ),
    accessibilityAuditSkipped: z
      .literal("settled_capture_adopted")
      .optional()
      .describe(
        "Same name/meaning as a full observation's `accessibilityAuditSkipped` (issue #6926): `settled_capture_adopted` means a settled capture replaced the action's original capture, so its audit was deliberately dropped rather than mismatched onto the returned hierarchy.",
      ),
    added: z.array(observeDiffNodeSchema),
    removed: z.array(observeDiffNodeSchema),
    changed: z.array(observeDiffNodeChangeSchema),
    fields: z.record(z.string(), layoutWarningsDiffFieldSchema).optional(),
  })
  .passthrough();
requireObservationJoinKeysOnTheWire(observeDiffSchema);

/**
 * `observation`, as embedded on an action tool result (issue #6221 item 4): a
 * discriminated union of a full `ObserveResult` summary ({@link
 * observationSummarySchema}) and a compact diff ({@link observeDiffSchema}).
 * The discriminator is `isDiff`: present and `true` on the diff arm, absent on
 * the full arm — and REJECTED as `true` on the full arm (issue #6221 item 4,
 * PR #6242 review PRRT_kwDOP-GF5M6fq3iN), so a malformed diff (missing its
 * mandatory `skeleton`) cannot silently fall through and validate against the
 * full arm's `.passthrough()` instead. A client should branch on
 * `"isDiff" in observation && observation.isDiff === true` and, in EITHER
 * branch, can read `observation.skeleton` for a usable selector surface — the
 * diff arm always carries one (item 4.1).
 */
export const observationOutputSchema = z.union([
  observeDiffSchema,
  observationSummarySchema,
  toolOutputArtifactMetadataSchema,
]);

/** Shared optional action metadata, including finalized observation variants. */
const lifecycleActionOutputFields = {
  message: z.string(),
  success: z.boolean().optional(),
  observation: observationOutputSchema.optional(),
  observationDiff: observationDiffMetadataSchema.optional(),
  effect: tapEffectSchema.optional(),
  error: z.string().optional(),
  pinnedDisplay: pinnedDisplaySchema.optional(),
  displayInventory: displayInventoryUnavailableSchema.optional(),
  staleDisplay: staleDisplaySchema.optional(),
  warnings: z.array(z.string()).optional(),
};

export const pressButtonResultSchema = z
  .object({
    ...lifecycleActionOutputFields,
    button: z.string().optional(),
    keyCode: z.number().optional(),
  })
  .passthrough();

export const wakeAndUnlockResultSchema = z
  .object({
    message: z.string(),
    success: z.boolean().optional(),
    platform: platformSchema.optional(),
    wasAsleep: z.boolean().optional(),
    wasLocked: z.boolean().optional(),
    secure: z.boolean().optional(),
    unlocked: z.boolean().optional(),
    usedRecordedCredential: z.boolean().optional(),
    error: z.string().optional(),
    warning: z.string().optional(),
  })
  .passthrough();

export const launchAppResultSchema = z
  .object({
    ...lifecycleActionOutputFields,
    packageName: z.string().optional(),
    activityName: z.string().optional(),
    userId: z.number().optional(),
    pid: z.number().optional(),
    alreadyForeground: z.boolean().optional(),
    foregroundActivityPackage: z.string().optional(),
    verifiedBy: z.string().optional(),
    verified: z.boolean().optional(),
    verifyFailureReason: z.string().optional(),
    observedAppId: z.string().optional(),
    observationOmitted: z
      .object({
        reason: z.literal("stale_launch_observation"),
        expectedPackage: z.string(),
        reportedPackages: z.string(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const terminateAppResultSchema = z
  .object({
    ...lifecycleActionOutputFields,
    packageName: z.string().optional(),
    wasInstalled: z.boolean().optional(),
    wasRunning: z.boolean().optional(),
    wasForeground: z.boolean().optional(),
    userId: z.number().optional(),
  })
  .passthrough();

const deviceStateFieldOutputFields = {
  supported: z.boolean(),
  verified: z.boolean().optional(),
  method: z.string().optional(),
  warning: z.string().optional(),
  error: z.string().optional(),
};
const networkConditionValuesOutputSchema = z
  .object({
    delayMs: z.number(),
    downloadKbps: z.number(),
    uploadKbps: z.number(),
    packetLossPercent: z.number(),
  })
  .passthrough();

const deviceStateOutputFields = {
  message: z.string(),
  success: z.boolean().optional(),
  deviceId: z.string().optional(),
  platform: platformSchema.optional(),
  error: z.string().optional(),
  displays: z
    .object({
      panels: z.array(
        z
          .object({
            key: z.string(),
            role: observationDisplaySchema.unwrap().shape.role,
            sizePx: z.object({ width: z.number(), height: z.number() }).passthrough(),
            scale: z.number().optional(),
          })
          .passthrough(),
      ),
      postures: z.array(observationDisplaySchema.unwrap().shape.posture),
    })
    .passthrough()
    .optional(),
  unsupported: z.array(z.enum(DEVICE_STATE_READABLE_FIELDS)).optional(),
  doNotDisturb: z
    .object({
      ...deviceStateFieldOutputFields,
      enabled: z.boolean().optional(),
      mode: doNotDisturbModeSchema.optional(),
      rawValue: z.string().optional(),
      bestEffort: z.boolean().optional(),
      capability: z.string().optional(),
      requestedMode: doNotDisturbModeSchema.optional(),
      appliedMode: doNotDisturbModeSchema.optional(),
    })
    .passthrough()
    .optional(),
  biometrics: z
    .object({
      ...deviceStateFieldOutputFields,
      enrollment: biometricEnrollmentSchema.optional(),
    })
    .passthrough()
    .optional(),
  connectivity: z
    .object({
      ...deviceStateFieldOutputFields,
      airplaneMode: z.boolean().optional(),
      wifiEnabled: z.boolean().optional(),
      bluetoothEnabled: z.boolean().optional(),
      locationEnabled: z.boolean().optional(),
      rawValues: z.record(z.string(), z.string()).optional(),
    })
    .passthrough()
    .optional(),
  networkCondition: z
    .object({
      ...deviceStateFieldOutputFields,
      capability: z.string().optional(),
      profile: networkConditionProfileSchema.optional(),
      requestedProfile: networkConditionProfileSchema.optional(),
      appliedProfile: networkConditionProfileSchema.optional(),
      values: networkConditionValuesOutputSchema.optional(),
      observedValues: networkConditionValuesOutputSchema.partial().optional(),
      expiresInSeconds: z.number().optional(),
      rawStatus: z.string().optional(),
    })
    .passthrough()
    .optional(),
  location: z
    .object({
      ...deviceStateFieldOutputFields,
      mode: z.string().optional(),
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      stopped: z.boolean().optional(),
      previousRoute: z
        .object({ endedReason: z.string(), lastError: z.string().optional() })
        .passthrough()
        .optional(),
      waypointCount: z.number().optional(),
      totalDistanceMeters: z.number().optional(),
      expectedDurationMs: z.number().optional(),
      loop: z.boolean().optional(),
      updateIntervalMs: z.number().optional(),
    })
    .passthrough()
    .optional(),
  clock: z
    .object({
      ...deviceStateFieldOutputFields,
      capability: z.string(),
      instant: z.string().optional(),
      automaticTime: z.boolean().optional(),
      mode: z
        .union([
          deviceClockInputSchema.options[0].shape.mode,
          deviceClockInputSchema.options[1].shape.mode,
          deviceClockInputSchema.options[2].shape.mode,
        ])
        .optional(),
      requestedInstant: z.string().optional(),
      appliedInstant: z.string().optional(),
      readBack: z.boolean().optional(),
      toleranceMs: z.number().optional(),
      outcome: z.string().optional(),
    })
    .passthrough()
    .optional(),
};

/** Reads and writes share field states; early failures carry only identity and error. */
export const getDeviceStateResultSchema = z.object(deviceStateOutputFields).passthrough();
export const setDeviceStateResultSchema = z.object(deviceStateOutputFields).passthrough();

/** Rotation results include failures and successful orientation no-ops. */
export const rotateResultSchema = z
  .object({
    success: z.boolean(),
    orientation: z.string(),
    value: z.number(),
    message: z.string(),
    currentOrientation: z.string().optional(),
    previousOrientation: z.string().optional(),
    rotationPerformed: z.boolean().optional(),
    orientationLockHandled: z.boolean().optional(),
    orientationLockState: z.enum(["locked", "unlocked", "unknown"]).optional(),
    warning: z.string().optional(),
    observation: observationOutputSchema.optional(),
    observationDiff: observationDiffMetadataSchema.optional(),
    effect: tapEffectSchema.optional(),
    error: z.string().optional(),
    pinnedDisplay: pinnedDisplaySchema.optional(),
    displayInventory: displayInventoryUnavailableSchema.optional(),
    staleDisplay: staleDisplaySchema.optional(),
    warnings: z.array(z.string()).optional(),
  })
  .passthrough();

/** Unsupported iOS posture requests are results; operational failures throw. */
export const setPostureResultSchema = z
  .object({
    message: z.string(),
    status: z.literal("unsupported").optional(),
    posture: observationDisplaySchema.unwrap().shape.posture.optional(),
    hingeAngle: z.number().finite().optional(),
    observedHingeAngle: z.number().finite().optional(),
    postureReason: z.string().optional(),
    display: observationDisplaySchema,
    locked: z.boolean().optional(),
    warnings: z.array(z.string()).optional(),
  })
  .passthrough()
  .refine(
    (result) =>
      result.posture !== "unknown" ||
      (result.hingeAngle !== undefined && Boolean(result.postureReason)),
    "Unknown posture requires a hingeAngle request and postureReason.",
  );

export const tapOnResultSchema = z
  .object({
    success: z.boolean(),
    action: z.string().optional(),
    message: z.string().optional(),
    element: elementSchema.optional(),
    observation: observationOutputSchema.optional(),
    observationDiff: observationDiffMetadataSchema.optional(),
    effect: tapEffectSchema.optional(),
    selectedElement: selectedElementSchema.optional(),
    activatedSubtext: z
      .object({
        text: z.string(),
        occurrence: z.number().int().nonnegative(),
      })
      .optional()
      .describe("Semantic accessibility link confirmed by the native runner"),
    selectedElements: z.array(selectedElementSchema).optional(),
    skipped: z.literal("already-checked").optional(),
    error: z.string().optional(),
    pinnedDisplay: pinnedDisplaySchema.optional(),
    displayInventory: displayInventoryUnavailableSchema.optional(),
    staleDisplay: staleDisplaySchema.optional(),
    pressRecognized: z.boolean().optional(),
    contextMenuOpened: z.boolean().optional(),
    selectionStarted: z.boolean().optional(),
    searchUntil: tapOnSearchUntilSchema.optional(),
    screenReaderNavigation: screenReaderNavigationSchema.optional(),
    debug: z.any().optional(),
  })
  .passthrough();

/**
 * Progressive-disclosure scoping metadata (issue #4344), present only when a
 * per-call `scope.focus` / `scope.overview` / `scope.region` request scoped the
 * payload. `regionPx` routes through {@link elementBoundsSchema} so its bounds
 * advertise the compact tuple like every other bounds.
 */
export const observeScopeMetadataSchema = z
  .object({
    applied: z.array(z.enum(["focus", "region", "overview"])),
    gatedOff: z.array(z.enum(["focus", "region", "overview"])).optional(),
    nodesBefore: z.number().int().nonnegative(),
    nodesAfter: z.number().int().nonnegative(),
    regionPx: elementBoundsSchema.optional(),
    focus: z
      .object({
        by: z.enum(["anchor", "foreground-app"]),
        matched: z.boolean(),
        packageName: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Windowed perf snapshot (opt-in via AUTOMOBILE_OBSERVE_PERF_SNAPSHOT). */
const perfSnapshotSchema = z.object({
  windowMs: z.number(),
  sampleCount: z.number().int().nonnegative(),
  oldestSampleAgeMs: z.number().nullable(),
  fps: z
    .object({
      p50: z.number(),
      p90: z.number(),
      p95: z.number(),
      p99: z.number(),
    })
    .nullable(),
  frameTimeMs: z
    .object({
      p50: z.number(),
      p90: z.number(),
      p95: z.number(),
      p99: z.number(),
    })
    .nullable(),
  jank: z.object({ total: z.number(), perSecond: z.number().nullable() }).nullable(),
  touchLatencyMs: z.object({ p50: z.number(), p95: z.number(), latest: z.number() }).nullable(),
  cpu: z.object({ avg: z.number(), latest: z.number() }).nullable(),
  memoryMb: z.object({ avg: z.number(), latest: z.number() }).nullable(),
  memoryBreakdownMb: z
    .object({
      javaHeap: z.number().nullable(),
      nativeHeap: z.number().nullable(),
      code: z.number().nullable(),
      stack: z.number().nullable(),
      graphics: z.number().nullable(),
      privateOther: z.number().nullable(),
      system: z.number().nullable(),
    })
    .nullable(),
  startup: z.object({ displayedMs: z.number(), ageMs: z.number() }).nullable(),
});

export const displayObservationSchema = z.object({
  display: observationDisplaySchema.nonoptional(),
  screenSize: screenSizeSchema,
  viewHierarchy: viewHierarchyResultSchema.optional(),
  skeleton: z.array(skeletonElementSchema).optional(),
  context: z.array(skeletonElementSchema).optional(),
  keyboard: z.object({ visible: z.literal(true), package: z.string() }).optional(),
  truncationReasons: z.array(z.string()).optional(),
  windowTruncations: windowTruncationsSchema,
  screenshotPath: z.string().optional(),
  screenshotExpiresAt: z.number().optional(),
  observeScope: observeScopeMetadataSchema.optional(),
  freshness: freshnessSchema,
});

export const observeResultSchema = z
  .object({
    keyboard: z.object({ visible: z.literal(true), package: z.string() }).optional(),
    observationId: observationIdSchema,
    deviceId: observationDeviceIdSchema,
    display: observationDisplaySchema,
    otherDisplays: otherDisplaysSchema,
    displays: z
      .array(displayObservationSchema)
      .optional()
      .describe(
        "Opt-in Android display:all observations, including the active panel. Proposed additive shape; absent on default reads or without inventory. Each panel uses the requested projection; unavailable panels retain freshness reasons.",
      ),
    observationScreenshotResourceUri: observationScreenshotResourceUriSchema,
    snapshotReference: snapshotReferenceSchema,
    snapshotReferenceUnavailable: snapshotReferenceUnavailableSchema,
    rotation: observationRotationSchema,
    ...observationScreenshotOutputFields,
    crop: observeCropResultSchema.optional(),
    screenSize: screenSizeSchema.optional(),
    systemInsets: systemInsetsSchema.optional(),
    insets: observationInsetsSchema.optional(),
    layoutWarnings: z
      .object({
        scope: z.enum(["full", "truncated", "scoped"]),
        total: z.number().optional(),
        warnings: z.array(layoutWarningSchema),
      })
      .optional(),
    viewHierarchy: viewHierarchyResultSchema.optional(),
    truncationReasons: z
      .array(z.string())
      .optional()
      .describe(
        "Why a served observation or diff may be incomplete (issues #6601, #6933). " +
          "On a non-diff skeleton projection, this contains only capture-fidelity reasons " +
          "(device-side max_nodes, max_depth, max_children, cancelled); its presence means `skeleton`/" +
          "`context` omit rows. A host-output max_children[<node> kept N of M] cap trims " +
          "only rendered `viewHierarchy` and is not lifted to a non-diff skeleton. On a " +
          "diff, any reason — host-cap (max_children[...]) or capture-fidelity (max_nodes, " +
          "max_depth, max_children, cancelled) — may originate from either comparison input (baseline or " +
          "current capture), so its presence means the comparison may be incomplete rather " +
          "than that the current `skeleton`/`context` omit rows (issue #6933).",
      ),
    windowTruncations: windowTruncationsSchema,
    skeleton: z.array(skeletonElementSchema).optional(),
    context: z
      .array(skeletonElementSchema)
      .optional()
      .describe(
        "Non-actionable rows (affordances: []) from the same projection as `skeleton` " +
          "(issue #6221 item 1) — a screen title, a standalone notification, or the " +
          "com.android.systemui status bar (collapsed to one summarized entry). " +
          'Present only under project:"skeleton" (the default) when at least one ' +
          "such row survived.",
      ),
    activeWindow: activeWindowSchema.optional(),
    screenIdentity: screenIdentitySchema.optional(),
    elements: observeElementsSchema.optional(),
    selectedElements: z.array(selectedElementSchema).optional(),
    focusedElement: elementSchema.optional(),
    accessibilityFocusedElement: elementSchema.optional(),
    awaitedElement: elementSchema.optional(),
    matched: z.boolean().optional(),
    settled: z.boolean().optional(),
    accessibilityAuditSkipped: z
      .literal("settled_capture_adopted")
      .optional()
      .describe(
        "Why a requested accessibility audit was omitted from this observation (issue #6926): `settled_capture_adopted` means a settled capture replaced the action's original capture, so its audit was deliberately dropped rather than mismatched onto the returned hierarchy.",
      ),
    timedOut: z.boolean().optional(),
    timeoutReason: z
      .string()
      .optional()
      .describe("Posture wait timeout with the last observed posture"),
    polls: z.number().int().nonnegative().optional(),
    waitMs: z.number().nonnegative().optional(),
    matchedElement: elementSchema.optional(),
    candidates: z.array(elementSchema).optional(),
    hierarchyServiceStarted: z
      .boolean()
      .optional()
      .describe(
        "Present only when this session-less read started the hierarchy service on an unowned device.",
      ),
    freshness: freshnessSchema.optional(),
    predictions: predictionsSchema.optional(),
    accessibilityState: accessibilityStateSchema.optional(),
    deviceLock: deviceLockSchema.optional(),
    perfSnapshot: perfSnapshotSchema.optional(),
    observeScope: observeScopeMetadataSchema.optional(),
  })
  .passthrough();
requireObservationJoinKeysOnTheWire(observeResultSchema);

export const observeToolResultSchema = z.union([
  observeResultSchema,
  toolOutputArtifactMetadataSchema,
]);
requireObservationJoinKeysOnFlattenedUnion(observeToolResultSchema);
