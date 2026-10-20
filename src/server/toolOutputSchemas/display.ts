import { z } from "zod/v4";

export const displayInventoryUnavailableSchema = z.object({
  pin: z.string().optional(),
  retryable: z.literal(true),
});

export const pinnedDisplaySchema = z.object({
  pin: z.string(),
  availablePanels: z.array(
    z.object({ key: z.string(), role: z.enum(["inner", "cover", "rear", "external", "unknown"]) }),
  ),
});

export const staleDisplaySchema = z.object({
  observedGeneration: z.number().int().nonnegative(),
  currentGeneration: z.number().int().nonnegative(),
  currentDisplayKey: z.string().optional(),
  retry: z.literal("observe"),
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
export const boundsObjectSchema = z.object({
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
export const compactBoundsTupleSchema = z
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

export const observationInsetsSchema = z.object({
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

export const layoutWarningSchema = z.object({
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

export const layoutWarningsDiffFieldSchema = z.union([
  z.object({ from: z.unknown().optional(), to: z.unknown().optional() }).strict(),
  layoutWarningsPerEntryDiffSchema,
]);

/** Parse old captures leniently while requiring the stamp on emitted observations. */
export const observationDisplaySchema = z
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

export const otherDisplaysSchema = z
  .array(
    z.object({
      key: z.string(),
      role: z.enum(["inner", "cover", "rear", "external", "unknown"]),
      size: z.object({ width: z.number(), height: z.number() }),
    }),
  )
  .optional();
