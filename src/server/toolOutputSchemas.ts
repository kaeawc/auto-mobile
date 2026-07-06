import { z } from "zod";

// Android accessibility returns boolean attributes as strings ("true"/"false")
// This schema accepts both for compatibility
const booleanOrString = z.union([z.boolean(), z.literal("true"), z.literal("false")]).optional();

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
  centerY: z.number().optional()
});

// Compact bounds shape emitted only when the `--observe-result-compact` output-
// reduction flag (env `AUTOMOBILE_OBSERVE_RESULT_COMPACT`) is set: the object is
// flattened to the positional tuple `[left, top, right, bottom]` (issue #2990).
// The tuple carries no centers — a consumer derives them as (left+right)/2,
// (top+bottom)/2. This is a fixed-length 4-tuple so it round-trips losslessly.
const compactBoundsTupleSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .describe(
    "Compact bounds tuple [left, top, right, bottom]; emitted in place of the " +
      "{left, top, right, bottom} object only when the --observe-result-compact " +
      "flag (env AUTOMOBILE_OBSERVE_RESULT_COMPACT) is set."
  );

/**
 * Bounds as advertised on the wire. The default is the `{left, top, right,
 * bottom}` object; under `--observe-result-compact` it is the positional tuple
 * `[left, top, right, bottom]`. Every output schema that carries a `bounds` field
 * (elements, focused/selected elements, …) routes through this union so the
 * advertised `outputSchema` describes — and a strict MCP client validates —
 * whichever shape the server is actually emitting (issue #2990).
 *
 * The tuple arm is advertised in `tools/list` only when the flag is on: at
 * generation time `advertiseBoundsForCompact` (`compactBoundsAdvertisement.ts`)
 * collapses this union to its object arm when compaction is off, so the advertised
 * shape stays honest-by-default. The `.describe()` prefix below is the stable
 * marker that helper keys off — keep them in sync.
 */
export const elementBoundsSchema = z
  .union([boundsObjectSchema, compactBoundsTupleSchema])
  .describe(
    "Element bounds. Default: object {left, top, right, bottom} (+ optional " +
      "centerX/centerY). Under --observe-result-compact: positional tuple " +
      "[left, top, right, bottom]."
  );

export const elementSchema = z.object({
  "bounds": elementBoundsSchema,
  "text": z.string().optional(),
  "resource-id": z.string().optional(),
  "content-desc": z.string().optional(),
  "class": z.string().optional(),
  "package": z.string().optional(),
  "checkable": booleanOrString,
  "checked": booleanOrString,
  "clickable": booleanOrString,
  "enabled": booleanOrString,
  "focusable": booleanOrString,
  "focused": booleanOrString,
  "accessibility-focused": booleanOrString,
  "scrollable": booleanOrString,
  "selected": booleanOrString
}).passthrough();

const selectedElementStateSchema = z.object({
  method: z.enum(["accessibility", "visual"]),
  confidence: z.number(),
  reason: z.string().optional()
});

export const selectedElementSchema = z.object({
  text: z.string().optional(),
  resourceId: z.string().optional(),
  contentDesc: z.string().optional(),
  bounds: elementBoundsSchema.optional(),
  indexInMatches: z.number().int().optional(),
  totalMatches: z.number().int().optional(),
  selectionStrategy: z.string().optional(),
  selectedState: selectedElementStateSchema.optional()
}).passthrough();

export const activeWindowSchema = z.object({
  appId: z.string().optional(),
  activityName: z.string().optional(),
  layoutSeqSum: z.number().int().optional(),
  type: z.string().optional()
}).passthrough();

export const observationSummarySchema = z.object({
  selectedElements: z.array(selectedElementSchema).optional(),
  focusedElement: elementSchema.optional(),
  accessibilityFocusedElement: elementSchema.optional(),
  activeWindow: activeWindowSchema.optional()
}).passthrough();

const tapOnSearchUntilSchema = z.object({
  durationMs: z.number().int(),
  requestCount: z.number().int(),
  changeCount: z.number().int()
}).passthrough();

export const tapOnResultSchema = z.object({
  success: z.boolean(),
  action: z.string().optional(),
  message: z.string().optional(),
  element: elementSchema.optional(),
  observation: observationSummarySchema.optional(),
  selectedElement: selectedElementSchema.optional(),
  selectedElements: z.array(selectedElementSchema).optional(),
  error: z.string().optional(),
  pressRecognized: z.boolean().optional(),
  contextMenuOpened: z.boolean().optional(),
  selectionStarted: z.boolean().optional(),
  searchUntil: tapOnSearchUntilSchema.optional(),
  debug: z.any().optional()
}).passthrough();

export const screenSizeSchema = z.object({
  width: z.number().int(),
  height: z.number().int()
});

export const systemInsetsSchema = z.object({
  top: z.number().int(),
  right: z.number().int(),
  bottom: z.number().int(),
  left: z.number().int()
});

export const scrollableCandidateSchema = z.object({
  elementId: z.string().optional(),
  text: z.string().optional(),
  contentDesc: z.string().optional(),
  className: z.string().optional()
}).passthrough();

const predictionTargetSchema = z.object({
  text: z.string().optional(),
  elementId: z.string().optional(),
  contentDesc: z.string().optional(),
  container: z.object({
    text: z.string().optional(),
    elementId: z.string().optional(),
    contentDesc: z.string().optional()
  }).optional(),
  lookFor: z.object({
    text: z.string().optional(),
    elementId: z.string().optional(),
    contentDesc: z.string().optional()
  }).optional()
}).passthrough();

