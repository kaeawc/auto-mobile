import {
  DEFAULT_WAIT_FOR_TIMEOUT_MS,
  DEFAULT_STABLE_WAIT_FOR_TIMEOUT_MS,
  MAX_WAIT_FOR_TIMEOUT_MS,
} from "../features/observe/waitForTimeout";
import { publishScreenshotPaths } from "../features/observe/ScreenshotRetention";
import { readObservationForInteractions } from "./identifyInteractionsObservation";
import {
  screenshotPathProtection,
  type ScreenshotPathProtection,
} from "../features/observe/ScreenshotPathProtection";
import { toActionableError } from "../models/ActionableError";
import { errorMessage } from "../utils/describeUnknownError";
import {
  canDisplayExist,
  displayWaitInventory,
  type DisplayInventoryClassification,
} from "../utils/deviceMatcher";
import type { DisplayPanel } from "../models/DisplayPanel";
import { z } from "zod/v4";
import { screenshotOptionsSchema } from "../features/observe/screenshot/screenshotOptions";
import { ToolRegistry } from "./toolRegistry";
import { stripInternalToolParams } from "./internalToolParams";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import { INTERNAL_MCP_REQUEST_DEADLINE_PARAM } from "../daemon/constants";
import { assertAllDisplayObserveSupported } from "../features/observe/DisplaySelection";
import {
  assertObservationReadAccess,
  resolveDeviceForObservationRead,
  type DeviceObservationAccess,
} from "./deviceObservationAccess";
import { ResourceRegistry } from "./resourceRegistry";
import { RESOURCE_URIS } from "./observationResources";
import { OBSERVE_APP_RESOURCE_URI } from "./observeAppResource";
import { ActionableError } from "../models/ActionableError";
import { hasUsableHierarchy, RealObserveScreen } from "../features/observe/ObserveScreen";
import { snapshotReferences } from "../features/observe/SnapshotReferenceStore";
import type {
  ObserveScreen,
  ObserveScreenExecuteOptions,
} from "../features/observe/interfaces/ObserveScreen";
import { RealSettleObserve } from "../features/observe/SettleObserve";
import { RealWaitForCondition } from "../features/observe/WaitForCondition";
import { hierarchyUpdatedAtToMillis } from "../features/observe/observeTimestamp";
import type {
  ConditionEvaluation,
  ConditionPredicate,
} from "../features/observe/interfaces/WaitForCondition";
import {
  appear,
  disappear,
  clickable,
  textEquals,
  countStable,
  ConditionSelector,
  usesScopedWait,
  waitContainerSelector,
  isScopedWaitResolutionError,
  waitResolutionFailure,
  waitCaptureUnavailableReason,
} from "../features/observe/ConditionPredicates";
import {
  createJSONToolResponse,
  createStructuredToolResponse,
  throwIfAborted,
  awaitWhileRequestIsLive,
  StructuredToolResponse,
} from "../utils/toolUtils";
import { isDeviceLostError, throwDeviceLostFromAbortSignal } from "./deviceLossOutcome";
import {
  BootedDevice,
  Element,
  ObserveResult,
  ObserveToolPayload,
  ViewHierarchyResult,
} from "../models";
import { nodeAttributes, type ViewHierarchyNode } from "../models/ViewHierarchyResult";
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
  hasOwnOverlay,
  scopeHierarchyForSelector,
  scopeHierarchyToLayer,
  scopeObserveResultToLayer,
} from "../features/observe/hierarchyLayer";
import type { HierarchyLayer } from "../models/HierarchyLayer";
import { observeToolResultSchema } from "./toolOutputSchemas";
import {
  ElementResolver,
  isMissingContainerError,
  type MatchMode,
  type ContainerFailure,
} from "../features/utility/ElementResolver";
import { SearchableHierarchy, type SearchableEntry } from "../features/utility/SearchableNode";
import {
  hasVisibleScreenPart,
  screenSizeForOffscreenCheck,
  type ScreenSizeForOffscreenCheckOptions,
} from "../features/utility/ElementGeometry";
import type { ScreenSize } from "../models/ScreenSize";
import { normalizeQuotes } from "../features/utility/TextMatcher";
import type { ResolverSelector } from "./elementSelectorSchemas";
import type { ConditionResolver } from "../features/observe/ConditionPredicates";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { consumeSetupTiming } from "./ToolExecutionContext";
import { AndroidCtrlProxyManager } from "../ctrlProxy/CtrlProxyManager";
import { accessibilityDetector } from "../features/accessibility/AccessibilityDetector";
import type { AccessibilityDetector } from "../features/accessibility/interfaces/AccessibilityDetector";
import { DaemonState } from "../daemon/daemonState";
import { logger } from "../utils/logger";
import { serverConfig } from "../utils/ServerConfig";
import { NodeCryptoService } from "../utils/crypto";
import {
  resolveScreenshotMode,
  shouldSkipObserveWaitForScreenshot,
  type ScreenshotMode,
} from "../features/observe/automaticScreenshotPolicy";
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
    })
    .strict(),
);

const WAIT_FOR_POLL_INTERVAL_MS = 100;

export type ObserveWaitForOptions = z.infer<typeof waitForSchema>;
export type SettledOptions = z.infer<typeof settledSchema>;
/** waitFor options carrying the (top-level) settled gate, as threaded to {@link waitForObservation}. */
export type WaitForWithSettled = ObserveWaitForOptions & {
  settled?: SettledOptions;
  /** Scope element predicates to the app or the AutoMobile overlay (issue #9305). */
  layer?: HierarchyLayer;
};
type ObserveArgs = z.infer<typeof observeSchema>;
type WaitForConditionDsl = z.infer<typeof waitForConditionDslSchema>;
type WaitForConditionKind = (typeof WAIT_FOR_CONDITION_KINDS)[number];

/** Metadata produced by an `observe.waitFor` poll. */
export interface WaitForObservationOutcome {
  observation: ObserveResult;
  awaitedElement?: Element;
  awaitDuration: number;
  awaitTimeout: boolean;
  matched?: boolean;
  settled?: boolean;
  timedOut: boolean;
  timeoutReason?: string;
  polls: number;
  waitMs: number;
  matchedElement?: Element;
  candidates?: Element[];
  containerFailure?: ContainerFailure;
}

interface ObserveConditionEvaluation extends ConditionEvaluation {
  containerFailure?: ContainerFailure;
}

function containerFailureMetadata(failed: boolean, failure: ContainerFailure | undefined) {
  return failed && failure ? { containerFailure: failure } : {};
}

/** Record resolver diagnostics without changing predicate matching or other tools. */
function trackContainerFailure(
  finder: ConditionResolver,
  container: ObserveWaitForOptions["container"],
) {
  // Resolution may propagate unique; diagnostics keep each client-sent level.
  const levels: NonNullable<ObserveWaitForOptions["container"]>[] = [];
  for (let level = container; level; level = level.container) {
    levels.unshift(level);
  }
  let failure: ContainerFailure | undefined;
  return {
    finder: {
      resolve: (...args: Parameters<ConditionResolver["resolve"]>) => {
        const result = finder.resolve(...args);
        const resolved = result.containerFailure;
        failure ??= resolved && {
          ...resolved,
          selector: levels[resolved.level - 1] ?? resolved.selector,
        };
        return result;
      },
    } satisfies ConditionResolver,
    failure: () => failure,
    reset: () => {
      failure = undefined;
    },
  };
}

/** True when the waitFor options are the #4398 declarative `for` DSL form. */
const isConditionDsl = (waitFor: ObserveWaitForOptions): waitFor is WaitForConditionDsl =>
  (waitFor as { for?: unknown }).for !== undefined;

