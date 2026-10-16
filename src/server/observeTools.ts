import { MAX_WAIT_FOR_TIMEOUT_MS } from "../features/observe/waitForTimeout";
import { publishScreenshotPaths } from "../features/observe/ScreenshotRetention";
import { iosAgentHidesPrototypeForCapture } from "../features/prototype/ios/iosCapturePrototypeHider";
import { readObservationForInteractions } from "./identifyInteractionsObservation";
import {
  screenshotPathProtection,
  type ScreenshotPathProtection,
} from "../features/observe/ScreenshotPathProtection";
import { toActionableError } from "../models/ActionableError";
import { errorMessage } from "../utils/describeUnknownError";
import { displayWaitInventory } from "../utils/deviceMatcher";
import { z } from "zod/v4";
import {
  screenshotOptionsSchema,
  type ObserveScreenshotOptions,
} from "../features/observe/screenshot/screenshotOptions";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY } from "../features/observe/android/ctrlProxyProtocol";
import { ToolRegistry } from "./toolRegistry";
import { stripInternalToolParams } from "./internalToolParams";
import {
  getToolSelectionContext,
  isSessionlessDeviceRead,
} from "../features/toolSelection/toolSelectionContext";
import { INTERNAL_MCP_REQUEST_DEADLINE_PARAM } from "../daemon/constants";
import { assertAllDisplayObserveSupported } from "../features/observe/DisplaySelection";
import { sessionlessDeviceReadFor, type DeviceObservationAccess } from "./deviceObservationAccess";
import { ResourceRegistry } from "./resourceRegistry";
import { RESOURCE_URIS } from "./observationResources";
import { OBSERVE_APP_RESOURCE_URI } from "./observeAppResource";
import { ActionableError } from "../models/ActionableError";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { snapshotReferences } from "../features/observe/SnapshotReferenceStore";
import type { ObserveScreen } from "../features/observe/interfaces/ObserveScreen";
import {
  createJSONToolResponse,
  createStructuredToolResponse,
  StructuredToolResponse,
} from "../utils/toolUtils";
import { BootedDevice, ObserveResult, ObserveToolPayload } from "../models";
import { createGlobalPerformanceTracker } from "../utils/PerformanceTracker";
import { NavigationGraphManager } from "../features/navigation/NavigationGraphManager";
import {
  IdentifyInteractions,
  IdentifyInteractionsOptions,
} from "../features/observe/IdentifyInteractions";
import {
  addDeviceTargetingToSchema,
  JsonSchemaOverride,
  platformSchema,
  withAppIdAliases,
  withJsonSchemaOverride,
} from "./toolSchemaHelpers";
import {
  hierarchyLayerSchema,
  nestedElementContainerSchema,
  resolverSelectionStrategySchema,
} from "./elementSelectorSchemas";
import {
  hasOwnPrototype,
  scopeHierarchyForSelector,
  scopeObserveResultToLayer,
} from "../features/observe/hierarchyLayer";
import type { HierarchyLayer } from "../models/HierarchyLayer";
import { observeToolResultSchema } from "./toolOutputSchemas";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { consumeSetupTiming } from "./ToolExecutionContext";
import { AndroidCtrlProxyManager } from "../ctrlProxy/CtrlProxyManager";
import { accessibilityDetector } from "../features/accessibility/AccessibilityDetector";
import type { AccessibilityDetector } from "../features/accessibility/interfaces/AccessibilityDetector";
import { DaemonState } from "../daemon/daemonState";
import { logger } from "../utils/logger";
import { type ScreenshotMode } from "../features/observe/automaticScreenshotPolicy";
import { inlineScreenshotImage } from "../features/observe/screenshot/inlineScreenshotImage";
import {
  createObserveCrop,
  observeCropSchema,
  type ObserveCropDependencies,
} from "../features/observe/screenshot/observeCrop";
import {
  applyObserveScopeExperiments,
  buildObserveScopeConfig,
} from "../features/observe/output/ObserveScopeExperiments";
import {
  hasElementPredicate,
  waitForObservation,
  type WaitForObservationOutcome,
} from "./observeWaitEvaluation";