const predictedActionSchema = z.object({
  action: z.string(),
  target: predictionTargetSchema,
  predictedScreen: z.string(),
  predictedElements: z.array(z.string()).optional(),
  confidence: z.number()
}).passthrough();

const interactablePredictionSchema = z.object({
  elementId: z.string().optional(),
  elementText: z.string().optional(),
  elementContentDesc: z.string().optional(),
  predictedOutcome: z.object({
    screenName: z.string(),
    basedOn: z.enum(["navigation_graph"])
  }).optional()
}).passthrough();

export const predictionsSchema = z.object({
  likelyActions: z.array(predictedActionSchema),
  interactableElements: z.array(interactablePredictionSchema)
}).passthrough();

export const freshnessSchema = z.object({
  requestedAfter: z.number().int().optional(),
  actualTimestamp: z.number().int().optional(),
  isFresh: z.boolean(),
  staleDurationMs: z.number().int().optional(),
  warning: z.string().optional()
}).passthrough();

export const accessibilityStateSchema = z.object({
  enabled: z.boolean(),
  service: z.enum(["talkback", "voiceover", "unknown"])
}).passthrough();

export const accessibilityFocusResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  warning: z.string().optional(),
  focusedElement: elementSchema.optional()
}).passthrough();

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
  z.object({
    bounds: elementBoundsSchema.optional(),
    node: z.union([viewHierarchyNodeSchema, z.array(viewHierarchyNodeSchema)]).optional()
  }).passthrough()
);

const hierarchyNodeField = z
  .union([viewHierarchyNodeSchema, z.array(viewHierarchyNodeSchema)])
  .optional();

const contentHiddenRegionSchema = z.object({
  bounds: elementBoundsSchema,
  reason: z.string(),
  areaPercent: z.number()
}).passthrough();

const viewHierarchyWindowSchema = z.object({
  bounds: elementBoundsSchema.optional(),
  hierarchy: viewHierarchyNodeSchema.optional()
}).passthrough();

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
export const viewHierarchyResultSchema = z.object({
  "hierarchy": z.object({
    error: z.string().optional(),
    node: hierarchyNodeField
  }).passthrough().optional(),
  // Real captures emit `null` (not an absent key) for the empty case, so these
  // are nullish rather than merely optional.
  "windows": z.array(viewHierarchyWindowSchema).nullish(),
  "contentHiddenRegions": z.array(contentHiddenRegionSchema).nullish(),
  "accessibility-focused-element": viewHierarchyNodeSchema.optional(),
  "systemInsets": systemInsetsSchema.optional()
}).passthrough();

/**
 * A `MediaView` entry from the `elements.media` array. Real captures carry an
 * object `bounds`, and `compactObserveBounds` flattens it to a tuple like every
 * other bounds, so it routes through {@link elementBoundsSchema} too (its other
 * fields — `mediaType`, `className`, `resourceId`, … — ride `.passthrough()`).
 */
const observeMediaSchema = z.object({
  bounds: elementBoundsSchema.optional()
}).passthrough();

/**
 * The flattened `elements` block of an observe result. Each category is an array
 * of bounds-carrying entries — `clickable`/`scrollable`/`text` are
 * hierarchy-node-shaped (bounds + nested `node`), `media` is a MediaView — so
 * every entry's `bounds` routes through the union and advertises the compact
 * tuple at every depth.
 */
const observeElementsSchema = z.object({
  clickable: z.array(viewHierarchyNodeSchema),
  scrollable: z.array(viewHierarchyNodeSchema),
  text: z.array(viewHierarchyNodeSchema),
  media: z.array(observeMediaSchema)
}).passthrough();

/**
 * Machine-readable `outputSchema` for the headline `observe` tool (issue #3025).
 *
 * `observe`'s payload is large and dynamic (the hierarchy `node` field is
 * polymorphic; `elements` duplicates the tree), so this follows the pragmatic
 * middle ground the issue calls for: a `.passthrough()` top level with typed
 * `viewHierarchy`/`elements`/`bounds` sub-schemas. The value it buys is that
 * *every* `bounds` field — hierarchy nodes, window/root/region, `elements`, and
 * the focused/awaited element fields — routes through {@link elementBoundsSchema},
 * so the `--observe-result-compact` tuple is advertised here (via
 * `advertiseBoundsForCompact` in `getToolDefinitions`) exactly as it is on the
 * schema-declaring action tools (`tapOn`, `accessibilityFocus`). Unmodeled fields
 * (perf timing, back stack, wakefulness, user id, errors, …) pass through so the
 * advertisement never rejects a real observation.
 */
export const observeResultSchema = z.object({
  screenSize: screenSizeSchema.optional(),
  systemInsets: systemInsetsSchema.optional(),
  viewHierarchy: viewHierarchyResultSchema.optional(),
  activeWindow: activeWindowSchema.optional(),
  elements: observeElementsSchema.optional(),
  selectedElements: z.array(selectedElementSchema).optional(),
  focusedElement: elementSchema.optional(),
  accessibilityFocusedElement: elementSchema.optional(),
  awaitedElement: elementSchema.optional(),
  freshness: freshnessSchema.optional(),
  predictions: predictionsSchema.optional(),
  accessibilityState: accessibilityStateSchema.optional()
}).passthrough();