/**
 * Build the #4389 {@link ConditionPredicate} for a DSL `for` kind (issue #4398).
 * `stable` is intentionally not handled here — the handler routes it to
 * `RealSettleObserve` (whole-screen settle) rather than a predicate. Throws an
 * `ActionableError` for `textEquals` without a `text` value, mirroring the zod
 * refinement so the standalone tool path fails with the same actionable message.
 */
export const buildConditionPredicate = (
  finder: ConditionResolver,
  kind: WaitForConditionKind,
  selector: ConditionSelector,
  options?: { stableReads?: number },
): ConditionPredicate => {
  switch (kind) {
    case "appear":
      return appear(finder, selector);
    case "disappear":
      return disappear(finder, selector);
    case "clickable":
      return clickable(finder, selector);
    case "textEquals":
      if (selector.text === undefined) {
        throw new ActionableError(
          'waitFor "for: textEquals" requires text (the exact expected value)',
        );
      }
      return textEquals(finder, selector, selector.text);
    case "countStable":
      return countStable(finder, selector, options);
    default: {
      const exhaustive: never = kind;
      throw new ActionableError(`Unknown waitFor condition: ${String(exhaustive)}`);
    }
  }
};

/**
 * Run the declarative `for` DSL (issue #4398) and adapt its result to the shared
 * `waitForObservation` return shape. `stable` runs the settle loop
 * (`RealSettleObserve`); every other kind runs `RealWaitForCondition` with the
 * predicate for that kind. `awaitedElement` carries the matched element (never set
 * for settle / countStable, which have no single element); `awaitTimeout` reflects
 * "did not settle" / "timed out".
 */
// eslint-disable-next-line complexity -- primitive dispatch and its additive settled gate share the DSL outcome boundary.
const runWaitForConditionDsl = async (
  observeScreen: ObserveScreen,
  waitFor: WaitForConditionDsl,
  signal: AbortSignal | undefined,
  timer: Timer,
  skipBackStack: boolean = false,
  platform?: BootedDevice["platform"],
): Promise<WaitForObservationOutcome> => {
  const startTime = timer.now();
  const timeoutMs =
    waitFor.timeout ??
    waitFor.timeoutMs ??
    (waitFor.for === "stable" ? DEFAULT_STABLE_WAIT_FOR_TIMEOUT_MS : DEFAULT_WAIT_FOR_TIMEOUT_MS);
  // Omit collectDeferredBackStack here: explicit skipBackStack opts out of terminal reads too.
  const pollingScreen: ObserveScreen = skipBackStack
    ? {
        execute: (options?: ObserveScreenExecuteOptions) =>
          observeScreen.execute({ ...options, skipBackStack: true }),
        appendRawViewHierarchy: (result, abortSignal) =>
          observeScreen.appendRawViewHierarchy(result, abortSignal),
        getMostRecentCachedObserveResult: () => observeScreen.getMostRecentCachedObserveResult(),
        ...(observeScreen.captureScreenshot
          ? {
              captureScreenshot: (
                ...args: Parameters<NonNullable<ObserveScreen["captureScreenshot"]>>
              ) => observeScreen.captureScreenshot!(...args),
            }
          : {}),
        ...(observeScreen.runAccessibilityAudit
          ? {
              runAccessibilityAudit: (
                ...args: Parameters<NonNullable<ObserveScreen["runAccessibilityAudit"]>>
              ) => observeScreen.runAccessibilityAudit!(...args),
            }
          : {}),
        ...(observeScreen.processRecomposition
          ? {
              processRecomposition: (
                ...args: Parameters<NonNullable<ObserveScreen["processRecomposition"]>>
              ) => observeScreen.processRecomposition!(...args),
            }
          : {}),
        ...(observeScreen.captureCacheGeneration
          ? { captureCacheGeneration: () => observeScreen.captureCacheGeneration!() }
          : {}),
        ...(observeScreen.cacheObserveResult
          ? {
              cacheObserveResult: (
                ...args: Parameters<NonNullable<ObserveScreen["cacheObserveResult"]>>
              ) => observeScreen.cacheObserveResult!(...args),
            }
          : {}),
      }
    : observeScreen;
  const settled = (waitFor as WaitForWithSettled).settled;
  const pollMs = waitFor.pollMs;
  const applySettledGate = createSettledGate({
    settled,
    timer,
    startTime,
    timeoutMs,
    signal,
    pollingScreen,
    skipBackStack,
    platform,
  });
  if (waitFor.for === "stable") {
    const settle = await new RealSettleObserve(pollingScreen, timer).execute({
      timeoutMs: waitFor.timeout ?? waitFor.timeoutMs,
      pollMs,
      stableReads: waitFor.stableReads,
      signal,
    });
    const outcome: WaitForObservationOutcome = {
      observation: settle.observation,
      awaitedElement: undefined,
      awaitDuration: settle.waitMs,
      awaitTimeout: !settle.settled,
      settled: settle.settled,
      // The terminal reason preserves whether an Asleep observation was an
      // admissible screen-off fast-fail or merely the last stale frame at the
      // end of an exhausted timeout budget.
      timedOut: settle.terminalReason === "timeout",
      polls: settle.polls,
      waitMs: settle.waitMs,
    };
    return applySettledGate(outcome, settle.settled);
  }

  const tracked = trackContainerFailure(new ElementResolver(), waitFor.container);
  const evaluate = buildConditionPredicate(
    tracked.finder,
    waitFor.for,
    {
      elementId: waitFor.elementId,
      text: waitFor.text,
      container: waitFor.container,
      selectionStrategy: waitFor.selectionStrategy,
    },
    { stableReads: waitFor.stableReads },
  );
  const predicate: ConditionPredicate = (observation) => {
    tracked.reset();
    const evaluation = evaluate(
      layerScopedObservation(observation, (waitFor as WaitForWithSettled).layer),
    );
    return { ...evaluation, ...containerFailureMetadata(!evaluation.matched, tracked.failure()) };
  };
  const result = await new RealWaitForCondition(pollingScreen, timer).execute(predicate, {
    timeoutMs: waitFor.timeout ?? waitFor.timeoutMs,
    pollMs,
    signal,
  });
  const outcome: WaitForObservationOutcome = {
    observation: result.observation,
    awaitedElement: result.matchedElement,
    awaitDuration: result.waitMs,
    awaitTimeout: result.timedOut,
    matched: result.matched,
    timedOut: result.timedOut,
    polls: result.polls,
    waitMs: result.waitMs,
    matchedElement: result.matchedElement,
    candidates: result.candidates,
    ...containerFailureMetadata(result.timedOut, tracked.failure()),
    ...(result.diagnostic
      ? {
          timeoutReason: `Timed out after ${result.waitMs} ms waiting for ${waitFor.for}; ${result.diagnostic}`,
        }
      : {}),
  };
  return applySettledGate(outcome, result.matched, predicate);
};

const waitForContainerForFinder = (waitFor: ObserveWaitForOptions): ResolverSelector | undefined =>
  waitContainerSelector(waitFor.container);

function shouldRetryCompoundText(
  waitFor: ObserveWaitForOptions,
  negative: boolean,
  sets: readonly (readonly unknown[])[],
): boolean {
  if (negative || waitFor.matchType === "any" || waitFor.text === undefined) {
    return false;
  }
  if (waitFor.textMatch !== undefined || sets.length < 2) {
    return false;
  }
  return !sets.some((set) => set.some((node) => sets.every((other) => other.includes(node))));
}