// The waitFor / settle evaluation lives in ./observeWaitEvaluation (#11828); these names stay
// importable from here.
export {
  buildConditionPredicate,
  findWaitForElement,
  hashHierarchyForSettle,
  waitForObservation,
  type WaitForObservationOutcome,
} from "./observeWaitEvaluation";

// Schema definitions
// waitFor accepts legacy selectors plus richer predicates. Element predicates are
// evaluated against the same node unless matchType is explicitly "any".
const waitForContainerField = nestedElementContainerSchema
  .optional()
  .describe(
    "Nested container scope; outermost resolves first, with per-level index and selectionStrategy",
  );

const publicActiveWindowAppIdAliases = ["packageName", "bundleId"] as const;

const appIdAliasShape = {
  packageName: z.string().optional(),
  bundleId: z.string().optional(),
};

const appIdPresenceBranches = [
  z.object({ appId: z.string() }).passthrough(),
  ...publicActiveWindowAppIdAliases.map((alias) => z.object({ [alias]: z.string() }).passthrough()),
];

const activeWindowWaitForBaseSchema = z
  .object({
    appId: z.string().optional().describe("Foreground app bundle ID / package name"),
    ...appIdAliasShape,
    activityName: z.string().optional().describe("Foreground Android activity name"),
  })
  .strict();

const activeWindowWaitForSchema = activeWindowWaitForBaseSchema.and(
  z.union([...appIdPresenceBranches, z.object({ activityName: z.string() }).passthrough()]),
);

// Absence / negation predicate (issue #3490 §4). Same element-matching fields as
// a positive predicate; the wait resolves only when NO element matches these.
const absentPredicateBaseSchema = z
  .object({
    selectionStrategy: resolverSelectionStrategySchema.optional(),
    elementId: z
      .string()
      .optional()
      .describe("Resource ID / accessibility identifier that must be absent"),
    text: z.string().optional().describe("Element text that must be absent (contains match)"),
    className: z.string().optional().describe("Element class name that must be absent"),
    contentDescription: z
      .string()
      .optional()
      .describe("Content description / accessibility label that must be absent"),
  })
  .strict();

const absentPredicatePresenceSchema = z.union([
  z.object({ elementId: z.string() }).passthrough(),
  z.object({ text: z.string() }).passthrough(),
  z.object({ className: z.string() }).passthrough(),
  z.object({ contentDescription: z.string() }).passthrough(),
]);

const absentPredicateSchema = absentPredicateBaseSchema.and(absentPredicatePresenceSchema);

const POSTURE_WAIT_DESCRIPTION =
  "Wait for the observed device posture. Single-panel inventory fails immediately; multi-panel or unavailable inventory keeps polling. Timeout diagnostics distinguish unobservable posture (no hierarchy captured), unavailable inventory, and the last observed posture.";

const waitForCommonShape = {
  posture: z
    .enum(["closed", "half_opened", "opened", "rear_display", "flipped", "tent"])
    .optional()
    .describe(POSTURE_WAIT_DESCRIPTION),
  activeDisplay: z.string().min(1).optional().describe("Wait for a panel key or role"),
  activeWindow: activeWindowWaitForSchema.optional().describe("Foreground app/window predicates"),
  absent: absentPredicateSchema
    .optional()
    .describe("Wait until an element matching these fields is absent"),
  timeout: z
    .number()
    .max(MAX_WAIT_FOR_TIMEOUT_MS, {
      message: `Wait timeout must not exceed ${MAX_WAIT_FOR_TIMEOUT_MS} ms`,
    })
    .optional()
    .describe("Wait timeout ms (default: 5000)"),
  timeoutMs: z
    .number()
    .max(MAX_WAIT_FOR_TIMEOUT_MS, {
      message: `Wait timeout must not exceed ${MAX_WAIT_FOR_TIMEOUT_MS} ms`,
    })
    .optional()
    .describe("Alias for timeout"),
  container: waitForContainerField,
  selectionStrategy: resolverSelectionStrategySchema.optional(),
};

const validateWaitForTimeoutAliases = (
  value: { timeout?: number; timeoutMs?: number },
  ctx: z.RefinementCtx,
): void => {
  if (value.timeout !== undefined && value.timeoutMs !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "waitFor accepts either timeout or timeoutMs, not both",
    });
  }
};

