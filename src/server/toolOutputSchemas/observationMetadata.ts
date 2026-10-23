import { z } from "zod/v4";
import { elementBoundsSchema } from "./display";

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

export const screenIdentitySchema = z
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

export const observationDiffMetadataSchema = z
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

export const tapEffectSchema = z
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
        "runner_stalled",
        "connection_lost",
        "simulator_not_booted",
        "request_timed_out",
        "auto_setup_failed",
        "unknown",
        "service_recovering",
        "device_locked",
        "incomplete_capture",
        "runner_unavailable",
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

/** Android and iOS simulator device-lock signal; `secure` omitted when undeterminable. */
export const deviceLockSchema = z.object({
  locked: z.boolean(),
  keyguardShowing: z.boolean(),
  secure: z.boolean().optional(),
});

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
export const perfSnapshotSchema = z.object({
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

export const deviceLockUnknownSchema = z.object({
  reason: z.enum(["timeout", "pending", "error", "unparseable"]),
  message: z.string().optional(),
});