function retryCompoundText<T>(
  waitFor: ObserveWaitForOptions,
  negative: boolean,
  predicates: ResolverSelector[],
  sets: T[][],
  resolve: (selector: ResolverSelector) => T[],
): void {
  if (!shouldRetryCompoundText(waitFor, negative, sets)) {
    return;
  }
  const textIndex = predicates.findIndex((selector) => selector.text !== undefined);
  sets[textIndex] = resolve({ text: waitFor.text!, match: "contains" });
}

function isWaitSourceVisible(
  element: Element | undefined,
  screenSize: ScreenSize | undefined,
  negative: boolean,
): boolean {
  return element !== undefined && (negative || hasVisibleScreenPart(element.bounds, screenSize));
}

interface WaitForElementOptions extends ScreenSizeForOffscreenCheckOptions {
  negative?: boolean;
  evaluation?: ConditionEvaluation;
}

function resolveWaitForElementOptions(
  options: boolean | WaitForElementOptions,
  context: { hierarchy: ViewHierarchyResult; platform?: BootedDevice["platform"] },
): { negative: boolean; screenSize: ScreenSize | undefined } {
  const resolved = typeof options === "boolean" ? { negative: options } : options;
  return {
    negative: resolved.negative ?? false,
    screenSize: screenSizeForOffscreenCheck(context.hierarchy, {
      ...resolved,
      platform: context.platform ?? resolved.platform,
    }),
  };
}

function finderForSelection(
  finder: ConditionResolver,
  candidates: SearchableEntry[],
  selectionStrategy: ResolverSelector["selectionStrategy"],
) {
  return finder.resolve(
    {
      id: "wait-selection",
      nodes: candidates.map((node, index) => ({ ...node, index, parentIndex: undefined })),
    },
    { selectionStrategy },
    { action: "inspect" },
  );
}

function bindWaitScope(nodes: readonly SearchableEntry[], scope: SearchableEntry) {
  let key = "wait-resolved-scope";
  while (nodes.some((node) => node.nodeKey === key || node.nativeId === key)) {
    key += "_";
  }
  return {
    nodes: nodes.map((node) => (node === scope ? { ...node, nodeKey: key } : node)),
    container: { elementId: key },
  };
}

/** Resolve the chain once per frame, then pin later compound fields to that exact scope. */
function scopedWaitFinder(
  finder: ConditionResolver,
  waitFor: ObserveWaitForOptions,
  evaluation: ConditionEvaluation,
): ConditionResolver {
  let bound: { nodes: readonly SearchableEntry[]; container: ResolverSelector } | undefined;
  return {
    resolve: (snapshot, selector, intent) => {
      const container = bound?.container ?? waitForContainerForFinder(waitFor);
      const result = finder.resolve(
        { ...snapshot, nodes: bound?.nodes ?? snapshot.nodes },
        {
          ...selector,
          container: container && {
            ...container,
            selectionStrategy:
              waitFor.selectionStrategy === "unique" ? "unique" : container.selectionStrategy,
          },
        },
        intent,
      );
      if (result.error && !isScopedWaitResolutionError(result.error)) {
        throw new ActionableError(result.error);
      }
      const failure = waitResolutionFailure(result, waitFor, true);
      if (failure) {
        Object.assign(evaluation, failure);
        return result;
      }
      if (!bound && result.scope) {
        bound = bindWaitScope(snapshot.nodes, result.scope);
      }
      return result;
    },
  };
}

function waitElementSelectors(waitFor: ObserveWaitForOptions): ResolverSelector[] {
  const predicates: ResolverSelector[] = [];
  if (waitFor.elementId !== undefined) {
    predicates.push({ elementId: waitFor.elementId });
  }
  if (waitFor.text !== undefined) {
    predicates.push({ text: waitFor.text, match: waitFor.textMatch });
  }
  if (waitFor.className !== undefined) {
    predicates.push({ className: waitFor.className });
  }
  if (waitFor.contentDescription !== undefined) {
    predicates.push({ contentDescription: waitFor.contentDescription, match: "exact" });
  }
  return predicates;
}

function waitElementEvaluation(options: boolean | WaitForElementOptions): ConditionEvaluation {
  return typeof options === "boolean"
    ? { matched: false }
    : (options.evaluation ?? { matched: false });
}

function chooseWaitElement(
  finder: ConditionResolver,
  eligible: SearchableEntry[],
  waitFor: ObserveWaitForOptions,
  negative: boolean,
  evaluation: ConditionEvaluation,
): Element | null {
  if (!usesScopedWait(waitFor)) {
    return eligible[0]?.element ?? null;
  }
  if (evaluation.diagnostic) {
    return null;
  }
  // Scope and compound matching are already proven; the shared resolver chooses
  // among these source nodes without another random draw of the container chain.
  const selected = finderForSelection(finder, eligible, waitFor.selectionStrategy);
  if (waitFor.container && selected.error === "Target not found") {
    selected.error = "Target not found within container";
  }
  const failure = waitResolutionFailure(selected, waitFor, negative);
  if (failure) {
    Object.assign(evaluation, failure);
  }
  return selected.chosen?.element ?? null;
}

export const findWaitForElement = (
  finder: ConditionResolver,
  waitFor: ObserveWaitForOptions,
  viewHierarchy: ViewHierarchyResult,
  platform?: BootedDevice["platform"],
  modes = new Map<string, MatchMode>(),
  options: boolean | WaitForElementOptions = false,
): Element | null => {
  const evaluation = waitElementEvaluation(options);
  const scoped = usesScopedWait(waitFor);
  const selectionFinder = finder;
  if (scoped) {
    finder = scopedWaitFinder(finder, waitFor, evaluation);
  }
  const { negative, screenSize } = resolveWaitForElementOptions(options, {
    hierarchy: viewHierarchy,
    platform,
  });
  const snapshot = {
    id: "wait",
    // Compound predicates describe one source node, not its hoisted display row.
    nodes: new SearchableHierarchy().project(viewHierarchy).map((node) => ({
      ...node,
      textFields: Object.values(node.textSources),
    })),
  };
  const canTryVisibleContains = (
    selector: ResolverSelector,
    key: string,
    mode: MatchMode,
    visibleCount: number,
  ) =>
    Boolean(waitFor.textAny) &&
    !negative &&
    selector.match === undefined &&
    !modes.has(key) &&
    mode === "exact" &&
    visibleCount === 0;
  const resolve = (selector: ResolverSelector) => {
    const key = JSON.stringify(selector);
    let result = finder.resolve(
      snapshot,
      { ...selector, container: waitForContainerForFinder(waitFor) ?? undefined },
      { action: "inspect", negative, matchMode: modes.get(key) },
    );
    if (
      isMissingContainerError(result.error) ||
      (scoped && isScopedWaitResolutionError(result.error))
    ) {
      return [];
    }
    if (result.error) {
      throw new ActionableError(result.error);
    }
    const visibleSources = (resolution: typeof result) =>
      [
        ...new Set(resolution.matches.flatMap(({ node, sourceNodes }) => sourceNodes ?? [node])),
      ].filter((node) => {
        if (!isWaitSourceVisible(node.element, screenSize, negative)) {
          return false;
        }
        if (selector.text === undefined || selector.match !== "exact") {
          return true;
        }
        const expected = normalizeQuotes(selector.text).toLowerCase();
        const trimNode = selector.text === selector.text.trim();
        return Object.values(node.textSources).some(
          (value) => normalizeQuotes(trimNode ? value.trim() : value).toLowerCase() === expected,
        );
      });
    let candidates = visibleSources(result);
    if (canTryVisibleContains(selector, key, result.matchMode, candidates.length)) {
      result = finder.resolve(
        snapshot,
        {
          ...selector,
          container: waitForContainerForFinder(waitFor) ?? undefined,
          match: "contains",
        },
        { action: "inspect", matchMode: "contains" },
      );
      if (result.error) {
        throw new ActionableError(result.error);
      }
      candidates = visibleSources(result);
    }
    if (!waitFor.textAny || candidates.length > 0) {
      modes.set(key, result.matchMode);
    }
    return candidates;
  };
  if (waitFor.textAny) {
    for (const text of waitFor.textAny) {
      const candidate = resolve({ text, match: waitFor.textMatch })[0];
      if (candidate) {
        return candidate.element!;
      }
    }
  }
  const predicates = waitElementSelectors(waitFor);
  const sets = predicates.map((selector) => {
    const candidates = resolve(selector);
    // Older iOS captures expose the accessibility label only as text. Keep this
    // rich-wait compatibility local; field-specific focus selectors stay strict.
    if (platform === "ios" && selector.contentDescription !== undefined) {
      candidates.push(
        ...resolve({ text: selector.contentDescription, match: "exact" }).filter(
          (node) => !node.accessibleLabel && !node.textSources["content-desc"],
        ),
      );
    }
    return candidates;
  });
  retryCompoundText(waitFor, negative, predicates, sets, resolve);
  const candidates = [...new Set(sets.flat())].sort(
    (a, b) => a.windowRank - b.windowRank || a.index - b.index,
  );
  const eligible = candidates.filter((candidate) =>
    waitFor.matchType === "any"
      ? sets.some((set) => set.includes(candidate))
      : sets.every((set) => set.includes(candidate)),
  );
  return chooseWaitElement(selectionFinder, eligible, waitFor, negative, evaluation);
};