// Stability / "settled" gate (issue #3490 §3). After the waitFor predicate first
// matches, keep observing until the view hierarchy is unchanged for this long.
export const settledSchema = z
  .object({
    quietPeriodMs: z
      .number()
      .int()
      .positive()
      .describe("Quiet-period ms (no hierarchy change) required after waitFor matches"),
  })
  .strict();

const waitForTextAnySchema = z
  .object({
    for: z.never().optional(),
    textAny: z
      .array(z.string().min(1))
      .min(1)
      .describe("Ordered text variants; first visible match wins"),
    elementId: z.never().optional(),
    text: z.never().optional(),
    className: z.never().optional(),
    contentDescription: z.never().optional(),
    matchType: z.never().optional(),
    textMatch: z.never().optional(),
    ...waitForCommonShape,
  })
  .strict()
  .superRefine((value, ctx) => {
    validateWaitForTimeoutAliases(value, ctx);
    if (value.selectionStrategy !== undefined && value.absent === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "selectionStrategy requires an element or absent predicate",
      });
    }
  });

const waitForElementBaseSchema = z
  .object({
    for: z.never().optional(),
    elementId: z.string().optional().describe("Element resource ID / accessibility identifier"),
    text: z.string().optional().describe("Element text"),
    textAny: z.never().optional(),
    className: z.string().optional().describe("Element class name"),
    contentDescription: z
      .string()
      .optional()
      .describe("Element content description / accessibility label"),
    matchType: z
      .enum(["all", "any"])
      .optional()
      .describe("Whether element predicates must all match the same node or any one may match"),
    textMatch: z
      .enum(["exact", "contains", "regex"])
      .optional()
      .describe("How to match waitFor.text; does not affect contentDescription"),
    ...waitForCommonShape,
  })
  .strict()
  .superRefine((value, ctx) => {
    validateWaitForTimeoutAliases(value, ctx);
    if (
      value.selectionStrategy !== undefined &&
      !hasElementPredicate(value) &&
      value.absent === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "selectionStrategy requires an element or absent predicate",
      });
    }

    if (value.textMatch === "regex" && value.text !== undefined) {
      try {
        new RegExp(value.text);
      } catch (error) {
        // Invalid caller regexes are expected validation failures reported by the schema.
        logger.debug(`waitFor regex validation failed: ${errorMessage(error)}`);
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "text must be a valid regular expression when textMatch is regex",
        });
      }
    }
  });

const waitForPredicatePresenceSchema = z.union([
  z.object({ posture: waitForCommonShape.posture.unwrap() }).passthrough(),
  z.object({ activeDisplay: z.string().min(1) }).passthrough(),
  z.object({ elementId: z.string() }).passthrough(),
  z.object({ text: z.string() }).passthrough(),
  z.object({ className: z.string() }).passthrough(),
  z.object({ contentDescription: z.string() }).passthrough(),
  z.object({ activeWindow: activeWindowWaitForSchema }).passthrough(),
  z.object({ absent: absentPredicateSchema }).passthrough(),
]);

const waitForElementSchema = waitForElementBaseSchema.and(waitForPredicatePresenceSchema);

// Declarative predicate DSL (issue #4398): `for` selects a condition backed by a
// #4389 primitive. Everything but `stable` is a WaitForCondition predicate; the
// handler routes `stable` (whole-screen structural settle) to SettleObserve. The
// legacy-only fields are declared `never` here so the inferred union stays
// structurally compatible with the element/textAny arms (same pattern those arms
// use to exclude each other), keeping the legacy handler's field access valid.
const WAIT_FOR_CONDITION_KINDS = [
  "appear",
  "disappear",
  "clickable",
  "textEquals",
  "countStable",
] as const;
const WAIT_FOR_DSL_KINDS = [...WAIT_FOR_CONDITION_KINDS, "stable"] as const;

