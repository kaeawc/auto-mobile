import { z } from "zod/v4";

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
      "schema-valid.",
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

export const observationSummarySchema = z
  .object({
    selectedElements: z.array(selectedElementSchema).optional(),
    focusedElement: elementSchema.optional(),
    accessibilityFocusedElement: elementSchema.optional(),
    activeWindow: activeWindowSchema.optional(),
    screenIdentity: screenIdentitySchema.optional(),
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
    fromScreen: observationDiffScreenIdentitySchema.optional(),
    toScreen: observationDiffScreenIdentitySchema.optional(),
  })
  .passthrough();

const toolOutputArtifactDetailsSchema = z
  .object({
    path: z.string(),
    format: z.literal("json"),
    payload: z.string(),
    bytes: z.number().int().nonnegative(),
    tool: z.string(),
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
    reachable: z.boolean().describe("Whether swipe cursor navigation reached the target"),
    traversalOrder: z.array(elementSchema).describe("Focused nodes in cursor traversal order"),
    focusTrapDetected: z
      .boolean()
      .describe("Whether cursor navigation got stuck or failed to converge"),
  })
  .passthrough();

export const tapOnResultSchema = z
  .object({
    success: z.boolean(),
    action: z.string().optional(),
    message: z.string().optional(),
    element: elementSchema.optional(),
    observation: z.union([observationSummarySchema, toolOutputArtifactMetadataSchema]).optional(),
    observationDiff: observationDiffMetadataSchema.optional(),
    selectedElement: selectedElementSchema.optional(),
    activatedSubtext: z
      .object({
        text: z.string(),
        occurrence: z.number().int().nonnegative(),
      })
      .optional()
      .describe("Semantic accessibility link confirmed by the native runner"),
    selectedElements: z.array(selectedElementSchema).optional(),
    error: z.string().optional(),
    pressRecognized: z.boolean().optional(),
    contextMenuOpened: z.boolean().optional(),
    selectionStarted: z.boolean().optional(),
    searchUntil: tapOnSearchUntilSchema.optional(),
    screenReaderNavigation: screenReaderNavigationSchema.optional(),
    debug: z.any().optional(),
  })
  .passthrough();

export const screenSizeSchema = z.object({
  width: z.number().int(),
  height: z.number().int(),
});

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

const displayCutoutInfoSchema = z.object({
  classification: z.enum(["none", "notch", "dynamic_island", "hole_punch", "unknown"]),
  // Platform metadata reports a list of bounds objects. The tuple arm preserves
  // forward compatibility should a producer compact those rectangles.
  bounds: z.array(elementBoundsSchema).optional(),
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
  })
  .passthrough();

export const accessibilityStateSchema = z
  .object({
    enabled: z.boolean(),
    service: z.enum(["talkback", "voiceover", "unknown"]),
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
  })
  .passthrough();

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
  })
  .passthrough();

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
/** Android device-lock signal (issue #4235); `secure` omitted when undeterminable. */
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
    id: z.string().optional(),
    label: z.string().optional(),
    testTag: z.string().optional(),
    semanticLinks: z.array(semanticLinkSchema).optional(),
    bounds: compactBoundsTupleSchema.describe(
      "Bounds as the compact [left, top, right, bottom] tuple — always this shape " +
        "for skeleton entries.",
    ),
    affordances: z.array(z.enum(["tap", "long-press", "input", "scroll", "toggle"])),
    checked: z.boolean().optional(),
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

export const observeResultSchema = z
  .object({
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
    skeleton: z.array(skeletonElementSchema).optional(),
    activeWindow: activeWindowSchema.optional(),
    screenIdentity: screenIdentitySchema.optional(),
    elements: observeElementsSchema.optional(),
    selectedElements: z.array(selectedElementSchema).optional(),
    focusedElement: elementSchema.optional(),
    accessibilityFocusedElement: elementSchema.optional(),
    awaitedElement: elementSchema.optional(),
    matched: z.boolean().optional(),
    settled: z.boolean().optional(),
    timedOut: z.boolean().optional(),
    polls: z.number().int().nonnegative().optional(),
    waitMs: z.number().nonnegative().optional(),
    matchedElement: elementSchema.optional(),
    candidates: z.array(elementSchema).optional(),
    freshness: freshnessSchema.optional(),
    predictions: predictionsSchema.optional(),
    accessibilityState: accessibilityStateSchema.optional(),
    deviceLock: deviceLockSchema.optional(),
    perfSnapshot: perfSnapshotSchema.optional(),
    observeScope: observeScopeMetadataSchema.optional(),
  })
  .passthrough();

export const observeToolResultSchema = z.union([
  observeResultSchema,
  toolOutputArtifactMetadataSchema,
]);