const hasElementPredicate = (
  waitFor: Pick<
    ObserveWaitForOptions,
    "elementId" | "text" | "textAny" | "className" | "contentDescription"
  >,
): boolean =>
  waitFor.elementId !== undefined ||
  waitFor.text !== undefined ||
  waitFor.textAny !== undefined ||
  waitFor.className !== undefined ||
  waitFor.contentDescription !== undefined;

const matchesActiveWindow = (
  observation: ObserveResult,
  waitFor: ObserveWaitForOptions,
  platform?: BootedDevice["platform"],
): boolean => {
  if (!waitFor.activeWindow) {
    return true;
  }

  const activeWindow = observation.activeWindow;
  if (!activeWindow) {
    return false;
  }

  if (
    waitFor.activeWindow.appId !== undefined &&
    activeWindow.appId !== waitFor.activeWindow.appId
  ) {
    return false;
  }

  if (
    platform === "ios" &&
    waitFor.activeWindow.activityName !== undefined &&
    waitFor.activeWindow.appId === undefined
  ) {
    return false;
  }

  if (
    platform !== "ios" &&
    waitFor.activeWindow.activityName !== undefined &&
    activeWindow.activityName !== waitFor.activeWindow.activityName
  ) {
    return false;
  }

  return true;
};

// Absence / negation predicate (issue #3490 §4). Reuses the same element
// matcher: the `absent` fields describe an element that must NOT be present, so
// the predicate is satisfied exactly when no element matches them. Returns true
// (vacuously satisfied) when no `absent` predicate is configured.
const matchesAbsent = (
  finder: ConditionResolver,
  waitFor: ObserveWaitForOptions,
  viewHierarchy: ViewHierarchyResult,
  platform: BootedDevice["platform"] | undefined,
  sizeOptions: ScreenSizeForOffscreenCheckOptions,
  evaluation: ConditionEvaluation,
): boolean => {
  if (!waitFor.absent) {
    return true;
  }
  const absentAsWaitFor = {
    ...waitFor.absent,
    container: waitFor.container,
    selectionStrategy: waitFor.absent.selectionStrategy ?? waitFor.selectionStrategy,
  } as ObserveWaitForOptions;
  return (
    findWaitForElement(finder, absentAsWaitFor, viewHierarchy, platform, new Map(), {
      ...sizeOptions,
      negative: true,
      evaluation,
    }) === null && !evaluation.diagnostic
  );
};

const matchesDisplayStamp = (
  observation: ObserveResult,
  waitFor: ObserveWaitForOptions,
  displayInventory: DisplayInventoryClassification,
): boolean => {
  const display = observation.display;
  const isSingleInventoryStub =
    displayInventory === "single" && display?.key === "0" && display.role === "unknown";
  return (
    (waitFor.posture === undefined || display?.posture === waitFor.posture) &&
    (waitFor.activeDisplay === undefined ||
      (!isSingleInventoryStub &&
        (display?.key === waitFor.activeDisplay || display?.role === waitFor.activeDisplay)))
  );
};

/**
 * The observation an element predicate sees for `layer` (issue #9305). Only the
 * hierarchy is scoped; the polled observation itself, and the cache behind it,
 * keep every window.
 */
function layerScopedObservation(
  observation: ObserveResult,
  layer: HierarchyLayer | undefined,
): ObserveResult {
  if (layer === undefined || !observation.viewHierarchy) {
    return observation;
  }
  return {
    ...observation,
    viewHierarchy: scopeHierarchyToLayer(observation.viewHierarchy, layer),
  };
}

const evaluateWaitForObservation = (
  finder: ConditionResolver,
  waitFor: WaitForWithSettled,
  observation: ObserveResult,
  platform: BootedDevice["platform"] | undefined,
  displayInventory: DisplayInventoryClassification,
  { modes, iosMultiPanel }: { modes: Map<string, MatchMode>; iosMultiPanel: boolean },
): ObserveConditionEvaluation & { awaitedElement?: Element } => {
  observation = layerScopedObservation(observation, waitFor.layer);
  const sizeOptions = {
    platform,
    iosMultiPanel,
    observationScreenSize: observation.screenSize,
    display: observation.viewHierarchy,
  };
  const evaluation: ObserveConditionEvaluation = { matched: false };
  const tracked = trackContainerFailure(finder, waitFor.container);
  finder = tracked.finder;
  const needsHierarchy =
    hasElementPredicate(waitFor) || waitFor.absent !== undefined || waitFor.settled !== undefined;
  const diagnostic = needsHierarchy ? waitCaptureUnavailableReason(observation) : undefined;
  if (diagnostic) {
    return { matched: false, diagnostic };
  }
  const activeWindowMatched = matchesActiveWindow(observation, waitFor, platform);
  const displayMatched = matchesDisplayStamp(observation, waitFor, displayInventory);
  const needsElementMatch = hasElementPredicate(waitFor);
  const awaitedElement =
    needsElementMatch && observation.viewHierarchy
      ? findWaitForElement(finder, waitFor, observation.viewHierarchy, platform, modes, {
          ...sizeOptions,
          evaluation,
        })
      : null;
  // The shared admission guard above ensures absence is evaluated only on a
  // usable capture; an unavailable tree cannot prove that an element is gone.
  const absentSatisfied =
    waitFor.absent === undefined
      ? true
      : observation.viewHierarchy
        ? matchesAbsent(
            finder,
            waitFor,
            observation.viewHierarchy,
            platform,
            sizeOptions,
            evaluation,
          )
        : false;

  const matched = [
    activeWindowMatched,
    displayMatched,
    absentSatisfied,
    !needsElementMatch || awaitedElement !== null,
  ].every(Boolean);
  return {
    ...evaluation,
    ...containerFailureMetadata(!matched, tracked.failure()),
    matched,
    awaitedElement: awaitedElement ?? undefined,
  };
};