const waitForConditionDslSchema = z
  .object({
    for: z.enum(WAIT_FOR_DSL_KINDS).describe("Declarative condition to wait for"),
    elementId: z.string().optional().describe("Element resource ID / accessibility identifier"),
    text: z
      .string()
      .optional()
      .describe(
        "Element text; appear tries normalized exact then substring matching, while textEquals requires the exact value",
      ),
    pollMs: z.number().optional().describe("Poll interval ms (default 150)"),
    stableReads: z
      .number()
      .optional()
      .describe("Consecutive stable reads for countStable/stable (default 2)"),
    timeout: z
      .number()
      .max(MAX_WAIT_FOR_TIMEOUT_MS, {
        message: `Wait timeout must not exceed ${MAX_WAIT_FOR_TIMEOUT_MS} ms`,
      })
      .optional()
      .describe("Wait timeout ms (default 5000; stable default 2500)"),
    timeoutMs: z
      .number()
      .max(MAX_WAIT_FOR_TIMEOUT_MS, {
        message: `Wait timeout must not exceed ${MAX_WAIT_FOR_TIMEOUT_MS} ms`,
      })
      .optional()
      .describe("Alias for timeout"),
    container: waitForContainerField,
    selectionStrategy: resolverSelectionStrategySchema.optional(),
    textAny: z.never().optional(),
    className: z.never().optional(),
    contentDescription: z.never().optional(),
    matchType: z.never().optional(),
    textMatch: z.never().optional(),
    activeWindow: z.never().optional(),
    absent: z.never().optional(),
    posture: z.never().optional(),
    activeDisplay: z.never().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateWaitForTimeoutAliases(value, ctx);
    if (value.for === "stable") {
      if (value.container !== undefined || value.selectionStrategy !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'waitFor "for: stable" does not support container or selectionStrategy',
        });
      }
      return;
    }
    if (value.elementId === undefined && value.text === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `waitFor "for: ${value.for}" requires elementId or text`,
      });
    }
    if (value.for === "textEquals" && value.text === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'waitFor "for: textEquals" requires text (the exact expected value)',
      });
    }
  });

export const waitForSchema = z.union([
  waitForConditionDslSchema,
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
const WAIT_CONTAINER_ADVERTISED_SCHEMA = z.toJSONSchema(nestedElementContainerSchema, {
  override: ({ jsonSchema }) => {
    if (jsonSchema.$ref === "#") {
      jsonSchema.$ref = "#waitForContainer";
    }
  },
});
const WAIT_SELECTION_ADVERTISED_SCHEMA = z.toJSONSchema(resolverSelectionStrategySchema);
const ABSENT_PREDICATE_ADVERTISED_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  description: "Wait until an element matching these fields is absent (text uses exact match)",
  properties: {
    selectionStrategy: WAIT_SELECTION_ADVERTISED_SCHEMA,
    elementId: { type: "string" },
    text: { type: "string" },
    className: { type: "string" },
    contentDescription: { type: "string" },
  },
  anyOf: [
    { required: ["elementId"] },
    { required: ["text"] },
    { required: ["className"] },
    { required: ["contentDescription"] },
  ],
};
const COMPACT_WAITFOR_ADVERTISED_SCHEMA: Record<string, unknown> = {
  $defs: { waitForContainer: { ...WAIT_CONTAINER_ADVERTISED_SCHEMA, $anchor: "waitForContainer" } },
  type: "object",
  additionalProperties: false,
  properties: {
    for: {
      type: "string",
      enum: ["appear", "disappear", "clickable", "textEquals", "countStable", "stable"],
    },
    pollMs: { type: "number" },
    stableReads: { type: "number" },
    elementId: { type: "string" },
    text: { type: "string" },
    textAny: {
      type: "array",
      items: { type: "string" },
    },
    className: { type: "string" },
    contentDescription: { type: "string" },
    matchType: {
      type: "string",
      enum: ["all", "any"],
    },
    textMatch: {
      type: "string",
      enum: ["exact", "contains", "regex"],
      description: "How to match waitFor.text; does not affect contentDescription",
    },
    activeWindow: {
      type: "object",
      additionalProperties: false,
      properties: {
        appId: { type: "string" },
        packageName: { type: "string" },
        bundleId: { type: "string" },
        activityName: { type: "string" },
      },
      anyOf: [
        { required: ["appId"] },
        { required: ["packageName"] },
        { required: ["bundleId"] },
        { required: ["activityName"] },
      ],
    },
    posture: {
      type: "string",
      enum: ["closed", "half_opened", "opened", "rear_display", "flipped", "tent"],
      description: POSTURE_WAIT_DESCRIPTION,
    },
    activeDisplay: { type: "string", description: "Physical panel key or role" },
    absent: ABSENT_PREDICATE_ADVERTISED_SCHEMA,
    container: { $ref: "#waitForContainer" },
    selectionStrategy: WAIT_SELECTION_ADVERTISED_SCHEMA,
    timeout: { type: "number", maximum: MAX_WAIT_FOR_TIMEOUT_MS },
    timeoutMs: { type: "number", maximum: MAX_WAIT_FOR_TIMEOUT_MS },
  },
  // Enforce the same shape the runtime does: either the `for` DSL, or at least one
  // legacy predicate with textAny mutually exclusive from the element predicates /
  // matchType / textMatch. `absent` composes with everything (including textAny),
  // so it is not part of the textAny exclusion set.
  anyOf: [
    {
      properties: { for: { const: "stable" }, container: false, selectionStrategy: false },
      required: ["for"],
    },
    {
      properties: { for: { enum: WAIT_FOR_CONDITION_KINDS } },
      required: ["for", "elementId"],
    },
    { properties: { for: { enum: WAIT_FOR_CONDITION_KINDS } }, required: ["for", "text"] },
    {
      properties: { for: false, selectionStrategy: false },
      required: ["textAny"],
    },
    {
      properties: { for: false },
      anyOf: [...ELEMENT_PREDICATE_REQUIRED, { required: ["absent"] }],
    },
    {
      properties: { for: false, selectionStrategy: false },
      anyOf: [
        ...ELEMENT_PREDICATE_REQUIRED,
        { required: ["activeWindow"] },
        { required: ["absent"] },
        { required: ["posture"] },
        { required: ["activeDisplay"] },
      ],
    },
  ],
};

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

// Cross-field validation shared by `observe` and `openLink` (both carry
// platform + waitFor + settled): iOS rejects Android-only activityName, and
// `settled` requires a `waitFor` predicate to settle after.
export const refineWaitForArgs = (
  value: { platform?: "android" | "ios"; waitFor?: ObserveWaitForOptions; settled?: unknown },
  ctx: z.RefinementCtx,
): void => {
  const activeWindow = value.waitFor?.activeWindow;
  if (
    value.platform === "ios" &&
    activeWindow?.activityName !== undefined &&
    activeWindow.appId === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["waitFor", "activeWindow", "activityName"],
      message: "activityName is Android-only; use appId/bundleId on iOS",
    });
  }
  if (value.settled !== undefined && value.waitFor === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["settled"],
      message: "settled requires waitFor",
    });
  }
};

