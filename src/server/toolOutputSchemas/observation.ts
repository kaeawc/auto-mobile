import { z } from "zod/v4";
import {
  observationIdSchema,
  observationDeviceIdSchema,
  observationScreenshotResourceUriSchema,
  snapshotReferenceSchema,
  snapshotReferenceUnavailableSchema,
  observationRotationSchema,
  observationScreenshotOutputFields,
  requireObservationJoinKeysOnTheWire,
  observeCropResultSchema,
  requireObservationJoinKeysOnFlattenedUnion,
} from "./observationContract";
import {
  observationDisplaySchema,
  otherDisplaysSchema,
  screenSizeSchema,
  layoutWarningsDiffFieldSchema,
  systemInsetsSchema,
  observationInsetsSchema,
  layoutWarningSchema,
} from "./display";
import {
  selectedElementSchema,
  elementSchema,
  viewHierarchyResultSchema,
  windowTruncationsSchema,
  skeletonElementSchema,
  observeElementsSchema,
} from "./elements";
import {
  activeWindowSchema,
  screenIdentitySchema,
  freshnessSchema,
  toolOutputArtifactMetadataSchema,
  observeScopeMetadataSchema,
  predictionsSchema,
  deviceLockSchema,
  deviceLockUnknownSchema,
  perfSnapshotSchema,
} from "./observationMetadata";
import { accessibilityStateSchema } from "./accessibility";

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
    settleMs: z
      .number()
      .optional()
      .describe(
        "Milliseconds the hierarchy-stability gate spent re-observing (issue #9591). Present only when the gate ran. With `settled: false`, a value near the gate's budget means the screen kept changing or each read was slow; a value well below it means the gate stopped early.",
      ),
    settlePolls: z
      .number()
      .optional()
      .describe(
        "Re-observations the hierarchy-stability gate took (issue #9591). Two are needed to settle; fewer at the budget means reads were too slow to compare.",
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
    elementId: z
      .string()
      .optional()
      .describe(
        "Android synthetic s2- ids are valid only for the observation that returned them; re-observe after the screen changes.",
      ),
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
    settleMs: z
      .number()
      .optional()
      .describe(
        "Same name/meaning as a full observation's `settleMs` (issue #9591), copied from the post-action observation.",
      ),
    settlePolls: z
      .number()
      .optional()
      .describe(
        "Same name/meaning as a full observation's `settlePolls` (issue #9591), copied from the post-action observation.",
      ),
    accessibilityAuditSkipped: z
      .literal("settled_capture_adopted")
      .optional()
      .describe(
        "Same name/meaning as a full observation's `accessibilityAuditSkipped` (issue #6926): `settled_capture_adopted` means a settled capture replaced the action's original capture, so its audit was deliberately dropped rather than mismatched onto the returned hierarchy.",
      ),
    added: z
      .array(observeDiffNodeSchema)
      .optional()
      .describe(
        "Absent on action-observation diffs: the diff's `skeleton` already lists every actionable node on the current screen (#11637).",
      ),
    removed: z
      .array(observeDiffNodeSchema)
      .optional()
      .describe(
        "Absent on action-observation diffs: the diff's `skeleton` already lists every actionable node on the current screen (#11637).",
      ),
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
    isScreenRound: z
      .boolean()
      .optional()
      .describe(
        "Wear OS (watch devices) only: true when the display is round, so the corners are cut off.",
      ),
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
    deviceLockUnknown: deviceLockUnknownSchema.optional(),
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