const SETTLE_VOLATILE_NODE_FIELDS = new Set([
  "extras",
  "occlusionState",
  "occludedBy",
  "occludedByViewId",
  "recomposition",
  "recompositionMetrics",
]);

function normalizeSettleValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeSettleValue);
  }
  if (value !== null && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeSettleValue((value as Record<string, unknown>)[key]);
    }
    return normalized;
  }
  return value;
}

function normalizeSettleAttributes(
  attributes: Record<string, unknown>,
  excludedFields: ReadonlySet<string>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(attributes).sort()) {
    if (!excludedFields.has(key)) {
      normalized[key] = normalizeSettleValue(attributes[key]);
    }
  }
  return normalized;
}

function normalizeSettleNode(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const node = value as ViewHierarchyNode;
  const nodeRecord: Record<string, unknown> = { ...node };
  const attributes = nodeAttributes(node);
  const normalized = normalizeSettleAttributes(
    nodeRecord,
    new Set([...SETTLE_VOLATILE_NODE_FIELDS, "node", "$"]),
  );
  // Hash every node field by default so newly added accessibility attributes
  // (for example iOS value or Android hint/error) cannot hide UI changes.
  // Only known capture noise is excluded from the settle signal.
  if (node.$ !== undefined) {
    normalized.$ = normalizeSettleAttributes(attributes, SETTLE_VOLATILE_NODE_FIELDS);
  }
  const children = node.node;
  if (children !== undefined) {
    const childNodes = Array.isArray(children) ? children : [children];
    normalized.node = childNodes.map(normalizeSettleNode);
  }
  return normalized;
}

function normalizeHierarchyForSettle(hierarchy: ViewHierarchyResult["hierarchy"]): unknown {
  const root = hierarchy.node;
  if (root === undefined) {
    return hierarchy.bounds === undefined
      ? null
      : { bounds: normalizeSettleValue(hierarchy.bounds) };
  }
  const nodes = Array.isArray(root) ? root : [root];
  return {
    ...(hierarchy.bounds === undefined ? {} : { bounds: normalizeSettleValue(hierarchy.bounds) }),
    node: nodes.map(normalizeSettleNode),
  };
}

// Compact stable hash of the hierarchy node tree, used only to detect quiet
// (settled) periods. Screen size / window metadata are excluded so cosmetic,
// non-hierarchy churn does not defeat the gate. A missing hierarchy hashes to a
// stable sentinel, so it counts as "quiet". Returns null when the tree cannot be
// hashed, which the settle gate treats as unstable (never settle on it).
export const hashHierarchyForSettle = (viewHierarchy?: ViewHierarchyResult): string | null => {
  try {
    const normalized = viewHierarchy ? normalizeHierarchyForSettle(viewHierarchy.hierarchy) : null;
    return NodeCryptoService.generateCacheKey(JSON.stringify(normalized));
  } catch (error) {
    // Non-serializable hierarchy is unexpected; a constant sentinel would compare
    // equal across consecutive failures and be mistaken for a quiet tree, so
    // return null and let settleReady restart the quiet window instead.
    logger.debug(`[observe] Failed to hash hierarchy for settle gate: ${error}`);
    return null;
  }
};

interface DisplayWaitTimeoutEvidence {
  knownValueObserved: boolean;
  hierarchyCaptured: boolean;
  lastObservedReason: string;
}

function displayWaitTimeoutReason(
  waitKind: "posture" | "activeDisplay",
  requested: string,
  duration: number,
  inventory: DisplayInventoryClassification,
  evidence: DisplayWaitTimeoutEvidence,
): string {
  let reason = evidence.lastObservedReason;
  if (!evidence.knownValueObserved) {
    if (inventory === "unavailable") {
      reason =
        waitKind === "posture"
          ? "display inventory was unavailable so posture support was never confirmed"
          : "display inventory was unavailable so the active display was never confirmed";
    } else if (!evidence.hierarchyCaptured) {
      reason =
        waitKind === "posture"
          ? "posture was never observable because no hierarchy was captured"
          : "the active display was never observable because no hierarchy was captured";
    }
  }
  return `Timed out after ${duration} ms waiting for ${waitKind} "${requested}"; ${reason}`;
}

function recordDisplayWaitEvidence(
  observation: ObserveResult,
  postureEvidence: DisplayWaitTimeoutEvidence,
  activeDisplayEvidence: DisplayWaitTimeoutEvidence,
): void {
  if (observation.display?.posture !== undefined) {
    postureEvidence.lastObservedReason = `last observed posture "${observation.display.posture}"`;
  }
  postureEvidence.knownValueObserved ||=
    observation.display !== undefined && observation.display.posture !== "unknown";
  postureEvidence.hierarchyCaptured ||= hasUsableHierarchy(observation.viewHierarchy);
  activeDisplayEvidence.lastObservedReason = observation.display
    ? `last observed active display "${observation.display.key}" (${observation.display.role})`
    : 'last observed active display "unknown"';
  activeDisplayEvidence.knownValueObserved ||=
    observation.display !== undefined &&
    !(observation.display.key === "0" && observation.display.role === "unknown");
  activeDisplayEvidence.hierarchyCaptured ||= hasUsableHierarchy(observation.viewHierarchy);
}

function scopedWaitTimeoutMetadata(evaluation: ObserveConditionEvaluation, waitMs: number) {
  return {
    ...containerFailureMetadata(!evaluation.matched, evaluation.containerFailure),
    ...(evaluation.diagnostic
      ? {
          candidates: evaluation.candidates,
          timeoutReason: `Timed out after ${waitMs} ms waiting for element; ${evaluation.diagnostic}`,
        }
      : {}),
  };
}