/**
 * #6154 follow-up: `refineWaitForArgs`'s iOS-rejects-activityName check runs
 * at schema-parse time against the raw request `platform`, which is now
 * optional (resolved from deviceId/session). A caller that omits `platform`
 * on an iOS device would skip that check entirely at parse time, so both
 * `observe` and `openLink` re-run it here against the resolved
 * `device.platform` once ToolRegistry has determined it.
 */
export function assertActiveWindowWaitForSupportedOnPlatform(
  platform: "android" | "ios",
  waitFor: ObserveWaitForOptions | undefined,
): void {
  const activeWindow = waitFor?.activeWindow;
  if (
    platform === "ios" &&
    activeWindow?.activityName !== undefined &&
    activeWindow.appId === undefined
  ) {
    throw new ActionableError("activityName is Android-only; use appId/bundleId on iOS");
  }
}

// Shared advertised-JSON-schema override for `observe` and `openLink`: enforce
// the iOS activityName rule, require waitFor whenever settled is present, and
// swap the verbose generated `waitFor` schema for the compact advertised form.
export const overrideWaitForJsonSchema: JsonSchemaOverride = (jsonSchema) => {
  // settled has no meaning without a waitFor predicate to settle after.
  jsonSchema.dependentRequired = {
    ...(jsonSchema.dependentRequired as Record<string, string[]> | undefined),
    settled: ["waitFor"],
  };

  // Replace the verbose generated `waitFor` schema with the compact advertised
  // form. Runtime validation still uses the full zod `waitForSchema`; this only
  // shrinks what `tools/list` carries (~2064 -> ~473 tokens).
  const props = jsonSchema.properties as Record<string, unknown> | undefined;
  if (props && props.waitFor) {
    props.waitFor = COMPACT_WAITFOR_ADVERTISED_SCHEMA;
  }
};

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

