import { z } from "zod/v4";
import {
  elementBoundsSchema,
  systemInsetsSchema,
  observationInsetsSchema,
  compactBoundsTupleSchema,
} from "./display";

// Android accessibility returns boolean attributes as strings ("true"/"false")
// This schema accepts both for compatibility
const booleanOrString = z.union([z.boolean(), z.literal("true"), z.literal("false")]).optional();

const semanticLinkSchema = z.object({
  text: z.string().min(1),
  occurrence: z.number().int().nonnegative(),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
});

export const elementSchema = z
  .object({
    bounds: elementBoundsSchema,
    text: z.string().optional(),
    "resource-id": z.string().optional(),
    "view-id": z
      .string()
      .optional()
      .describe(
        "Android synthetic s2- ids are valid only for the observation that returned them; re-observe after the screen changes.",
      ),
    "content-desc": z.string().optional(),
    occlusionState: z.string().optional(),
    occludedBy: z.string().optional(),
    occludedByViewId: z.string().optional(),
    occluded: z
      .literal(true)
      .optional()
      .describe(
        "Android full projection: an application window or AutoMobile prototype fully covers this row, so tapOn refuses it; its accessibility actions are omitted.",
      ),
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
      occluded: z.literal(true).optional(),
      node: z.union([viewHierarchyNodeSchema, z.array(viewHierarchyNodeSchema)]).optional(),
    })
    .passthrough()
    .describe(
      "Android synthetic s2- ids are valid only for the observation that returned them; re-observe after the screen changes.",
    ),
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

export const windowTruncationsSchema = z
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
export const observeElementsSchema = z
  .object({
    clickable: z.array(viewHierarchyNodeSchema),
    scrollable: z.array(viewHierarchyNodeSchema),
    text: z.array(viewHierarchyNodeSchema),
    media: z.array(observeMediaSchema),
  })
  .passthrough();

/**
 * One row of the Interactable Skeleton Projection (issue #4388). The observe
 * output projects to `"skeleton"` by default (a per-call `project: "full"` or
 * `raw: true` opts out); it then replaces `viewHierarchy` / `elements`. Bounds
 * are always the compact `[left, top, right, bottom]` tuple, so this uses the
 * tuple schema directly rather than the `elementBoundsSchema` union.
 */
export const skeletonElementSchema = z
  .object({
    elementId: z
      .string()
      .optional()
      .describe(
        "Android synthetic s2- ids are valid only for the observation that returned them; re-observe after the screen changes.",
      ),
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
        "Fully covered by the Android IME window or the visible iOS keyboard, or an iOS row with no visible tap area: off screen, under a navigation/status/tab bar, scrolled out of its scroll container, or covered by another control; this row has no actionable affordance.",
      ),
    checked: z.boolean().optional(),
    selected: z
      .literal(true)
      .optional()
      .describe("AutoMobile prototype rows only: the selected tab or option."),
    state: z
      .string()
      .optional()
      .describe("AutoMobile prototype rows only: the node's state description, e.g. Page 1 of 3."),
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