export const waitForObservation = async (
  observeScreen: ObserveScreen,
  waitFor: WaitForWithSettled,
  signal?: AbortSignal,
  skipBackStack: boolean = false,
  timer: Timer = defaultTimer,
  platform?: BootedDevice["platform"],
  screenshot?: ScreenshotMode,
  screenshotOptions?: z.infer<typeof screenshotOptionsSchema>,
  displayInventory: DisplayInventoryClassification = "unavailable",
  displayPanels: readonly Pick<DisplayPanel, "key" | "role">[] = [],
): Promise<WaitForObservationOutcome> => {
  const iosMultiPanel = hasIosWaitPanels(platform, displayPanels);
  const postureEvidence: DisplayWaitTimeoutEvidence = {
    lastObservedReason: 'last observed posture "unknown"',
    knownValueObserved: false,
    hierarchyCaptured: false,
  };
  const activeDisplayEvidence: DisplayWaitTimeoutEvidence = {
    lastObservedReason: 'last observed active display "unknown"',
    knownValueObserved: false,
    hierarchyCaptured: false,
  };
  const complete = createWaitCompletion({
    waitFor,
    displayInventory,
    postureEvidence,
    activeDisplayEvidence,
    screenshot,
    observeScreen,
    signal,
    screenshotOptions,
  });

  // Declarative `for` DSL (issue #4398) routes to the #4389 primitives; the
  // legacy element/textAny/activeWindow path below is unchanged (back-compat).
  if (isConditionDsl(waitFor)) {
    return complete(
      await runWaitForConditionDsl(observeScreen, waitFor, signal, timer, skipBackStack, platform),
    );
  }

  const startTime = timer.now();
  const timeoutMs = legacyWaitTimeout(waitFor);
  const settled = waitFor.settled;
  const finder = new ElementResolver();
  const queryOptions = waitObservationQuery(waitFor);

  // Back-stack collection may stay disabled during waitFor polling to preserve its
  // timeout budget. Screenshots always stay suppressed during polls; when opted
  // in, `complete` captures exactly one screenshot from the terminal state.
  const skipPollingOverhead = !serverConfig.isWaitForPollingOverheadEnabled();

  const observeOnce = createWaitObserver({
    observeScreen,
    queryOptions,
    timeoutMs,
    timer,
    startTime,
    signal,
    skipPollingOverhead,
    skipBackStack,
    postureEvidence,
    activeDisplayEvidence,
  });

  // Settle gate (issue #3490 §3): once the predicate matches, hold until the
  // hierarchy hash is unchanged for settled.quietPeriodMs. `matchedHash === null`
  // means "no stable candidate yet"; a changed hash restarts the quiet window.
  let matchedHash: string | null = null;
  let quietStart = startTime;
  const settleReady = (observation: ObserveResult): boolean => {
    if (!settled) {
      return true;
    }
    const hash = hashHierarchyForSettle(observation.viewHierarchy);
    // An unhashable tree (null) is never quiet: fall through to restart the
    // window so the gate cannot resolve early on an unverifiable snapshot.
    if (hash === null || matchedHash === null || hash !== matchedHash) {
      matchedHash = hash;
      quietStart = timer.now();
      return false;
    }
    return timer.now() - quietStart >= settled.quietPeriodMs;
  };

  const resetMatchedHash = () => {
    matchedHash = null;
  };

  throwIfAborted(signal);
  // Evaluate the current cache on the first poll, then use its device-clock
  // timestamp to request a strictly newer hierarchy on later polls.
  let observation = await observeOnce(0);
  throwIfAborted(signal);
  checkWaitDisplaySupport(waitFor, displayInventory, displayPanels);
  const baselineTimestamp = waitBaselineTimestamp(observation);
  // A posture-only stamp is read independently of hierarchy capture, including
  // while folding locks the device. UI predicates/settling still need a fresh tree.
  const needsHierarchyFreshness = needsWaitHierarchyFreshness(waitFor, settled);
  const minTimestamp = waitTimestampFloor(needsHierarchyFreshness, baselineTimestamp);
  let polls = 1;
  const modes = new Map<string, MatchMode>();
  let waitEvaluation = evaluateWaitForObservation(
    finder,
    waitFor,
    observation,
    platform,
    displayInventory,
    { modes, iosMultiPanel },
  );

  if (waitMatchReady(waitEvaluation, observation, settleReady, resetMatchedHash)) {
    const waitMs = timer.now() - startTime;
    return complete(matchedWaitOutcome({ observation, waitEvaluation, waitMs, settled, polls }));
  }
  if (timer.now() - startTime >= timeoutMs) {
    const waitMs = timer.now() - startTime;
    return complete(timedOutWaitOutcome({ observation, waitEvaluation, waitMs, settled, polls }));
  }

  while (timer.now() - startTime < timeoutMs) {
    await awaitWhileRequestIsLive(timer.sleep(WAIT_FOR_POLL_INTERVAL_MS), signal);
    throwIfAborted(signal);

    polls++;
    try {
      observation = await observeOnce(minTimestamp);
    } catch (error) {
      throwDeviceLostFromAbortSignal(signal);
      if (shouldRethrowWaitObservationError(error, waitFor, signal)) {
        logger.debug("[observe] Wait observation failed", error);
        throw error;
      }
      // A fold may lock/disconnect capture before posture is observable; retry within the deadline.
      logger.debug("[observe] Posture transition interrupted observation; retrying", error);
      waitEvaluation = { matched: false };
      matchedHash = null;
      continue;
    }
    throwIfAborted(signal);
    checkWaitDisplaySupport(waitFor, displayInventory, displayPanels);
    const observedTimestamp = hierarchyUpdatedAtToMillis(observation.viewHierarchy);
    // A timed-out delegate may return its old cache despite the requested
    // floor. It must not satisfy waitFor as post-invocation evidence.
    waitEvaluation = evaluateFreshWaitObservation({
      minTimestamp,
      observedTimestamp,
      finder,
      waitFor,
      observation,
      platform,
      displayInventory,
      modes,
      iosMultiPanel,
    });

    if (waitMatchReady(waitEvaluation, observation, settleReady, resetMatchedHash)) {
      const waitMs = timer.now() - startTime;
      return complete(matchedWaitOutcome({ observation, waitEvaluation, waitMs, settled, polls }));
    }
  }

  const waitMs = timer.now() - startTime;
  return complete(timedOutWaitOutcome({ observation, waitEvaluation, waitMs, settled, polls }));
};

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
 * that asks for the overlay while none is showing is an actionable error; a
 * waitFor observe returns the (empty) scoped capture so its timeout reports the miss.
 */
function layerScopedObserveResult(
  result: ObserveResult,
  layer: HierarchyLayer | undefined,
  platform: BootedDevice["platform"],
  requireOverlay: boolean,
): ObserveResult {
  if (layer === undefined) {
    return result;
  }
  if (requireOverlay && result.viewHierarchy) {
    scopeHierarchyForSelector(result.viewHierarchy, layer);
  }
  const scoped = scopeObserveResultToLayer(result, layer, platform);
  return layer === "app" && carriesScreenshot(result) && hasOwnOverlay(result.viewHierarchy)
    ? { ...scoped, screenshotIncludesOverlay: true }
    : scoped;
}