export type ObserveWaitForOptions = z.infer<typeof waitForSchema>;
export type SettledOptions = z.infer<typeof settledSchema>;
/** waitFor options carrying the (top-level) settled gate, as threaded to {@link waitForObservation}. */
export type WaitForWithSettled = ObserveWaitForOptions & {
  settled?: SettledOptions;
  /** Scope element predicates to the app or the AutoMobile prototype (issue #9305). */
  layer?: HierarchyLayer;
};
type ObserveArgs = z.infer<typeof observeSchema>;
export type WaitForConditionDsl = z.infer<typeof waitForConditionDslSchema>;
export type WaitForConditionKind = (typeof WAIT_FOR_CONDITION_KINDS)[number];

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

interface ObserveToolDependencies {
  crop?: ObserveCropDependencies;
  pathProtection?: ScreenshotPathProtection;
  timer?: Timer;
  createScreen?: (
    device: BootedDevice,
    display?: string,
  ) => Pick<
    RealObserveScreen,
    "execute" | "executeDeviceRead" | "appendRawViewHierarchy" | "getMostRecentCachedObserveResult"
  > &
    Pick<ObserveScreen, "captureScreenshot">;
  deviceReadAccess?: DeviceObservationAccess;
  /** Whether the device can hide its own prototype for a capture (#9305); defaults to CtrlProxy's. */
  hidesPrototypeForScreenshot?: (device: BootedDevice) => Promise<boolean>;
}

/**
 * An Android CtrlProxy or a connected iOS prototype agent advertising `screenshot_hide_prototype_v1`
 * (#9305). The iOS agent hides itself around the host's simulator screenshot.
 */
async function ctrlProxyHidesPrototypeForScreenshot(device: BootedDevice): Promise<boolean> {
  if (device.platform === "ios") {
    return iosAgentHidesPrototypeForCapture(device.deviceId);
  }
  if (device.platform !== "android") {
    return false;
  }
  try {
    return await AndroidCtrlProxyClient.getInstance(device).supportsCommand(
      SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY,
    );
  } catch (error) {
    // Unknown capability keeps today's capture, which observe reports as including the prototype.
    logger.debug(`[OBSERVE] Prototype-hiding capability unavailable: ${errorMessage(error)}`);
    return false;
  }
}

/**
 * The screenshot options observe captures with: the caller's encoding, plus `hidePrototypes` for a
 * `layer: "app"` capture on a device that hides its prototype device-side in the one request (#9305).
 * Device reads never use CtrlProxy for the capture, so they keep the prototype.
 */
async function observeScreenshotOptions(
  args: ObserveArgs,
  device: BootedDevice,
  deviceRead: boolean,
  screenshotMode: ScreenshotMode | undefined,
  dependencies: ObserveToolDependencies,
): Promise<ObserveScreenshotOptions | undefined> {
  if (args.layer !== "app" || deviceRead || screenshotMode === "none") {
    return args.screenshotOptions;
  }
  const hides = await (
    dependencies.hidesPrototypeForScreenshot ?? ctrlProxyHidesPrototypeForScreenshot
  )(device);
  return hides ? { ...args.screenshotOptions, hidePrototypes: true } : args.screenshotOptions;
}

function screenForObserve(
  device: BootedDevice,
  args: ObserveArgs,
  dependencies: ObserveToolDependencies,
): ObserveScreen & Pick<RealObserveScreen, "appendRawViewHierarchy" | "executeDeviceRead"> {
  if (dependencies.createScreen) {
    return dependencies.createScreen(device, args.display);
  }
  return new RealObserveScreen(device, undefined, {
    display: args.display,
    deviceReadOnly: getToolSelectionContext()?.explicitObserveDeviceRead === true,
    onAvailabilityLost:
      device.platform === "android"
        ? (reason) => {
            const daemonState = DaemonState.getInstance();
            if (args.sessionUuid && daemonState.isInitialized()) {
              daemonState
                .getSessionManager()
                .invalidateAutomationReadiness(args.sessionUuid, reason);
            }
          }
        : undefined,
  });
}

