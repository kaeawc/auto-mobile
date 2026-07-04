import { z } from "zod";

// Android accessibility returns boolean attributes as strings ("true"/"false")
// This schema accepts both for compatibility
const booleanOrString = z.union([z.boolean(), z.literal("true"), z.literal("false")]).optional();

// Default (verbose) bounds shape: the four-key object plus optional centers.
const boundsObjectSchema = z.object({
  left: z.number().int(),
  top: z.number().int(),
  right: z.number().int(),
  bottom: z.number().int(),
  centerX: z.number().int().optional(),
  centerY: z.number().int().optional()
});

// Compact bounds shape emitted only when the `--observe-result-compact` output-
// reduction flag (env `AUTOMOBILE_OBSERVE_RESULT_COMPACT`) is set: the object is
// flattened to the positional tuple `[left, top, right, bottom]` (issue #2990).
// The tuple carries no centers — a consumer derives them as (left+right)/2,
// (top+bottom)/2. This is a fixed-length 4-tuple so it round-trips losslessly.
const compactBoundsTupleSchema = z
  .tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()])
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