/**
 * Whether the observation carries a screenshot or crop. Neither the Android CtrlProxy nor the iOS
 * overlay agent can hide its overlay window for a capture, so a `layer: "app"` screenshot still
 * shows the overlay and `observe` says so instead of implying an app-only image (issue #9305).
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
      // ObserveScreen.execute() rejects stale cross-platform hierarchies at the
      // source, so every observation reaching here is already platform-validated
      // (raw-mode append below is likewise gated on a validated primary hierarchy).
      const waitOutcome = observeWaitRequested(deviceRead, args)
        ? await waitForObservation(
            ...observeWaitParameters(
              observeScreen,
              args,
              signal,
              dependencies,
              device,
              screenshotMode,
            ),
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
              screenshotOptions: args.screenshotOptions,
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
      const observeScreen = dependencies.createScreen?.(device) ?? new RealObserveScreen(device);
      const cachedResult = await readObservationForInteractions(observeScreen);
      const navigationGraph = args.sessionUuid
        ? NavigationGraphManager.getInstanceForSession(args.sessionUuid)
        : NavigationGraphManager.getInstance();
      const currentScreen = navigationGraph.getCurrentScreen();
      const navigationEdges =
        args.includeContext?.navigationGraph !== false && currentScreen
          ? await navigationGraph.getEdgesFrom(currentScreen)
          : [];

      const analyzer = new IdentifyInteractions();
      const result = analyzer.analyze(cachedResult, args, currentScreen, navigationEdges);

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
    `Android synthetic s2- element ids are valid only for the observation that returned them; re-observe before using an id after the screen changes. Get screen view hierarchy and screenshot, with optional PNG crop from a fresh settled capture of one display. Opt-in Android display:'all' adds per-panel displays to the unchanged active-panel result, without updating observation baselines or transition fences; rejects waitFor, raw:true and includeScreenshotImage:true. An explicit deviceId without sessionUuid creates no session, assigns no device and leaves an idle device idle. It may start an unowned device's hierarchy service using session setup within the read deadline, serialized with acquisition, guarded against ownership/pool transitions, and shared across concurrent reads. hierarchyServiceStarted: true reports this; the service and resident client remain running. Owned devices stay connect-only: this read never starts, restarts or reconfigures their service. With sessionUuid, observe uses the session and deviceId must match the session's device. DeviceId reads reject waitFor, raw: true and skipBackStack: true; use project: 'full' for the full filtered hierarchy. They omit snapshotReference and default to a settled screenshot; async also awaits capture. Each screenshot path is valid for at least 10 minutes after the response that returned it; expiresAt metadata uses the host clock. Returning cached paths extends their lifetime. The shared 128 MiB / 4096-file cap refuses new captures without deleting live paths: default screenshot provenance degrades with a reason; explicit settled, crop and inline-image requests fail. Release and device removal leave files until their guarantees expire. Restart uses a ten-minute process-start grace; other processes can only honor the ten-minute mtime floor. Capacity uses a per-process in-memory inventory reconciled on sweeps and near either cap. Concurrent processes can exceed the aggregate cap before reconciliation; discovered files count against subsequent admission. Expired files are swept at initial inventory, near capacity and every minute while idle. Copy files needed beyond the guarantee.`,
    observeSchema,
    observeHandler,
    {
      defaultEnabled: true,
      // Watching is allowed on any device, whichever session holds it (#10730).
      deviceReadOnly: true,
      transportRecovery: "replay",
      outputSchema: observeToolResultSchema,
      appUiResourceUri: OBSERVE_APP_RESOURCE_URI,
      sessionlessDeviceRead: {
        resolve: (deviceId, signal) =>
          resolveDeviceForObservationRead(deviceId, signal, dependencies.deviceReadAccess),
        assertAuthorized: (device) =>
          assertObservationReadAccess(device, dependencies.deviceReadAccess),
      },
    },
  );

  ToolRegistry.registerDeviceAware(
    "identifyInteractions",
    "Suggest likely interactions",
    identifyInteractionsSchema,
    identifyInteractionsHandler,
    { defaultEnabled: true, debugOnly: true, deviceReadOnly: true },
  );
}

function createSettledGate({
  settled,
  timer,
  startTime,
  timeoutMs,
  signal,
  pollingScreen,
  skipBackStack,
  platform,
}: {
  settled: SettledOptions | undefined;
  timer: Timer;
  startTime: number;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  pollingScreen: ObserveScreen;
  skipBackStack: boolean;
  platform: BootedDevice["platform"] | undefined;
}) {
  return async (
    outcome: WaitForObservationOutcome,
    matched: boolean,
    recheck: ConditionPredicate = () => ({ matched: true }),
  ): Promise<WaitForObservationOutcome> => {
    if (!settled || !matched) {
      return outcome;
    }
    let observation = outcome.observation;
    // The floor must be in the device clock domain, like the `updatedAt` it is
    // compared with (#9878, same class as #6430). The matched capture's own
    // device stamp is inclusive, so it admits that capture (as the host
    // `startTime` floor did with no skew) without rejecting every read of a
    // still screen on a device whose clock trails the host. No device stamp
    // (unavailable capture) means unfloored, as the #6430 loop does. iOS keeps
    // the host `startTime` floor: the runner stamps `updatedAt` with its own
    // `Date()`, which is the host clock for simulators but not clearly
    // comparable for a physical device, so that path is unchanged.
    const minTimestamp = settledGateFloor(observation, platform, startTime);
    let matchedHash = hashHierarchyForSettle(observation.viewHierarchy);
    let quietStart = timer.now();
    let polls = outcome.polls;
    let matchedElement = outcome.matchedElement;
    let awaitedElement = outcome.awaitedElement;
    let conditionMatched = true;
    let lastEvaluation: ObserveConditionEvaluation = { matched: true };
    while (timer.now() - startTime < timeoutMs) {
      if (matchedHash !== null && timer.now() - quietStart >= settled.quietPeriodMs) {
        return {
          ...outcome,
          observation,
          matchedElement,
          awaitedElement,
          matched: true,
          settled: true,
          timedOut: false,
          awaitTimeout: false,
          waitMs: timer.now() - startTime,
          awaitDuration: timer.now() - startTime,
          polls,
        };
      }
      await awaitWhileRequestIsLive(timer.sleep(WAIT_FOR_POLL_INTERVAL_MS), signal);
      throwIfAborted(signal);
      observation = await pollingScreen.execute({
        timeoutMs: Math.max(0, timeoutMs - (timer.now() - startTime)),
        skipWaitForFresh: false,
        minTimestamp,
        signal,
        skipBackStack: skipBackStack || undefined,
        skipScreenshot: true,
        skipAccessibilityAudit: true,
        skipStaleWindowRecovery: true,
      });
      throwIfAborted(signal);
      polls++;
      const unavailableReason = waitCaptureUnavailableReason(observation);
      const evaluation: ObserveConditionEvaluation = unavailableReason
        ? { matched: false, diagnostic: unavailableReason }
        : recheck(observation);
      lastEvaluation = evaluation;
      if (!evaluation.matched) {
        conditionMatched = false;
        matchedHash = null;
        quietStart = timer.now();
        matchedElement = undefined;
        awaitedElement = undefined;
        continue;
      }
      conditionMatched = true;
      matchedElement = evaluation.matchedElement;
      awaitedElement = evaluation.matchedElement;
      const hash = hashHierarchyForSettle(observation.viewHierarchy);
      if (hash === null || hash !== matchedHash) {
        matchedHash = hash;
        quietStart = timer.now();
      }
    }
    const unavailableReason = waitCaptureUnavailableReason(observation);
    return {
      ...outcome,
      observation,
      matchedElement,
      awaitedElement,
      settled: false,
      timedOut: true,
      matched: conditionMatched,
      ...containerFailureMetadata(!conditionMatched, lastEvaluation.containerFailure),
      ...scopedWaitTimeoutMetadata(
        { matched: conditionMatched, diagnostic: unavailableReason },
        timer.now() - startTime,
      ),
      awaitTimeout: true,
      waitMs: timer.now() - startTime,
      awaitDuration: timer.now() - startTime,
      polls,
    };
  };
}

function createWaitCompletion({
  waitFor,
  displayInventory,
  postureEvidence,
  activeDisplayEvidence,
  screenshot,
  observeScreen,
  signal,
  screenshotOptions,
}: {
  waitFor: WaitForWithSettled;
  displayInventory: DisplayInventoryClassification;
  postureEvidence: DisplayWaitTimeoutEvidence;
  activeDisplayEvidence: DisplayWaitTimeoutEvidence;
  screenshot: ScreenshotMode | undefined;
  observeScreen: ObserveScreen;
  signal: AbortSignal | undefined;
  screenshotOptions: z.infer<typeof screenshotOptionsSchema> | undefined;
}) {
  return async (outcome: WaitForObservationOutcome): Promise<WaitForObservationOutcome> => {
    if (outcome.timedOut && waitFor.posture !== undefined) {
      outcome.timeoutReason = displayWaitTimeoutReason(
        "posture",
        waitFor.posture,
        outcome.awaitDuration,
        displayInventory,
        postureEvidence,
      );
    } else if (outcome.timedOut && waitFor.activeDisplay !== undefined) {
      outcome.timeoutReason = displayWaitTimeoutReason(
        "activeDisplay",
        waitFor.activeDisplay,
        outcome.awaitDuration,
        displayInventory,
        activeDisplayEvidence,
      );
    }
    const mode = resolveScreenshotMode(screenshot);
    if (
      mode === "settled" ||
      (mode === "async" &&
        (!shouldSkipObserveWaitForScreenshot() || serverConfig.isAccessibilityAuditEnabled()))
    ) {
      await observeScreen.captureScreenshot?.(
        createGlobalPerformanceTracker(),
        signal,
        outcome.observation,
        screenshot,
        screenshotOptions,
      );
    } else {
      await observeScreen.runAccessibilityAudit?.(
        outcome.observation,
        createGlobalPerformanceTracker(),
      );
    }
    return outcome;
  };
}

function createWaitObserver({
  observeScreen,
  queryOptions,
  timeoutMs,
  timer,
  startTime,
  signal,
  skipPollingOverhead,
  skipBackStack,
  postureEvidence,
  activeDisplayEvidence,
}: {
  observeScreen: ObserveScreen;
  queryOptions: { text: string | undefined; elementId: string | undefined };
  timeoutMs: number;
  timer: Timer;
  startTime: number;
  signal: AbortSignal | undefined;
  skipPollingOverhead: boolean;
  skipBackStack: boolean;
  postureEvidence: DisplayWaitTimeoutEvidence;
  activeDisplayEvidence: DisplayWaitTimeoutEvidence;
}) {
  return async (minTimestamp: number) => {
    const observation = await observeScreen.execute({
      queryOptions,
      timeoutMs: Math.max(0, timeoutMs - (timer.now() - startTime)),
      perf: createGlobalPerformanceTracker(),
      skipWaitForFresh: false,
      minTimestamp,
      signal,
      skipBackStack: skipPollingOverhead || skipBackStack,
      skipScreenshot: true,
      skipAccessibilityAudit: true,
      skipStaleWindowRecovery: true,
    });
    recordDisplayWaitEvidence(observation, postureEvidence, activeDisplayEvidence);
    return observation;
  };
}

interface WaitOutcomeState {
  observation: ObserveResult;
  waitEvaluation: ReturnType<typeof evaluateWaitForObservation>;
  waitMs: number;
  settled: SettledOptions | undefined;
  polls: number;
}

function matchedWaitOutcome({
  observation,
  waitEvaluation,
  waitMs,
  settled,
  polls,
}: WaitOutcomeState): WaitForObservationOutcome {
  return {
    observation,
    awaitedElement: waitEvaluation.awaitedElement,
    awaitDuration: waitMs,
    awaitTimeout: false,
    matched: true,
    settled: settled ? true : undefined,
    timedOut: false,
    polls,
    waitMs,
    matchedElement: waitEvaluation.awaitedElement,
  };
}

function timedOutWaitOutcome({
  observation,
  waitEvaluation,
  waitMs,
  settled,
  polls,
}: WaitOutcomeState): WaitForObservationOutcome {
  return {
    observation,
    awaitedElement: waitEvaluation.matched ? waitEvaluation.awaitedElement : undefined,
    awaitDuration: waitMs,
    awaitTimeout: true,
    matched: waitEvaluation.matched,
    settled: settled ? false : undefined,
    timedOut: true,
    polls,
    waitMs,
    matchedElement: waitEvaluation.matched ? waitEvaluation.awaitedElement : undefined,
    ...scopedWaitTimeoutMetadata(waitEvaluation, waitMs),
  };
}

function needsWaitHierarchyFreshness(
  waitFor: WaitForWithSettled,
  settled: SettledOptions | undefined,
): boolean {
  return (
    waitFor.posture === undefined ||
    hasElementPredicate(waitFor) ||
    waitFor.absent !== undefined ||
    waitFor.activeWindow !== undefined ||
    settled !== undefined
  );
}

function shouldRethrowWaitObservationError(
  error: unknown,
  waitFor: WaitForWithSettled,
  signal: AbortSignal | undefined,
): boolean | undefined {
  return (
    isDeviceLostError(error) ||
    waitFor.posture === undefined ||
    signal?.aborted ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function checkWaitDisplaySupport(
  waitFor: WaitForWithSettled,
  displayInventory: DisplayInventoryClassification,
  displayPanels: readonly Pick<DisplayPanel, "key" | "role">[],
): void {
  if (
    waitFor.activeDisplay !== undefined &&
    !canDisplayExist(displayInventory, displayPanels, waitFor.activeDisplay)
  ) {
    throw new ActionableError(
      "Cannot wait for activeDisplay: this device has no display inventory. Select a device that reports display panels and posture and retry.",
    );
  }
  if (waitFor.posture !== undefined && displayInventory === "single") {
    throw new ActionableError(
      "Cannot wait for posture: this device has no display inventory. Select a device that reports display panels and posture and retry.",
    );
  }
}

function hasIosWaitPanels(
  platform: BootedDevice["platform"] | undefined,
  displayPanels: readonly Pick<DisplayPanel, "key" | "role">[],
): boolean {
  return platform === "ios" && displayPanels.length > 1;
}

function legacyWaitTimeout(waitFor: WaitForWithSettled): number {
  return waitFor.timeout ?? waitFor.timeoutMs ?? DEFAULT_WAIT_FOR_TIMEOUT_MS;
}

function waitObservationQuery(waitFor: WaitForWithSettled) {
  return {
    text: waitFor.text ?? waitFor.textAny?.[0] ?? waitFor.contentDescription,
    elementId: waitFor.elementId,
  };
}

function waitTimestampFloor(
  needsHierarchyFreshness: boolean,
  baselineTimestamp: number | undefined,
): number {
  return needsHierarchyFreshness && baselineTimestamp !== undefined && baselineTimestamp > 0
    ? baselineTimestamp + 1
    : 0;
}

/** Settled-gate floor: iOS keeps the host `startTime`; otherwise the matched capture's own device stamp, else unfloored. */
function settledGateFloor(
  observation: ObserveResult,
  platform: BootedDevice["platform"] | undefined,
  startTime: number,
): number {
  return platform === "ios" ? startTime : (waitBaselineTimestamp(observation) ?? 0);
}