// Register tools (this will be called when this file is imported)
async function withCapturedScreenshotImage(
  result: ObserveToolPayload,
  screenshotPath: string | undefined,
  options: { signal?: AbortSignal; protection?: ScreenshotPathProtection } = {},
): Promise<ObserveResponse> {
  const delivery = await inlineScreenshotImage(screenshotPath, result, options.signal);
  await publishScreenshotPaths(result, options.protection);
  const response = createStructuredToolResponse({
    ...result,
    screenshotImage: delivery.screenshotImage,
  });
  return {
    ...response,
    content: delivery.image ? [...response.content, delivery.image] : response.content,
  };
}

type ObserveResponse = Omit<StructuredToolResponse<ObserveToolPayload>, "content"> & {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
};

async function createObserveResponse(
  result: ObserveToolPayload,
  includeScreenshotImage: boolean | undefined,
  options: { signal?: AbortSignal; protection?: ScreenshotPathProtection } = {},
): Promise<ObserveResponse> {
  const { signal, protection = screenshotPathProtection } = options;
  await publishScreenshotPaths(result, protection);
  const response = includeScreenshotImage
    ? await withCapturedScreenshotImage(result, result.screenshotPath, { signal, protection })
    : createStructuredToolResponse(result);
  await publishScreenshotPaths(result, protection, false);
  return response;
}

function requestedScreenshotMode(args: ObserveArgs): ScreenshotMode | undefined {
  if (args.crop && args.screenshot && args.screenshot !== "settled") {
    throw new ActionableError(
      "observe crop requires screenshot: 'settled' (or omit screenshot); async and none cannot provide a completed crop. No capture was started.",
    );
  }
  if (args.crop && args.display === "all") {
    throw new ActionableError(
      "observe crop requires one display; select a panel key, role, or active instead of all.",
    );
  }
  if (args.includeScreenshotImage && args.screenshot && args.screenshot !== "settled") {
    throw new ActionableError(
      "includeScreenshotImage requires screenshot: 'settled' (or omit screenshot). No capture was started.",
    );
  }
  return args.crop || args.includeScreenshotImage ? "settled" : args.screenshot;
}

function attachSnapshotReference(deviceId: string, result: ObserveResult): void {
  const capture = snapshotReferences.capture(deviceId, result);
  if (capture.status === "captured") {
    result.snapshotReference = capture.reference;
    delete result.snapshotReferenceUnavailable;
  } else {
    result.snapshotReference = undefined;
    result.snapshotReferenceUnavailable = capture.missing;
  }
}

function prepareObserveOptions(platform: BootedDevice["platform"], args: ObserveArgs) {
  const deviceRead = getToolSelectionContext()?.explicitObserveDeviceRead === true;
  if (args.display === "all") {
    assertAllDisplayObserveSupported(platform, args);
  }
  if (deviceRead) {
    if (args.waitFor !== undefined) {
      throw new ActionableError(
        "waitFor is not available on deviceId reads; use a session observe (pass sessionUuid).",
      );
    }
    if (args.raw === true) {
      // collectRaw uses the owner's client and invalidates its shared cache;
      // project: "full" preserves the full filtered tree without that write.
      throw new ActionableError(
        'raw is not available on deviceId reads; use project: "full" for the full filtered hierarchy.',
      );
    }
    if (args.skipBackStack === true) {
      throw new ActionableError(
        "skipBackStack is not available on deviceId reads; use a session observe (pass sessionUuid) with waitFor.",
      );
    }
  }
  assertActiveWindowWaitForSupportedOnPlatform(platform, args.waitFor);
  const screenshot = requestedScreenshotMode(args);
  return {
    deviceRead,
    aggregate: args.display === "all",
    timeoutMs: aggregateObserveTimeoutMs(args),
    screenshotMode: deviceRead ? (screenshot ?? "settled") : screenshot,
    encoding: args.screenshotOptions,
  };
}

/** Leave a short serialization window before the enclosing observe request expires. */
function aggregateObserveTimeoutMs(args: ObserveArgs): number | undefined {
  if (args.display !== "all") {
    return undefined;
  }
  const deadline = (args as Record<string, unknown>)[INTERNAL_MCP_REQUEST_DEADLINE_PARAM];
  return typeof deadline === "number" && Number.isFinite(deadline)
    ? Math.max(0, deadline - defaultTimer.now() - 100)
    : undefined;
}

function createObserveWaitResponse(
  result: ObserveToolPayload,
  waitOutcome: WaitForObservationOutcome,
  includeScreenshotImage?: boolean,
  options: { signal?: AbortSignal; protection?: ScreenshotPathProtection } = {},
): Promise<ObserveResponse> | ObserveResponse {
  const waitMetadata: Omit<WaitForObservationOutcome, "observation"> = {
    awaitedElement: waitOutcome.awaitedElement,
    awaitDuration: waitOutcome.awaitDuration,
    awaitTimeout: waitOutcome.awaitTimeout,
    matched: waitOutcome.matched,
    settled: waitOutcome.settled,
    timedOut: waitOutcome.timedOut,
    polls: waitOutcome.polls,
    waitMs: waitOutcome.waitMs,
    matchedElement: waitOutcome.matchedElement,
    candidates: waitOutcome.candidates,
    ...(waitOutcome.containerFailure ? { containerFailure: waitOutcome.containerFailure } : {}),
  };
  return createObserveResponse(
    { ...result, ...waitMetadata, timeoutReason: waitOutcome.timeoutReason },
    includeScreenshotImage,
    options,
  );
}

async function attachObserveCrop(
  args: ObserveArgs,
  result: ObserveResult,
  device: BootedDevice,
  dependencies?: ObserveCropDependencies,
): Promise<void> {
  if (!args.crop) {
    return;
  }
  // Full projections expose the scoped hierarchy itself, so resolve over that same
  // tree before raw append can replace it. The skeleton projection also applies
  // FOCUS/REGION, but only as a row filter over the unscoped tree, so skeleton
  // crops still resolve against the unscoped observation.
  const selectorObservation =
    args.project === "full" || (args.raw && args.project !== "skeleton")
      ? applyObserveScopeExperiments(
          result,
          buildObserveScopeConfig({ focus: true, overview: true, region: true }, args.scope),
        )
      : result;
  result.crop = await createObserveCrop(
    args.crop,
    { ...result, deviceId: device.deviceId },
    device.platform,
    dependencies,
    selectorObservation,
  );
}

/**
 * The observation `observe` serves for `layer` (issue #9305). A plain observe
 * that asks for the prototype while none is showing is an actionable error; a
 * waitFor observe returns the (empty) scoped capture so its timeout reports the miss.
 */
function layerScopedObserveResult(
  result: ObserveResult,
  layer: HierarchyLayer | undefined,
  platform: BootedDevice["platform"],
  requirePrototype: boolean,
): ObserveResult {
  if (layer === undefined) {
    return result;
  }
  if (requirePrototype && result.viewHierarchy) {
    scopeHierarchyForSelector(result.viewHierarchy, layer);
  }
  const { screenshotIncludesPrototype: capturedWithoutPrototype, ...scoped } =
    scopeObserveResultToLayer(result, layer, platform);
  // A capture taken with the prototype hidden device-side is marked false by the capture itself;
  // any other `layer: "app"` screenshot still shows the prototype, and observe says so.
  return layer === "app" && carriesScreenshot(result) && hasOwnPrototype(result.viewHierarchy)
    ? { ...scoped, screenshotIncludesPrototype: capturedWithoutPrototype !== false }
    : scoped;
}

/**
 * Whether the observation carries a screenshot or crop, so `observe` can say whether a
 * `layer: "app"` image shows the prototype instead of implying an app-only image (issue #9305).
 */
function carriesScreenshot(result: ObserveResult): boolean {
  return (
    result.screenshotCaptureAttempted === true ||
    result.screenshotPath !== undefined ||
    result.crop !== undefined
  );
}

function recordObservationBackStack(result: ObserveResult, sessionUuid?: string): void {
  if (result.backStack && result.activeWindow?.appId) {
    const navGraph = sessionUuid
      ? NavigationGraphManager.getInstanceForSession(sessionUuid)
      : NavigationGraphManager.getInstance();
    // Only record if we have a current app and screen
    if (navGraph.getCurrentAppId() === result.activeWindow.appId && navGraph.getCurrentScreen()) {
      navGraph.recordBackStack(result.backStack).catch((error) => {
        logger.warn(`Failed to record observation back stack: ${errorMessage(error)}`, error);
      });
    }
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