function waitBaselineTimestamp(observation: ObserveResult): number | undefined {
  return waitCaptureUnavailableReason(observation)
    ? undefined
    : hierarchyUpdatedAtToMillis(observation.viewHierarchy);
}

function evaluateFreshWaitObservation({
  minTimestamp,
  observedTimestamp,
  finder,
  waitFor,
  observation,
  platform,
  displayInventory,
  modes,
  iosMultiPanel,
}: {
  minTimestamp: number;
  observedTimestamp: number | undefined;
  finder: ElementResolver;
  waitFor: WaitForWithSettled;
  observation: ObserveResult;
  platform: BootedDevice["platform"] | undefined;
  displayInventory: DisplayInventoryClassification;
  modes: Map<string, MatchMode>;
  iosMultiPanel: boolean;
}): ReturnType<typeof evaluateWaitForObservation> {
  return minTimestamp > 0 && (observedTimestamp === undefined || observedTimestamp < minTimestamp)
    ? {
        matched: false,
        awaitedElement: undefined,
        diagnostic: waitCaptureUnavailableReason(observation),
      }
    : evaluateWaitForObservation(finder, waitFor, observation, platform, displayInventory, {
        modes,
        iosMultiPanel,
      });
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
  screenshotMode: ScreenshotMode | undefined,
): Parameters<typeof waitForObservation> {
  return [
    observeScreen,
    { ...args.waitFor, settled: args.settled, layer: args.layer },
    signal,
    args.skipBackStack ?? false,
    dependencies.timer ?? defaultTimer,
    device.platform,
    screenshotMode,
    args.screenshotOptions,
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

function waitMatchReady(
  waitEvaluation: ReturnType<typeof evaluateWaitForObservation>,
  observation: ObserveResult,
  settleReady: (observation: ObserveResult) => boolean,
  resetMatchedHash: () => void,
): boolean {
  if (waitEvaluation.matched) {
    return settleReady(observation);
  }
  resetMatchedHash();
  return false;
}
