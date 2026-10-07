import { resolveTransportDeadlineMs } from "./formTools";
import { imageRelativePointSchema } from "./imageRelativePointSchema";
import { INTERNAL_MCP_REQUEST_DEADLINE_PARAM } from "../daemon/constants";
import { toActionableError } from "../models/ActionableError";
import { nodeAttributes } from "../models/ViewHierarchyResult";
import { z } from "zod/v4";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { TapOnElement } from "../features/action/TapOnElement";
import {
  LONG_PRESS_MIN_MS,
  LONG_PRESS_MAX_MS,
  LONG_PRESS_HARD_MAX_MS,
  LONG_PRESS_DEFAULT_MS,
} from "../features/action/tapAtGesture";
import { TapAtCoordinate } from "../features/action/TapAtCoordinate";
import { previewHierarchyHitTest } from "../features/observe/HierarchyHitTest";
import { snapshotReferences } from "../features/observe/SnapshotReferenceStore";
import { TapAnyElement } from "../features/action/TapAnyElement";
import { WakeAndUnlock } from "../features/action/WakeAndUnlock";
import { DeviceLockStore } from "../devices/DeviceLockStore";
import { IosLockScreenUnlocker } from "../features/action/IosLockScreenUnlocker";
import { SelectAllText } from "../features/action/SelectAllText";
import { PressButton } from "../features/action/PressButton";
import {
  DragAndDrop,
  PRESS_DURATION_MIN_MS,
  PRESS_DURATION_MAX_MS,
  DRAG_DURATION_MIN_MS,
  DRAG_DURATION_MAX_MS,
  HOLD_DURATION_MIN_MS,
  HOLD_DURATION_MAX_MS,
} from "../features/action/DragAndDrop";
import {
  SWIPE_APEX_PAUSE_MIN_MS,
  SWIPE_APEX_PAUSE_MAX_MS,
  SWIPE_RETURN_SPEED_MAX,
  SWIPE_RETURN_DURATION_MAX_MS,
  SWIPE_BOOMERANG_MAX_MS,
  validateSwipeTimingOptions,
  SWIPE_RETURN_SPEED_EXCLUSIVE_MIN,
} from "../features/action/swipeon/swipeTiming";
import { SwipeOn } from "../features/action/swipeon";
import {
  PinchOn,
  PINCH_DISTANCE_EXCLUSIVE_MIN,
  PINCH_SCALE_EXCLUSIVE_MIN,
  PINCH_DURATION_MIN_MS,
  PINCH_DURATION_MAX_MS,
} from "../features/action/PinchOn";
import { Shake } from "../features/action/Shake";
import {
  SHAKE_DURATION_MAX_MS,
  SHAKE_DURATION_MIN_MS,
  SHAKE_INTENSITY_MAX,
  SHAKE_INTENSITY_MIN,
} from "../models/ShakeOptions";
import { RecentApps } from "../features/action/RecentApps";
import { HomeScreen } from "../features/action/HomeScreen";
import { DaemonState } from "../daemon/daemonState";
import { runSessionRotationMutation } from "./sessionRotation";
import { Rotate, type RotateOptions } from "../features/action/Rotate";
import {
  SetPosture,
  type SetPostureOutput,
  type RequestedPosture,
  HINGE_ANGLE_MIN_DEGREES,
  HINGE_ANGLE_MAX_DEGREES,
} from "../features/device/SetPosture";
import { OpenURL } from "../features/action/OpenURL";
import { HandleIntentChooser } from "../features/action/HandleIntentChooser";
import { Clipboard } from "../features/action/Clipboard";
import { Keyboard, KeyboardOpenIndeterminateError } from "../features/action/Keyboard";
import { dismissKeyboardAfterSendKeys } from "../features/action/dismissKeyboardAfterSendKeys";
import { serverConfig } from "../utils/ServerConfig";
import { withAndroidImeLock } from "../features/action/androidImeLock";
import {
  KEYBOARD_PROFILE_CATALOG_ID,
  KEYBOARD_PROFILE_CATALOG_VERSIONS,
  KEYBOARD_PROFILE_IDS,
  type KeyboardProfileCatalog,
} from "../features/action/keyboardProfiles";
import {
  AndroidImeCatalog,
  createForegroundUserSource,
} from "../features/action/AndroidImeCatalog";
import { createInstalledImeKeySession } from "../features/action/InstalledImeKeySession";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import {
  SEND_KEYS_CLEAR_MODES,
  SEND_KEYS_MAX_COMMANDS,
  SEND_KEYS_MAX_MODIFIERS,
  SEND_KEYS_OPERATIONS,
  SEND_KEYS_SEMANTIC_KEYS,
  SEND_KEYS_TYPING_MODES,
  SendKeys,
} from "../features/action/SendKeys";
import { INPUT_KEY_MODIFIERS, SUPPORTED_INPUT_KEYS } from "../features/action/InputKey";
import {
  ActionableError,
  BootedDevice,
  ClipboardResult,
  OpenURLResult,
  PinchOnResult,
  SwipeOnToolPayload,
  type DragAndDropResult,
  type PressButtonResult,
  type RotateResult,
  type SelectAllTextResult,
  type ObserveResult,
  type TapOnElementResult,
  type TapOnSelectedElement,
} from "../models";
import { getIosInstalledAppBundleId } from "../utils/ios-cmdline-tools/iosInstalledApp";
import { errorMessage } from "../utils/describeUnknownError";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import {
  assertActiveWindowWaitForSupportedOnPlatform,
  overrideWaitForJsonSchema,
  refineWaitForArgs,
  settledSchema,
  waitForObservation,
  type WaitForObservationOutcome,
  waitForSchema,
} from "./observeTools";
import { defaultTimer } from "../utils/SystemTimer";
import { displayWaitInventory } from "../utils/deviceMatcher";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import {
  withIsErrorOnFailure,
  awaitWhileRequestIsLive,
  throwIfAborted,
  createJSONToolResponse,
  createStructuredToolResponse,
  StructuredToolResponse,
} from "../utils/toolUtils";
import { resolveSwipeDirection } from "../features/action/swipeon/swipeOnUtils";
import { RecompositionTracker } from "../features/performance/RecompositionTracker";
import {
  addDeviceTargetingToSchema,
  appIdFieldAliases,
  platformSchema,
  withAppIdAliases,
  withCanonicalDiscriminatedUnionJsonSchema,
  withJsonSchemaOverride,
  compactExclusiveSelectorProperties,
  responseShapeControlFields,
} from "./toolSchemaHelpers";
import { isTruthyFlag } from "../features/utility/elementProperties";
import {
  createElementIdTextSelectorSchema,
  tapOnSelectorSchema,
  resolverSelectionStrategySchema,
  nestedElementContainerSchema,
} from "./elementSelectorSchemas";
import {
  keyboardResultSchema,
  pressButtonResultSchema,
  wakeAndUnlockResultSchema,
  openLinkResultSchema,
  rotateResultSchema,
  setPostureResultSchema,
  sendKeysResultSchema,
  tapOnResultSchema,
} from "./toolOutputSchemas";

// Import from extracted modules
import type {
  SelectAllTextArgs,
  PressButtonArgs,
  SystemTrayNotificationArgs,
  SystemTrayArgs,
  SendKeysArgs,
  WakeAndUnlockArgs,
  OpenLinkArgs,
  TapOnArgs,
  TapAtArgs,
  TapAnyArgs,
  DragAndDropArgs,
  SwipeOnArgs,
  PinchOnArgs,
  ShakeArgs,
  KeyboardArgs,
  RecentAppsArgs,
  RotateArgs,
  ClipboardArgs,
} from "./interactionToolTypes";

import { createNotificationUIDetector } from "./system-tray/createNotificationUIDetector";

import {
  SystemTrayObserver,
  SystemTrayAdb,
  SystemTrayDependencies,
  setSystemTrayDependencies,
  resetSystemTrayDependencies,
  getSystemTrayDependencies,
  waitForNotificationMatch,
  clearMatchingSystemTrayNotifications,
  clearIosSystemTrayNotifications,
  listSystemTrayNotifications,
  NotificationShadeNotOpenError,
  readActiveNotificationKeysForApp,
  resolveUniqueTrayAppLabel,
  resolveSystemTrayAwaitTimeout,
  ensureSystemTrayOpen,
  ensureSystemTrayClosed,
  captureSystemTrayTerminalEvidence,
  observeSystemTrayAfterTap,
  resolveNotificationTapElement,
  resolveNotificationSwipeElement,
  expandAndRematchIfCollapsed,
  captureNotificationDismissBaseline,
  verifyNotificationDismissed,
  resolveNotificationGroupExpansionState,
  isSwipeTargetIsolatedFromGroup,
  tapElement,
  swipeElement,
} from "./systemTrayHelpers";

// Re-export types for backward compatibility
export type {
  SelectAllTextArgs,
  PressButtonArgs,
  SystemTrayNotificationArgs,
  SystemTrayArgs,
  SendKeysArgs,
  WakeAndUnlockArgs,
  OpenLinkArgs,
  TapOnArgs,
  TapAnyArgs,
  DragAndDropArgs,
  SwipeOnArgs,
  PinchOnArgs,
  ShakeArgs,
  KeyboardArgs,
  RecentAppsArgs,
  RotateArgs,
  ClipboardArgs,
};

// Re-export system tray helpers for backward compatibility
export type { SystemTrayObserver, SystemTrayAdb, SystemTrayDependencies };

export { setSystemTrayDependencies, resetSystemTrayDependencies, waitForNotificationMatch };

// ============================================================================
// Schema Definitions
// ============================================================================

export const shakeSchema = addDeviceTargetingToSchema(
  z
    .object({
      duration: z
        .number()
        .finite()
        .int()
        .min(SHAKE_DURATION_MIN_MS)
        .max(SHAKE_DURATION_MAX_MS)
        .optional()
        .describe(
          `Shake duration ms (${SHAKE_DURATION_MIN_MS}-${SHAKE_DURATION_MAX_MS}, default 1000)`,
        ),
      intensity: z
        .number()
        .finite()
        .min(SHAKE_INTENSITY_MIN)
        .max(SHAKE_INTENSITY_MAX)
        .optional()
        .describe(
          `Shake intensity on Android (${SHAKE_INTENSITY_MIN}-${SHAKE_INTENSITY_MAX}, default 100); ignored on iOS`,
        ),
      // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
      // not required — a device handle from getAndroid/getApple is sufficient on
      // its own.
      platform: platformSchema.optional(),
      ...responseShapeControlFields,
    })
    .strict(),
);

export const keyboardSchema = addDeviceTargetingToSchema(
  z
    .object({
      action: z
        .enum([
          "open",
          "close",
          "detect",
          "setProfile",
          "listProfiles",
          "listImes",
          "setIme",
          "tapImeKey",
        ])
        .describe(
          "Keyboard action; listProfiles returns AutoMobile behavior models and listImes returns installed Android input methods",
        ),
      profile: z
        .enum(KEYBOARD_PROFILE_IDS)
        .optional()
        .describe("AutoMobile keyboard behavior profile; required for setProfile"),
      imeId: z.string().optional().describe("Installed Android IME component; required for setIme"),
      key: z
        .string()
        .optional()
        .describe("Exact visible key text or accessibility label; required for tapImeKey"),
      // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
      // not required — a device handle from getAndroid/getApple is sufficient on
      // its own.
      platform: platformSchema.optional(),
    })
    .strict(),
);

export async function setKeyboardProfileForTool(
  device: BootedDevice,
  profile: KeyboardArgs["profile"],
  client?: Pick<AndroidCtrlProxyClient, "supportsCommand" | "setKeyboardProfile">,
  signal?: AbortSignal,
): Promise<{ activeProfileId?: string; previousProfileId?: string }> {
  if (!profile) {
    throw new ActionableError(
      `keyboard setProfile requires profile: ${KEYBOARD_PROFILE_IDS.join(", ")}.`,
    );
  }
  if (device.platform !== "android") {
    throw new ActionableError("Keyboard profiles are Android-only; select an Android device.");
  }
  const profileClient = client ?? AndroidCtrlProxyClient.getInstance(device);
  const supported = await profileClient.supportsCommand("request_set_keyboard_profile");
  throwIfAborted(signal);
  if (!supported) {
    throw new ActionableError(
      "The installed control-proxy build does not support keyboard profiles; update/re-cut the APK.",
    );
  }
  const result = await withAndroidImeLock(
    device.deviceId,
    () => {
      throwIfAborted(signal);
      return profileClient.setKeyboardProfile(profile);
    },
    signal,
  );
  if (!result.success) {
    throw new ActionableError(result.error ?? "Failed to set keyboard profile.");
  }
  return { activeProfileId: result.activeProfileId, previousProfileId: result.previousProfileId };
}

export async function listKeyboardProfilesForTool(
  device: BootedDevice,
  client?: Pick<AndroidCtrlProxyClient, "supportsCommand" | "listKeyboardProfiles">,
  signal?: AbortSignal,
): Promise<KeyboardProfileCatalog> {
  if (device.platform !== "android") {
    throw new ActionableError(
      "AutoMobile keyboard profiles are Android-only; select an Android device.",
    );
  }
  const profileClient = client ?? AndroidCtrlProxyClient.getInstance(device);
  const command = "request_list_keyboard_profiles";
  const supported = await profileClient.supportsCommand(command);
  throwIfAborted(signal);
  if (!supported) {
    throw new ActionableError(
      "The installed control-proxy build does not support keyboard profile catalogs; update/re-cut the APK.",
    );
  }
  const catalog = await profileClient.listKeyboardProfiles();
  if (!catalog.success) {
    throw new ActionableError(catalog.error ?? "Failed to list AutoMobile keyboard profiles.");
  }
  validateKeyboardProfileCatalog(catalog);
  return catalog;
}

function validateKeyboardProfileCatalog(catalog: KeyboardProfileCatalog): void {
  if (catalog.catalogId !== KEYBOARD_PROFILE_CATALOG_ID) {
    throw new ActionableError(`Unsupported keyboard profile catalog '${catalog.catalogId}'.`);
  }
  if (
    catalog.catalogVersion === undefined ||
    !KEYBOARD_PROFILE_CATALOG_VERSIONS.some((version) => version === catalog.catalogVersion)
  ) {
    throw new ActionableError(
      `Unsupported keyboard profile catalog version '${catalog.catalogVersion ?? "missing"}'.`,
    );
  }
  if (!catalog.profiles?.length || !catalog.activeProfileId) {
    throw new ActionableError("The AutoMobile keyboard profile catalog is incomplete.");
  }
  if (!catalog.profiles.some(({ id }) => id === catalog.activeProfileId)) {
    throw new ActionableError("The active AutoMobile keyboard profile is not in its catalog.");
  }
}

function validateEnsureCheckedSchema(
  value: Pick<TapOnArgs, "ensureChecked" | "action" | "selectionStrategy">,
  ctx: z.RefinementCtx,
): void {
  if (value.ensureChecked !== undefined && value.action !== "tap") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'ensureChecked requires action "tap"',
      path: ["ensureChecked"],
    });
  }
  if (value.ensureChecked !== undefined && value.selectionStrategy === "random") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "ensureChecked cannot use random selection; use a unique selector or index",
      path: ["ensureChecked"],
    });
  }
}

export const tapOnSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        selector: tapOnSelectorSchema,
        display: z.string().optional().describe("Target panel key, role, or active"),
        sibling: z
          .boolean()
          .optional()
          .describe("Tap a clickable sibling of the match, e.g. checkbox beside label"),
        container: nestedElementContainerSchema
          .optional()
          .describe(
            "Nested container scope; outermost resolves first, each level searches strict descendants. Per-level index is zero-based.",
          ),
        action: z
          .enum(["tap", "doubleTap", "longPress", "focus"])
          .default("tap")
          .describe("Action type (default: tap)"),
        selectionStrategy: resolverSelectionStrategySchema
          .optional()
          .describe(
            "Selection strategy: first (default), random, or unique. Unique requires exactly one match at every unindexed scope and target.",
          ),
        index: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "0-based index into the full candidate list, ranked by topmost window, then " +
              "smallest eligible area. Index 0 is the default first pick when candidates share " +
              "an action. Out of range → no match.",
          ),
        // A negative duration used to be accepted and silently degraded a
        // longPress into a plain tap (#5769); bound it like the sibling params.
        duration: z
          .number()
          .min(0, "must be >= 0")
          .max(LONG_PRESS_HARD_MAX_MS, `longPress duration must be <= ${LONG_PRESS_HARD_MAX_MS} ms`)
          .optional()
          .describe(
            `Long press duration (ms; maximum ${LONG_PRESS_HARD_MAX_MS}; must fit the remaining request budget including 2000 ms dispatch headroom; 0 or omitted uses the platform default)`,
          ),
        subtext: z
          .object({
            text: z
              .string()
              .trim()
              .min(1)
              .describe("Exact visible text of a semantic link inside the selected element"),
            occurrence: z
              .number()
              .int()
              .nonnegative()
              .optional()
              .describe("Zero-based occurrence among exact semantic-link matches (default: 0)"),
          })
          .strict()
          .optional()
          .describe(
            "Semantic link inside the selected element; fails if the platform does not expose that link",
          ),
        searchUntil: z
          .object({
            duration: z
              .number()
              .min(100)
              .max(12000)
              .optional()
              .describe("Polling duration (ms, default: 1500)"),
          })
          .optional()
          .describe("Poll for element before tapping"),
        preTapStability: z
          .boolean()
          .optional()
          .describe("Require stable bounds before tapping; use for dynamic UI"),
        retryIfNoChange: z
          .boolean()
          .optional()
          .describe("Retry once if the view hierarchy is unchanged after tap"),
        ensureTap: z.boolean().optional().describe("Enable preTapStability and retryIfNoChange"),
        ensureChecked: z
          .boolean()
          .optional()
          .describe(
            'Skip tapping if the resolved toggle element\'s checked state already matches this value; otherwise tap and verify it flipped. Requires the element to have the toggle affordance and action "tap".',
          ),
        // #5870: a `sessionUuid` resolves the platform, so `platform` is not
        // required — a device handle from getAndroid is sufficient on its own.
        platform: platformSchema.optional(),
        ...responseShapeControlFields,
      })
      .strict(),
  ).superRefine((value, ctx) => {
    validateEnsureCheckedSchema(value, ctx);
    const isDirectLink = "accessibilityLink" in value.selector;
    const addIssue = (invalid: unknown, message: string, path: (string | number)[]) => {
      if (!invalid) {
        return;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message,
        path,
      });
    };
    addIssue(
      value.selectionStrategy === "unique" && (value.sibling || isDirectLink),
      "unique selection cannot use sibling or direct accessibilityLink; select a unique owner with subtext instead",
      ["selectionStrategy"],
    );
    if (!isDirectLink && !value.subtext) {
      return;
    }
    addIssue(
      isDirectLink && value.subtext,
      "accessibilityLink and subtext cannot be used together",
      ["subtext"],
    );
    addIssue(value.action !== "tap", "semantic link activation supports only the tap action", [
      "action",
    ]);
    addIssue(value.sibling, "semantic link activation cannot use sibling", ["sibling"]);
    addIssue(
      value.retryIfNoChange || value.ensureTap,
      "semantic link activation cannot retry an acknowledged link activation",
      value.retryIfNoChange
        ? ["retryIfNoChange"]
        : value.ensureTap
          ? ["ensureTap"]
          : ["ensureChecked"],
    );
    addIssue(
      value.ensureChecked !== undefined,
      "semantic link activation cannot ensure checked state",
      ["ensureChecked"],
    );
    addIssue(value.searchUntil, "semantic link activation cannot use searchUntil", ["searchUntil"]);
    addIssue(
      value.subtext && value.index !== undefined,
      "owner-scoped semantic link activation cannot use index; use a unique owner selector",
      ["index"],
    );
    addIssue(
      value.subtext && value.selectionStrategy === "random",
      "owner-scoped semantic link activation cannot use random selection; use a unique owner selector",
      ["selectionStrategy"],
    );
  }),
  (js) => {
    compactExclusiveSelectorProperties(js, ["selector", "container"]);
  },
);

const coordinatePointInputSchema = () =>
  addDeviceTargetingToSchema(
    z
      .object({
        display: z.string().optional().describe("Target panel key, role, or active"),
        snapshotId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Short-lived reference from observe.snapshotReference; reject stale geometry or frame context",
          ),
        x: z
          .number()
          .describe("Screen x coordinate in the selected coordinateSpace (native by default)"),
        y: z
          .number()
          .describe("Screen y coordinate in the selected coordinateSpace (native by default)"),
        coordinateSpace: z
          .enum(["absolute", "normalized", "percent"])
          .optional()
          .describe(
            "Coordinate units: native absolute (default), normalized 0–1, or percent 0–100",
          ),
        ...responseShapeControlFields,
      })
      .strict(),
  );

type CoordinatePointInput = z.infer<ReturnType<typeof coordinatePointInputSchema>>;

function validateCoordinateRange(
  value: { x?: number; y?: number; coordinateSpace?: CoordinatePointInput["coordinateSpace"] },
  context: z.RefinementCtx,
): void {
  const max =
    value.coordinateSpace === "normalized"
      ? 1
      : value.coordinateSpace === "percent"
        ? 100
        : undefined;
  if (max === undefined) {
    return;
  }
  for (const axis of ["x", "y"] as const) {
    if (
      value[axis] === undefined ||
      !Number.isFinite(value[axis]) ||
      value[axis] < 0 ||
      value[axis] > max
    ) {
      context.addIssue({
        code: "custom",
        message: `${axis} must be between 0 and ${max}`,
        path: [axis],
      });
    }
  }
}

export const tapAtSchema = withJsonSchemaOverride(
  coordinatePointInputSchema()
    .extend({
      x: coordinatePointInputSchema().shape.x.optional(),
      y: coordinatePointInputSchema().shape.y.optional(),
      image: imageRelativePointSchema
        .optional()
        .describe(
          "Screenshot-relative point; mutually exclusive with outer x, y, and coordinateSpace. Without image, x and y are required.",
        ),
      action: z
        .enum(["tap", "longPress", "doubleTap"])
        .optional()
        .describe("Coordinate gesture (default: tap)"),
      durationMs: z
        .number()
        .int()
        .min(LONG_PRESS_MIN_MS)
        .max(LONG_PRESS_MAX_MS)
        .optional()
        .describe(
          `Long-press duration in milliseconds (${LONG_PRESS_MIN_MS}–${LONG_PRESS_MAX_MS}; default ${LONG_PRESS_DEFAULT_MS}); only with longPress`,
        ),
    })
    .superRefine((value, context) => {
      if (value.durationMs !== undefined && value.action !== "longPress") {
        context.addIssue({
          code: "custom",
          message: "durationMs is only valid with action longPress",
          path: ["durationMs"],
        });
      }
      if (value.image !== undefined) {
        if (value.x !== undefined || value.y !== undefined || value.coordinateSpace !== undefined) {
          context.addIssue({
            code: "custom",
            message: "image is mutually exclusive with x, y, and coordinateSpace",
            path: ["image"],
          });
        }
      } else {
        for (const axis of ["x", "y"] as const) {
          if (value[axis] === undefined) {
            context.addIssue({
              code: "custom",
              message: `${axis} is required without image`,
              path: [axis],
            });
          }
        }
        validateCoordinateRange(value, context);
      }
    }),
  (js) => {
    js.description =
      "Tap, long press, or double tap a screen point. Bare x/y use platform-native observe coordinates; image uses explicit normalized fractions (preferred) or real raster pixels from a screenshot or observe.crop.";
  },
);

/** The preview retains the bare coordinate target without dispatching input. */
export const hitTestSchema = withJsonSchemaOverride(
  coordinatePointInputSchema()
    .omit({ raw: true, project: true })
    .superRefine(validateCoordinateRange),
  (js) => {
    js.description =
      "Preview which hierarchy nodes sit beneath one absolute point without dispatching input.";
  },
);

export const tapAnySchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        display: z.string().optional().describe("Target panel key, role, or active"),
        container: nestedElementContainerSchema
          .optional()
          .describe(
            "Nested container scope; outermost resolves first, each level searches strict descendants. Per-level index is zero-based.",
          ),
        selectionStrategy: resolverSelectionStrategySchema
          .optional()
          .describe(
            "Element selection strategy: first (default), random, or unique; unique requires exactly one eligible target and every unindexed container",
          ),
        scrollableContainer: z
          .boolean()
          .optional()
          .describe("Search only scrollable containers/lists"),
        action: z
          .enum(["tap", "doubleTap", "longPress"])
          .default("tap")
          .describe("Action type (default: tap)"),
        // Bounded like tapOn.duration so a negative longPress cannot silently
        // become a plain tap (#5769).
        duration: z
          .number()
          .min(0, "must be >= 0")
          .max(LONG_PRESS_HARD_MAX_MS, `longPress duration must be <= ${LONG_PRESS_HARD_MAX_MS} ms`)
          .optional()
          .describe(
            `Long press duration (ms; maximum ${LONG_PRESS_HARD_MAX_MS}; must fit the remaining request budget including 2000 ms dispatch headroom; 0 or omitted uses the platform default)`,
          ),
        searchUntil: z
          .object({
            duration: z
              .number()
              .min(100)
              .max(12000)
              .optional()
              .describe("Polling duration (ms, default: 1500)"),
          })
          .optional()
          .describe("Poll for clickable element before tapping"),
        // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
        // not required — a device handle from getAndroid/getApple is sufficient on
        // its own.
        platform: platformSchema.optional(),
        ...responseShapeControlFields,
      })
      .strict(),
  ),
  (js) => compactExclusiveSelectorProperties(js, ["container"]),
);

const dragAndDropSelectorSchema = (label: "Source" | "Target") => {
  const selector = createElementIdTextSelectorSchema({
    elementId: `${label} ID`,
    text: `${label} text`,
  });
  const scope = {
    container: nestedElementContainerSchema
      .optional()
      .describe("Nested container scope for this endpoint; outermost container resolves first"),
    selectionStrategy: resolverSelectionStrategySchema
      .optional()
      .describe(
        "Endpoint selection strategy (default: first); unique requires one match at every unindexed scope level and at the target",
      ),
  };
  return z
    .union([selector.options[0].extend(scope), selector.options[1].extend(scope)])
    .describe(`${label} element`);
};

const swipeOnLookForSelector = createElementIdTextSelectorSchema({
  elementId: "ID of the element to look for",
  text: "Text to look for",
});
const swipeOnLookForScope = {
  container: nestedElementContainerSchema
    .optional()
    .describe(
      "Additional nested scope within the swipe container; re-resolved on every observation",
    ),
  selectionStrategy: resolverSelectionStrategySchema
    .optional()
    .describe(
      "Target selection strategy (default: first); unique requires one target and every unindexed scope",
    ),
};
const swipeOnLookForSchema = z.union([
  swipeOnLookForSelector.options[0].extend(swipeOnLookForScope),
  swipeOnLookForSelector.options[1].extend(swipeOnLookForScope),
]);

// #6613: dragAndDrop/swipeOn/pinchOn advertised
// `additionalProperties: false` but were not `.strict()`, so an undeclared
// caller argument was silently dropped instead of rejected. Same treatment as
// tapOn/tapAny (#6154).
export const dragAndDropSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        display: z.string().optional().describe("Target panel key, role, or active"),
        source: dragAndDropSelectorSchema("Source"),
        target: dragAndDropSelectorSchema("Target"),
        pressDurationMs: z
          .number()
          .min(PRESS_DURATION_MIN_MS)
          .max(PRESS_DURATION_MAX_MS)
          .optional()
          .describe(
            `Press duration ms (min: ${PRESS_DURATION_MIN_MS}, max: ${PRESS_DURATION_MAX_MS}, default: 600)`,
          ),
        dragDurationMs: z
          .number()
          .min(DRAG_DURATION_MIN_MS)
          .max(DRAG_DURATION_MAX_MS)
          .optional()
          .describe(
            `Drag duration ms (min: ${DRAG_DURATION_MIN_MS}, max: ${DRAG_DURATION_MAX_MS}, default: 300)`,
          ),
        holdDurationMs: z
          .number()
          .min(HOLD_DURATION_MIN_MS)
          .max(HOLD_DURATION_MAX_MS)
          .optional()
          .describe(
            `Hold duration ms (min: ${HOLD_DURATION_MIN_MS}, max: ${HOLD_DURATION_MAX_MS}, default: 100)`,
          ),
        // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
        // not required — a device handle from getAndroid/getApple is sufficient on
        // its own.
        platform: platformSchema.optional(),
        ...responseShapeControlFields,
      })
      .strict(),
  ),
  (js) => compactExclusiveSelectorProperties(js, ["source", "target"]),
);

export const swipeOnSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        display: z.string().optional().describe("Target panel key, role, or active"),
        includeSystemInsets: z
          .boolean()
          .optional()
          .describe(
            "Use full screen including status/nav bars; with display, requires the selected Android panel's own available insets",
          ),
        container: nestedElementContainerSchema
          .optional()
          .describe(
            "Nested swipe container scope; outermost resolves first, with per-level index and selectionStrategy",
          ),
        autoTarget: z
          .boolean()
          .optional()
          .describe(
            "Auto-target scrollable containers (default: true; with Android display, opt-in)",
          ),
        direction: z.enum(["up", "down", "left", "right"]).describe("Swipe/scroll direction"),
        gestureType: z
          .enum(["swipeFingerTowardsDirection", "scrollTowardsDirection"])
          .optional()
          .describe(
            "Finger direction or content scroll direction; default: swipeFingerTowardsDirection",
          ),
        lookFor: swipeOnLookForSchema
          .optional()
          .describe(
            "Element to find by scrolling; with display, observes and swipes only the selected Android panel",
          ),
        boomerang: z.boolean().optional().describe("Return to start position after swipe apex"),
        apexPause: z
          .number()
          .finite()
          .min(SWIPE_APEX_PAUSE_MIN_MS)
          .max(SWIPE_APEX_PAUSE_MAX_MS)
          .optional()
          .describe(
            `Pause duration at swipe apex in ms (${SWIPE_APEX_PAUSE_MIN_MS}-${SWIPE_APEX_PAUSE_MAX_MS}; default: 100)`,
          ),
        returnSpeed: z
          .number()
          .finite()
          .gt(SWIPE_RETURN_SPEED_EXCLUSIVE_MIN)
          .max(SWIPE_RETURN_SPEED_MAX)
          .optional()
          .describe(
            `Speed multiplier for return swipe (> ${SWIPE_RETURN_SPEED_EXCLUSIVE_MIN}, <= ${SWIPE_RETURN_SPEED_MAX}; default: 1); return duration <= ${SWIPE_RETURN_DURATION_MAX_MS} ms and total boomerang <= ${SWIPE_BOOMERANG_MAX_MS} ms`,
          ),
        speed: z.enum(["slow", "normal", "fast"]).optional().describe("Swipe speed preset"),
        // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
        // not required — a device handle from getAndroid/getApple is sufficient on
        // its own.
        platform: platformSchema.optional(),
        ...responseShapeControlFields,
      })
      .strict(),
  ).superRefine((options, context) => {
    const error = validateSwipeTimingOptions(options);
    if (error) {
      context.addIssue({
        code: "custom",
        message: error,
        path: [error.startsWith("apexPause") ? "apexPause" : "returnSpeed"],
      });
    }
  }),
  (js) => compactExclusiveSelectorProperties(js, ["container", "lookFor"]),
);

export const pinchOnSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        display: z.string().optional().describe("Target panel key, role, or active"),
        direction: z.enum(["in", "out"]).describe("Pinch direction"),
        distanceStart: z
          .number()
          .gt(PINCH_DISTANCE_EXCLUSIVE_MIN)
          .optional()
          .describe(
            `Initial finger distance (> ${PINCH_DISTANCE_EXCLUSIVE_MIN}) defaults to 60% of the target's smaller dimension for direction 'in' and 20% for 'out'; clamped to 10%-90% with a 10 px floor capped by the 90% ceiling (below 10 px for targets under 11.1 px).`,
          ),
        distanceEnd: z
          .number()
          .gt(PINCH_DISTANCE_EXCLUSIVE_MIN)
          .optional()
          .describe(
            `Final finger distance (> ${PINCH_DISTANCE_EXCLUSIVE_MIN}) defaults to 20% of the target's smaller dimension for direction 'in' and 60% for 'out'; clamped to 10%-90% with a 10 px floor capped by the 90% ceiling (below 10 px for targets under 11.1 px).`,
          ),
        scale: z
          .number()
          .gt(PINCH_SCALE_EXCLUSIVE_MIN)
          .optional()
          .describe(`Scale factor (> ${PINCH_SCALE_EXCLUSIVE_MIN}; overrides distances)`),
        duration: z
          .number()
          .int()
          .min(PINCH_DURATION_MIN_MS)
          .max(PINCH_DURATION_MAX_MS)
          .optional()
          .describe(
            `Gesture duration (integer ${PINCH_DURATION_MIN_MS}-${PINCH_DURATION_MAX_MS} ms, default: 300)`,
          ),
        rotationDegrees: z
          .number()
          .optional()
          .describe(
            "Degrees the two-finger axis rotates during the pinch (default: 0). The axis starts horizontal and ends rotated by this amount — a combined pinch+rotate, not a pinch along a fixed rotated axis. Same convention on Android and iOS.",
          ),
        includeSystemInsets: z
          .boolean()
          .optional()
          .describe("Use full screen including status/nav bars"),
        container: nestedElementContainerSchema
          .optional()
          .describe(
            "Nested container scope; selectionStrategy (first/random/unique) is supported only inside each container level, not at the top level",
          ),
        autoTarget: z.boolean().optional().describe("Auto-target pinchable containers"),
        // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
        // not required — a device handle from getAndroid/getApple is sufficient on
        // its own.
        platform: platformSchema.optional(),
        ...responseShapeControlFields,
      })
      .strict(),
  ),
  (js) => compactExclusiveSelectorProperties(js, ["container"]),
);

export const selectAllTextSchema = addDeviceTargetingToSchema(
  z
    .object({
      // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
      // not required — a device handle from getAndroid/getApple is sufficient on
      // its own.
      platform: platformSchema.optional(),
      ...responseShapeControlFields,
    })
    .strict(),
);

export const pressButtonSchema = addDeviceTargetingToSchema(
  z
    .object({
      button: z.enum(["home", "back", "menu", "power", "volume_up", "volume_down", "recent"]),
      // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
      // not required — a device handle from getAndroid/getApple is sufficient on
      // its own.
      platform: platformSchema.optional(),
      ...responseShapeControlFields,
    })
    .strict(),
);

const systemTrayNotificationSchema = z.object({
  title: z.string().optional().describe("Notification title to match"),
  body: z.string().optional().describe("Notification body to match"),
  appId: z.string().optional().describe("App package ID to match"),
  tapActionLabel: z.string().optional().describe("Action button label to tap (for 'tap' action)"),
});

const systemTraySchemaBase = z
  .object({
    action: z
      .enum(["open", "close", "list", "find", "tap", "dismiss", "clearAll"])
      .describe("open/close/list/find/tap/dismiss/clearAll notification"),
    notification: systemTrayNotificationSchema
      .optional()
      .describe(
        "Notification criteria to match; list requires appId and scans up to three swipes on Android",
      ),
    awaitTimeout: z
      .number()
      .optional()
      .describe("Timeout in ms to wait for notification (default: 5000)"),
    // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
    // not required — a device handle from getAndroid/getApple is sufficient on
    // its own.
    platform: platformSchema.optional(),
    ...responseShapeControlFields,
  })
  .strict();

export const systemTraySchema = withJsonSchemaOverride(
  withAppIdAliases(
    addDeviceTargetingToSchema(systemTraySchemaBase).superRefine((value, ctx) => {
      const notification = value.notification ?? {};

      if (value.action === "open" || value.action === "close") {
        return;
      }

      const hasCriteria = notification.title || notification.body || notification.appId;
      if (!hasCriteria) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${value.action} requires at least one criterion under 'notification': notification: { title | body | appId }`,
        });
      }

      if ((value.action === "clearAll" || value.action === "list") && !notification.appId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${value.action} action requires notification.appId`,
        });
      }

      if (notification.tapActionLabel && value.action !== "tap") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "notification.tapActionLabel is only valid for tap action",
        });
      }
    }),
  ),
  (jsonSchema) => {
    const notificationSchema = (jsonSchema.properties as Record<string, Record<string, unknown>>)
      .notification;
    const notificationProperties = notificationSchema.properties as Record<string, unknown>;
    Object.assign(
      notificationProperties,
      Object.fromEntries(appIdFieldAliases.map((alias) => [alias, { type: "string" }])),
    );
  },
);

export const stopAppSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z.object({
      appId: z.string(),
      // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
      // not required — a device handle from getAndroid/getApple is sufficient on
      // its own.
      platform: platformSchema.optional(),
    }),
  ),
);

export const clearStateSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z.object({
      appId: z.string(),
      clearKeychain: z.boolean().optional().describe("Clear iOS keychain"),
      // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
      // not required — a device handle from getAndroid/getApple is sufficient on
      // its own.
      platform: platformSchema.optional(),
    }),
  ),
);

// A selector focuses the target field before typing (issue #5872 AC3), so a
// form field no longer costs a mandatory tapOn-then-sendKeys pair. Kept to the
// selector variants that identify an input; semantic-link activation is a tapOn
// concern, not a field to type into.
const sendKeysSelectorSchema = z
  .union([
    z
      .object({ elementId: z.string().min(1).describe("Resource ID, e.g. com.app:id/field") })
      .strict(),
    z.object({ testTag: z.string().min(1).describe("Android accessibility test tag") }).strict(),
    z
      .object({
        text: z.string().min(1).describe("Text, content-desc, or placeholder of the field"),
      })
      .strict(),
    z
      .object({
        textAny: z
          .array(z.string().min(1))
          .min(1)
          .describe("Ordered text variants; first visible match wins"),
      })
      .strict(),
  ])
  .describe(
    "Field to focus before typing: elementId, Android testTag, text, or ordered text variants",
  );

const sendKeysKeyValues = [...SUPPORTED_INPUT_KEYS, ...SEND_KEYS_SEMANTIC_KEYS] as const;

const sendKeysTypeCommandSchema = withJsonSchemaOverride(
  z
    .object({
      action: z.literal("type"),
      text: z.string().min(1).describe("Text to insert or replace; never echoed in the result"),
      operation: z
        .enum(SEND_KEYS_OPERATIONS)
        .default("insert")
        .describe("Insert at the current selection (default) or replace the focused field"),
      mode: z
        .enum(SEND_KEYS_TYPING_MODES)
        .default("auto")
        .describe(
          "Android delivery mode. Use ime, a11y, or auto for Unicode and emoji. auto uses the AutoMobile IME when supported, otherwise eventAll for insert or a11y for replace. ime commits complete graphemes; eventAll inserts whole graphemes and uses key events only for single printable ASCII characters. eventLast can split keycaps or decomposed letters. eventOnly and imeKeyEvents are ASCII-only; imeKeyEvents requires a compatible CtrlProxy APK and does not verify resulting editor text. iOS uses xcuiTypeText for every requested mode",
        ),
      keyboardProfile: z
        .enum(KEYBOARD_PROFILE_IDS)
        .optional()
        .describe("Android keyboard behavior profile for this IME type call; restored afterward"),
    })
    .strict()
    .superRefine((command, context) => {
      if (command.keyboardProfile && command.mode !== "auto" && command.mode !== "ime") {
        context.addIssue({
          code: "custom",
          path: ["mode"],
          message: "keyboardProfile requires mode: ime or auto",
        });
      }
    }),
  (jsonSchema) => {
    jsonSchema.dependentSchemas = {
      ...(jsonSchema.dependentSchemas as Record<string, unknown> | undefined),
      keyboardProfile: {
        properties: { mode: { enum: ["auto", "ime"] } },
      },
    };
  },
);

const sendKeysCommandSchema = withCanonicalDiscriminatedUnionJsonSchema(
  z.discriminatedUnion("action", [
    sendKeysTypeCommandSchema,
    z
      .object({
        action: z.literal("key"),
        key: z
          .enum(sendKeysKeyValues)
          .describe(
            "Raw key or semantic IME key. Semantic next/previous/done/search/send/go ignore modifiers",
          ),
        modifiers: z
          .array(z.enum(INPUT_KEY_MODIFIERS))
          .max(SEND_KEYS_MAX_MODIFIERS)
          .optional()
          .describe(
            `Raw-key modifier chord: shift, ctrl, alt, or meta (maximum ${SEND_KEYS_MAX_MODIFIERS} entries, including duplicates)`,
          ),
      })
      .strict(),
    z
      .object({
        action: z.literal("clear"),
        mode: z
          .enum(SEND_KEYS_CLEAR_MODES)
          .optional()
          .describe(
            "Android clear delivery. auto (default) and ime clear through the AutoMobile IME, or key-event deletes on an older control-proxy APK, so rich-text editors keep live formatting. a11y uses the accessibility set-text clear. iOS ignores this",
          ),
      })
      .strict(),
  ]),
);

export const sendKeysSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        display: z.string().optional().describe("Target panel key, role, or active"),
        selector: sendKeysSelectorSchema
          .optional()
          .describe(
            "Field to focus once before executing the ordered command sequence; supports nested container scope and unique selection",
          ),
        container: nestedElementContainerSchema
          .optional()
          .describe(
            "Nested container scope; outermost resolves first, each level searches strict descendants. Per-level index is zero-based. Requires a selector naming the field to focus.",
          ),
        selectionStrategy: resolverSelectionStrategySchema
          .optional()
          .describe(
            "Selection strategy: first (default), random, or unique. Unique requires exactly one match at every unindexed scope and target. Requires a selector naming the field to focus.",
          ),
        commands: z
          .array(sendKeysCommandSchema)
          .min(1)
          .max(SEND_KEYS_MAX_COMMANDS)
          .describe(
            `One to ${SEND_KEYS_MAX_COMMANDS} commands executed serially; execution stops on the first failure`,
          ),
        // #5870: Device or session targeting resolves the platform.
        platform: platformSchema.optional(),
        ...responseShapeControlFields,
      })
      .strict(),
  ).superRefine((value, ctx) => {
    if (value.selector !== undefined) {
      return;
    }
    for (const field of ["container", "selectionStrategy"] as const) {
      if (value[field] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} requires a selector naming the field to focus`,
          path: [field],
        });
      }
    }
  }),
  (jsonSchema) => {
    jsonSchema.dependentRequired = { container: ["selector"], selectionStrategy: ["selector"] };
  },
);

export interface SendKeysRunnerCommandSource {
  getSupportedCommands(): Promise<string[] | null>;
}

export type SendKeysRunnerCommandSourceFactory = (
  device: BootedDevice,
) => SendKeysRunnerCommandSource;

const defaultSendKeysRunnerCommandSourceFactory: SendKeysRunnerCommandSourceFactory = (device) =>
  device.platform === "android"
    ? AndroidCtrlProxyClient.getInstance(device)
    : IOSCtrlProxyClient.getInstance(device);

export async function assertSendKeysRunnerCompatible(
  device: BootedDevice,
  sourceFactory: SendKeysRunnerCommandSourceFactory = defaultSendKeysRunnerCommandSourceFactory,
): Promise<void> {
  const requiredCommand =
    device.platform === "android" ? "request_insert_text" : "request_press_key";
  const supportedCommands = await sourceFactory(device).getSupportedCommands();
  if (supportedCommands?.includes(requiredCommand)) {
    return;
  }
  throw new ActionableError(
    `${device.platform === "android" ? "Android CtrlProxy APK" : "iOS CtrlProxy runner"} ` +
      `does not support sendKeys (${requiredCommand} is unavailable). Rebuild and redeploy the ` +
      `CtrlProxy from this source checkout.`,
  );
}

export const wakeAndUnlockSchema = addDeviceTargetingToSchema(
  z
    .object({
      pin: z
        .string()
        .optional()
        .describe(
          "Credential to unlock a secure Android device. Optional; logically required to unlock a secure lock unless a pin was already remembered this session. Ignored on iOS.",
        ),
      // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
      // not required — a device handle from getAndroid/getApple is sufficient on
      // its own.
      platform: platformSchema.optional(),
    })
    .strict(),
);

// openLink gains an optional integrated waitFor (issue #3490 §5): after opening
// the URL, poll for the predicate — reusing observe's waitFor/settled schema and
// semantics — so the open→settle→observe→verify workaround collapses into one call.
export const openLinkSchema = withAppIdAliases(
  withJsonSchemaOverride(
    addDeviceTargetingToSchema(
      z
        .object({
          url: z.string().describe("URL to open"),
          acceptOpenAlert: z
            .boolean()
            .optional()
            .describe(
              "On iOS, automatically tap Open when a system 'Open in <app>?' alert appears",
            ),
          chooserAppPackage: z
            .string()
            .min(1)
            .optional()
            .describe(
              "On Android, select this exact package if opening the URL displays an intent chooser",
            ),
          // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
          // not required — a device handle from getAndroid/getApple is sufficient on
          // its own.
          platform: platformSchema.optional(),
          waitFor: waitForSchema
            .optional()
            .describe("After opening, wait for this predicate before returning the observation"),
          settled: settledSchema
            .optional()
            .describe(
              "After waitFor matches, wait for a quiet hierarchy period (requires waitFor)",
            ),
          ...responseShapeControlFields,
        })
        .strict(),
    ).superRefine(refineWaitForArgs),
    overrideWaitForJsonSchema,
  ),
);

/** Outcome of a post-open waitFor poll, as produced by {@link waitForObservation}. */
export type OpenLinkWaitOutcome = WaitForObservationOutcome;

function confirmsPostTapPackage(
  selection: Awaited<ReturnType<HandleIntentChooser["execute"]>>,
  packageName: string,
): boolean {
  const observed = selection.observation?.viewHierarchy;
  return (
    selection.tappedAt !== undefined &&
    observed?.updatedAt !== undefined &&
    observed.updatedAt >= selection.tappedAt &&
    observed.packageName === packageName
  );
}

/**
 * Selects the requested Android link handler and fails unless the chooser
 * reports success and, when needed, a fresh hierarchy confirms the package.
 */
export async function selectAndroidOpenLinkChooser(
  device: BootedDevice,
  packageName: string,
  opened: OpenURLResult,
  url?: string,
  chooser: Pick<HandleIntentChooser, "execute"> = new HandleIntentChooser(device),
  signal?: AbortSignal,
): Promise<OpenURLResult> {
  if (device.platform !== "android") {
    throw new ActionableError("chooserAppPackage is supported only on Android.");
  }
  if (!opened.success) {
    return opened;
  }
  throwIfAborted(signal);
  const selection = await chooser.execute("custom", packageName, url, signal);
  throwIfAborted(signal);
  if (!selection.detected || !selection.success) {
    return {
      ...opened,
      success: false,
      error: selection.error ?? `Intent chooser for ${packageName} was not found`,
      observation: selection.observation ?? opened.observation,
    };
  }
  if (selection.packageVerified === false && !confirmsPostTapPackage(selection, packageName)) {
    return {
      ...opened,
      success: false,
      error: `Unverified chooser selection for ${packageName}: the post-tap hierarchy is stale or does not confirm the foreground package.`,
      observation: selection.observation ?? opened.observation,
    };
  }
  return { ...opened, observation: selection.observation ?? opened.observation };
}

/**
 * Build the openLink response payload. Without a wait it is the plain open
 * result; with a wait (issue #3490 §5) the awaited observation replaces the
 * open-time snapshot and the await metadata is surfaced to the caller.
 */
export const buildOpenLinkPayload = (
  url: string,
  openResult: OpenURLResult,
  waitOutcome: OpenLinkWaitOutcome | null,
) => {
  const message = openResult.success
    ? `Opened link ${url}`
    : `Failed to open ${url}: ${openResult.error || "unknown error"}`;
  if (!waitOutcome) {
    return {
      message,
      ...openResult,
      observation: openResult.observation,
    };
  }
  return {
    message,
    ...openResult,
    observation: waitOutcome.observation,
    awaitedElement: waitOutcome.awaitedElement,
    awaitDuration: waitOutcome.awaitDuration,
    awaitTimeout: waitOutcome.awaitTimeout,
    matched: waitOutcome.matched,
    settled: waitOutcome.settled,
    timedOut: waitOutcome.timedOut,
    timeoutReason: waitOutcome.timeoutReason,
    polls: waitOutcome.polls,
    waitMs: waitOutcome.waitMs,
    matchedElement: waitOutcome.matchedElement,
    candidates: waitOutcome.candidates,
  };
};

export const recentAppsSchema = addDeviceTargetingToSchema(
  z
    .object({
      // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
      // not required — a device handle from getAndroid/getApple is sufficient on
      // its own.
      platform: platformSchema.optional(),
      ...responseShapeControlFields,
    })
    .strict(),
);

export const homeScreenSchema = addDeviceTargetingToSchema(
  z
    .object({
      // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
      // not required — a device handle from getAndroid/getApple is sufficient on
      // its own.
      platform: platformSchema.optional(),
      ...responseShapeControlFields,
    })
    .strict(),
);

export const rotateSchema = addDeviceTargetingToSchema(
  z
    .object({
      orientation: z.enum(["portrait", "landscape"]),
      lockOrientation: z
        .boolean()
        .optional()
        .describe(
          "Android only. In a device session, omission or true holds the orientation until false or session release; an unreadable initial auto-rotate setting is left unchanged by omission. Direct calls restore auto-rotate at the end unless true. false enables automatic rotation, even if originally locked; in a session it also restores original user_rotation. orientationLockState reports the confirmed lock.",
        ),
      display: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Android logical display ID (default 0). Non-default displays use the per-display window-manager rotation command and do not change or restore global rotation settings; iOS supports only the default display.",
        ),
      // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
      // not required — a device handle from getAndroid/getApple is sufficient on
      // its own.
      platform: platformSchema.optional(),
      ...responseShapeControlFields,
    })
    .strict(),
);

export const setPostureSchema = addDeviceTargetingToSchema(
  z
    .object({
      posture: z
        .enum(["closed", "half_opened", "opened", "rear_display", "flipped", "tent"])
        .optional(),
      hingeAngle: z
        .number()
        .finite()
        .min(HINGE_ANGLE_MIN_DEGREES)
        .max(HINGE_ANGLE_MAX_DEGREES)
        .optional()
        .describe(
          "Best effort hinge angle in degrees, 0-180 inclusive; specify exactly one of posture or hingeAngle. Emulator/simulator only; no displayPreset.",
        ),
      displayPreset: z.enum(["phone", "unfolded", "tablet"]).optional(),
      platform: platformSchema.optional(),
    })
    .strict(),
).superRefine((args, context) => {
  if ((args.posture !== undefined) === (args.hingeAngle !== undefined)) {
    context.addIssue({
      code: "custom",
      message: "Specify exactly one of posture or hingeAngle.",
      path: ["posture"],
    });
  }
  if (args.hingeAngle !== undefined && args.displayPreset !== undefined) {
    context.addIssue({
      code: "custom",
      message: "displayPreset requires posture and cannot be combined with hingeAngle.",
      path: ["displayPreset"],
    });
  }
});

const clipboardTextRequiredMessage = "text is required when action is copy";
const optionalClipboardTextSchema = z
  .string()
  .min(1)
  .optional()
  .describe("Text to copy (required for 'copy' action)");
const clipboardPlatformSchema = {
  // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
  // not required — a device handle from getAndroid/getApple is sufficient on
  // its own.
  platform: platformSchema.optional(),
};

export const clipboardSchema = z.discriminatedUnion("action", [
  addDeviceTargetingToSchema(
    z
      .object({
        action: z.literal("copy").describe("Clipboard action"),
        text: z
          .string({ error: clipboardTextRequiredMessage })
          .min(1, clipboardTextRequiredMessage)
          .describe("Text to copy (required for 'copy' action)"),
        ...clipboardPlatformSchema,
      })
      .strict(),
  ),
  addDeviceTargetingToSchema(
    z
      .object({
        action: z.literal("paste").describe("Clipboard action"),
        text: optionalClipboardTextSchema,
        ...clipboardPlatformSchema,
      })
      .strict(),
  ),
  addDeviceTargetingToSchema(
    z
      .object({
        action: z.literal("clear").describe("Clipboard action"),
        text: optionalClipboardTextSchema,
        ...clipboardPlatformSchema,
      })
      .strict(),
  ),
  addDeviceTargetingToSchema(
    z
      .object({
        action: z.literal("get").describe("Clipboard action"),
        text: optionalClipboardTextSchema,
        ...clipboardPlatformSchema,
      })
      .strict(),
  ),
]);

export function formatClipboardMessage(result: ClipboardResult): string {
  if (!result.success) {
    return `Failed to execute clipboard ${result.action}: ${result.error ?? "unknown error"}`;
  }

  switch (result.action) {
    case "copy":
      return "Copied text to clipboard";
    case "paste":
      return "Pasted clipboard content into focused field";
    case "clear":
      return "Cleared clipboard";
    case "get":
      return result.text
        ? `Retrieved clipboard content: "${result.text.substring(0, 50)}${result.text.length > 50 ? "..." : ""}"`
        : "Retrieved empty clipboard";
  }
}

export function formatRecentAppsMessage(result: { success?: boolean; error?: string }): string {
  if (result.success === false) {
    return `Failed to open recent apps: ${result.error ?? "unknown error"}`;
  }
  return "Opened recent apps";
}

export function formatSwipeOnMessage(
  result: Pick<SwipeOnToolPayload, "success" | "error" | "found" | "scrollIterations">,
  direction: string,
): string {
  if (!result.success) {
    // `||` not `??`: an empty-string error (`error: ""`) must still yield the
    // non-empty fallback, otherwise the tool returns a blank message (#4183 P4).
    return result.error || `Swipe ${direction} failed`;
  }
  return result.found
    ? `Swiped ${direction} and found element after ${result.scrollIterations ?? 1} swipe(s)`
    : `Swiped ${direction}`;
}

// Injection seam for the swipeOn handler (mirrors the pinchOn/tapOn factory
// seams). Lets a unit test exercise the registered handler wiring with a fake
// SwipeOn whose execute() returns a failure, so a revert of the `isError`
// gating below is caught by a test — not just the formatter (#6163).
export type SwipeOnLike = Pick<SwipeOn, "execute">;

type SendKeysLike = Pick<SendKeys, "execute">;
let sendKeysFactory: (device: BootedDevice) => SendKeysLike = (device) => new SendKeys(device);

export function setSendKeysFactory(factory: (device: BootedDevice) => SendKeysLike): void {
  sendKeysFactory = factory;
}

export function resetSendKeysFactory(): void {
  sendKeysFactory = (device) => new SendKeys(device);
}

let swipeOnFactory: (device: BootedDevice) => SwipeOnLike = (device) => new SwipeOn(device);

export function setSwipeOnFactory(factory: (device: BootedDevice) => SwipeOnLike): void {
  swipeOnFactory = factory;
}

export function resetSwipeOnFactory(): void {
  swipeOnFactory = (device) => new SwipeOn(device);
}

export async function swipeOnHandler(
  device: BootedDevice,
  args: SwipeOnArgs,
  progress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<StructuredToolResponse<SwipeOnToolPayload> & { isError?: true }> {
  RecompositionTracker.getInstance().recordInteraction(device.deviceId);
  const swipeOn = swipeOnFactory(device);
  const resolvedDirection = resolveSwipeDirection({
    direction: args.direction,
    gestureType: args.gestureType,
  });
  const result = await swipeOn.execute(
    {
      display: args.display,
      container: args.container,
      autoTarget: args.display === undefined ? (args.autoTarget ?? true) : args.autoTarget,
      // SwipeOnArgs requires a direction, and the resolver's inversion map covers all four values.
      direction: resolvedDirection.direction!,
      lookFor: args.lookFor,
      speed: args.speed,
      includeSystemInsets:
        args.display === undefined ? (args.includeSystemInsets ?? false) : args.includeSystemInsets,
      boomerang: args.boomerang,
      apexPause: args.apexPause,
      returnSpeed: args.returnSpeed,
    },
    progress,
    signal,
  );

  const response = createStructuredToolResponse({
    message: formatSwipeOnMessage(result, args.direction),
    observation: result.observation,
    ...result,
  });
  // formatSwipeOnMessage already gates the message on `result.success`; the MCP
  // envelope must agree, exactly as tapOn does (#6152, #5902), so a
  // conforming client can't mistake a failed swipe for a completed one (#6163).
  return result.success ? response : { ...response, isError: true };
}

export function formatPinchOnMessage(
  result: Pick<PinchOnResult, "success" | "error">,
  direction: string,
): string {
  if (!result.success) {
    // `||` not `??`: an empty-string error (`error: ""`) must still yield the
    // non-empty fallback, mirroring formatSwipeOnMessage (#4183 P4). Without this
    // a validation failure (e.g. scale:0) reported a success-shaped message (#6056).
    return result.error || `Pinch ${direction} failed`;
  }
  return `Pinched ${direction}`;
}

// Injection seam for the pinchOn handler (mirrors the systemTray factory seam in
// this file). Lets a unit test exercise the registered handler wiring with a fake
// PinchOn whose execute() returns a failure, so a revert of the handler message
// wiring is caught by a test — not just the formatter (#6056).
export type PinchOnLike = Pick<PinchOn, "execute">;

let pinchOnFactory: (device: BootedDevice) => PinchOnLike = (device) => new PinchOn(device);

export function setPinchOnFactory(factory: (device: BootedDevice) => PinchOnLike): void {
  pinchOnFactory = factory;
}

export function resetPinchOnFactory(): void {
  pinchOnFactory = (device) => new PinchOn(device);
}

export async function pinchOnHandler(
  device: BootedDevice,
  args: PinchOnArgs,
  progress?: ProgressCallback,
  signal?: AbortSignal,
) {
  RecompositionTracker.getInstance().recordInteraction(device.deviceId);
  const pinchOn = pinchOnFactory(device);
  const result = await pinchOn.execute(
    {
      display: args.display,
      direction: args.direction,
      distanceStart: args.distanceStart,
      distanceEnd: args.distanceEnd,
      scale: args.scale,
      duration: args.duration,
      rotationDegrees: args.rotationDegrees,
      includeSystemInsets: args.includeSystemInsets,
      container: args.container,
      autoTarget: args.autoTarget,
    },
    progress,
    signal,
  );

  const response = createJSONToolResponse({
    message: formatPinchOnMessage(result, args.direction),
    observation: result.observation,
    ...result,
  });
  // formatPinchOnMessage already gates the message on `result.success`; the MCP
  // envelope must agree, exactly as tapOn does (#6152, #5902), so a
  // conforming client can't mistake a failed pinch for a completed one (#6163).
  return result.success ? response : { ...response, isError: true };
}

/**
 * Build the tapOn success message so it says *what* it matched, not just
 * "Tapped on element" (#5868). A correct tap and a wrong tap were byte-identical;
 * now the message carries the resolved match identity and match count (so an
 * ambiguous selector is distinguishable from a precise one) alongside the
 * existing hierarchy-changed search summary. The structured `selectedElement`
 * (resourceId/text/bounds/totalMatches) still rides on the result for clients
 * that read the payload.
 */
export function buildTapOnResultMessage(
  selectedElement: TapOnSelectedElement | undefined,
  searchSummary: string | undefined,
  activatedSubtext?: { text: string; occurrence: number },
): string {
  const details = buildTapOnResultDetails(selectedElement, searchSummary, activatedSubtext);
  return details.length > 0 ? `Tapped on element (${details.join("; ")})` : "Tapped on element";
}

function buildTapOnResultDetails(
  selectedElement: TapOnSelectedElement | undefined,
  searchSummary: string | undefined,
  activatedSubtext?: { text: string; occurrence: number },
): string[] {
  const details: string[] = [];
  if (selectedElement) {
    // Include every available identity field, not just the resource id: Android
    // list rows commonly reuse an id such as `...:id/title`, so the id alone can't
    // tell "Internet" from "Calendar" — the text can.
    const identity: string[] = [];
    if (selectedElement.resourceId) {
      identity.push(`id=${selectedElement.resourceId}`);
    }
    if (selectedElement.testTag) {
      identity.push(`testTag=${selectedElement.testTag}`);
    }
    if (selectedElement.text) {
      identity.push(`text=${JSON.stringify(selectedElement.text)}`);
    }
    details.push(`matched ${identity.length > 0 ? identity.join(" ") : "element"}`);
    const count = selectedElement.totalMatches;
    // For an ambiguous selector, name which occurrence was tapped so index 0 vs 2
    // (or a random pick) among identical rows is distinguishable.
    const index = count > 1 ? ` (index ${selectedElement.indexInMatches})` : "";
    details.push(`${count} ${count === 1 ? "match" : "matches"}${index}`);
  }
  // Append the activated semantic link whenever present, additively: an
  // owner-scoped subtext tap resolves BOTH an owner (selectedElement) and the
  // activated link, and the accessibilityLink selector resolves only the link —
  // either way, naming the link keeps taps on different links from being
  // byte-identical.
  if (activatedSubtext) {
    const occurrence =
      activatedSubtext.occurrence > 0 ? ` [occurrence ${activatedSubtext.occurrence}]` : "";
    details.push(`activated link ${JSON.stringify(activatedSubtext.text)}${occurrence}`);
  }
  if (searchSummary) {
    details.push(searchSummary);
  }
  return details;
}

// Injection seam for the tapOn handler (mirrors the pinchOn factory seam above).
// Lets a unit test exercise the registered handler wiring with a fake
// TapOnElement whose execute() returns a selector miss, so a revert of the
// failure gating below is caught by a test — not just the formatter (#6152).
export type TapOnElementLike = Pick<TapOnElement, "execute">;

let tapOnElementFactory: (device: BootedDevice) => TapOnElementLike = (device) =>
  new TapOnElement(device);

export function setTapOnElementFactory(factory: (device: BootedDevice) => TapOnElementLike): void {
  tapOnElementFactory = factory;
}

export function resetTapOnElementFactory(): void {
  tapOnElementFactory = (device) => new TapOnElement(device);
}

export type TapAtElementLike = Pick<TapAtCoordinate, "execute">;

let tapAtElementFactory: (device: BootedDevice) => TapAtElementLike = (device) =>
  new TapAtCoordinate(device);

export function setTapAtElementFactory(factory: (device: BootedDevice) => TapAtElementLike): void {
  tapAtElementFactory = factory;
}

export function resetTapAtElementFactory(): void {
  tapAtElementFactory = (device) => new TapAtCoordinate(device);
}

type HitTestObservationReader = Pick<RealObserveScreen, "execute">;
let hitTestObservationFactory: (device: BootedDevice) => HitTestObservationReader = (device) =>
  new RealObserveScreen(device);

export function setHitTestObservationFactory(
  factory: (device: BootedDevice) => HitTestObservationReader,
): void {
  hitTestObservationFactory = factory;
}

export function resetHitTestObservationFactory(): void {
  hitTestObservationFactory = (device) => new RealObserveScreen(device);
}

const VISIBLE_HIERARCHY_TEXT_KEYS = new Set([
  "text",
  "label",
  "content-desc",
  "contentDescription",
]);
const IOS_SYSTEM_DIALOG_CLASSES = new Set([
  "UIAlertController",
  "UIActionSheet",
  "XCUIElementTypeAlert",
  "XCUIElementTypeSheet",
]);
const IOS_OPEN_ALERT_ACCEPT_ATTEMPTS = 8;
const IOS_OPEN_ALERT_RETRY_INTERVAL_MS = 250;
const IOS_OPEN_ALERT_VERIFY_ATTEMPTS = 4;
const IOS_OPEN_ALERT_HIERARCHY_TIMEOUT_MS = 2_000;

function collectVisibleHierarchyText(value: unknown, texts: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectVisibleHierarchyText(item, texts);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (VISIBLE_HIERARCHY_TEXT_KEYS.has(key) && typeof child === "string") {
      texts.push(child.trim());
    } else {
      collectVisibleHierarchyText(child, texts);
    }
  }
}

function nodeAttribute(node: Record<string, unknown>, key: string): unknown {
  return node[key] ?? nodeAttributes(node)[key];
}

function countIosDialogButtons(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + countIosDialogButtons(item), 0);
  }
  if (!value || typeof value !== "object") {
    return 0;
  }
  const node = value as Record<string, unknown>;
  const className = nodeAttribute(node, "className") ?? nodeAttribute(node, "class");
  const role = nodeAttribute(node, "role");
  const ownCount = className === "UIButton" || role === "button" ? 1 : 0;
  return (
    ownCount +
    Object.entries(node).reduce(
      (count, [key, child]) => count + (key === "$" ? 0 : countIosDialogButtons(child)),
      0,
    )
  );
}

function containsIosSystemDialog(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsIosSystemDialog);
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const node = value as Record<string, unknown>;
  const className = nodeAttribute(node, "className") ?? nodeAttribute(node, "class");
  if (
    typeof className === "string" &&
    IOS_SYSTEM_DIALOG_CLASSES.has(className) &&
    countIosDialogButtons(node) >= 2
  ) {
    return true;
  }
  return Object.entries(node).some(([key, child]) => key !== "$" && containsIosSystemDialog(child));
}

function isIosAppOpenAlertHierarchy(
  hierarchy: ObserveResult["viewHierarchy"] | undefined,
): boolean {
  const texts: string[] = [];
  collectVisibleHierarchyText(hierarchy?.hierarchy, texts);
  const hasEnglishOpenLabels =
    texts.some((text) => /^open in .+\?$/i.test(text)) &&
    texts.some((text) => text.toLowerCase() === "open");
  return (
    hasEnglishOpenLabels ||
    (hierarchy?.packageName === "com.apple.springboard" &&
      containsIosSystemDialog(hierarchy.hierarchy))
  );
}

/** True when an iOS observation contains the system custom-URL confirmation. */
export function isIosAppOpenAlert(observation: ObserveResult | undefined): boolean {
  return isIosAppOpenAlertHierarchy(observation?.viewHierarchy);
}

type OpenAlertHierarchyRefresh = () => Promise<ObserveResult["viewHierarchy"] | null>;
type SystemAlertTap = () => Promise<{ success: boolean; error?: string }>;

type OpenAlertResolution =
  | { hierarchy: ObserveResult["viewHierarchy"] }
  | { systemTapped: true }
  | null;

function throwIfOpenAlertAcceptanceAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled");
  }
}

async function refreshOpenAlertHierarchy(
  hierarchy: ObserveResult["viewHierarchy"] | undefined,
  refreshHierarchy: OpenAlertHierarchyRefresh | undefined,
): Promise<ObserveResult["viewHierarchy"] | undefined> {
  return refreshHierarchy ? ((await refreshHierarchy()) ?? hierarchy) : hierarchy;
}

async function tapLiveSystemAlert(tapSystemAlert: SystemAlertTap | undefined): Promise<boolean> {
  return tapSystemAlert ? (await tapSystemAlert()).success : false;
}

async function verifyIosOpenAlertDismissed(
  refreshHierarchy: OpenAlertHierarchyRefresh | undefined,
  tapSystemAlert: SystemAlertTap | undefined,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (!refreshHierarchy) {
    return true;
  }
  for (let attempt = 0; attempt < IOS_OPEN_ALERT_VERIFY_ATTEMPTS; attempt += 1) {
    throwIfOpenAlertAcceptanceAborted(signal);
    const hierarchy = await refreshHierarchy();
    if (!hierarchy) {
      continue;
    }
    if (!isIosAppOpenAlertHierarchy(hierarchy)) {
      return true;
    }
    if (!(await tapLiveSystemAlert(tapSystemAlert))) {
      return false;
    }
  }
  return false;
}

async function resolveIosOpenAlert(
  initialHierarchy: ObserveResult["viewHierarchy"] | undefined,
  refreshHierarchy: OpenAlertHierarchyRefresh | undefined,
  tapSystemAlert: SystemAlertTap | undefined,
  signal: AbortSignal | undefined,
): Promise<OpenAlertResolution> {
  if (isIosAppOpenAlertHierarchy(initialHierarchy) && !tapSystemAlert) {
    return initialHierarchy ? { hierarchy: initialHierarchy } : null;
  }
  if (!refreshHierarchy && !tapSystemAlert) {
    return null;
  }

  let hierarchy = initialHierarchy;
  for (let attempt = 0; attempt < IOS_OPEN_ALERT_ACCEPT_ATTEMPTS; attempt += 1) {
    throwIfOpenAlertAcceptanceAborted(signal);
    hierarchy = await refreshOpenAlertHierarchy(hierarchy, refreshHierarchy);
    if (await tapLiveSystemAlert(tapSystemAlert)) {
      return { systemTapped: true };
    }
    if (isIosAppOpenAlertHierarchy(hierarchy)) {
      return hierarchy ? { hierarchy } : null;
    }
    if (attempt + 1 < IOS_OPEN_ALERT_ACCEPT_ATTEMPTS) {
      await defaultTimer.sleep(IOS_OPEN_ALERT_RETRY_INTERVAL_MS);
    }
  }
  return null;
}

/**
 * Tap the system-owned Open button only when the merged SpringBoard hierarchy
 * proves the custom-URL confirmation is present.
 */
export async function acceptIosAppOpenAlert(
  device: BootedDevice,
  observation: ObserveResult | undefined,
  progress?: ProgressCallback,
  signal?: AbortSignal,
  refreshHierarchy?: OpenAlertHierarchyRefresh,
  tapSystemAlert?: SystemAlertTap,
): Promise<TapOnElementResult | null> {
  if (device.platform !== "ios") {
    return null;
  }

  const resolution = await resolveIosOpenAlert(
    observation?.viewHierarchy,
    refreshHierarchy,
    tapSystemAlert,
    signal,
  );
  if (!resolution) {
    return null;
  }
  if ("systemTapped" in resolution) {
    const result = {
      success: true,
      action: "tap",
      element: { text: "Open", bounds: { left: 0, top: 0, right: 0, bottom: 0 } },
    } as TapOnElementResult;
    if (!(await verifyIosOpenAlertDismissed(refreshHierarchy, tapSystemAlert, signal))) {
      throw new ActionableError("Failed to accept iOS app-open alert: dialog remained visible");
    }
    return result;
  }

  const result = await tapOnElementFactory(device).execute(
    { text: "Open", action: "tap" },
    progress,
    signal,
  );
  if (!result.success) {
    throw new ActionableError(
      `Failed to accept iOS app-open alert: ${result.error || "unknown error"}`,
    );
  }
  if (!(await verifyIosOpenAlertDismissed(refreshHierarchy, tapSystemAlert, signal))) {
    throw new ActionableError("Failed to accept iOS app-open alert: dialog remained visible");
  }
  return result;
}

/**
 * The hierarchy-changed search summary appended to the tapOn message. Emitted
 * when the search polled or observed changes, or when `searchUntil` was
 * requested and the observation is confirmed fresh.
 */
function buildTapOnSearchSummary(
  result: Pick<TapOnElementResult, "searchUntil" | "observation">,
  searchUntilRequested: boolean,
): string | undefined {
  const searchStats = result.searchUntil;
  if (!searchStats) {
    return undefined;
  }
  const freshness = result.observation?.freshness;
  const hasConfirmedFreshObservation =
    typeof freshness?.requestedAfter === "number" &&
    typeof freshness?.actualTimestamp === "number" &&
    freshness.actualTimestamp >= freshness.requestedAfter;
  const shouldIncludeSearchSummary =
    searchStats.requestCount > 0 ||
    searchStats.changeCount > 0 ||
    (searchUntilRequested && hasConfirmedFreshObservation);
  return shouldIncludeSearchSummary
    ? `${searchStats.changeCount} view hierarchy changes over ${searchStats.requestCount} requests within ${searchStats.durationMs}ms`
    : undefined;
}

function buildTapOnSuccessMessage(
  result: TapOnElementResult,
  searchSummary: string | undefined,
  ensureChecked: boolean | undefined,
): string {
  const label = tapOnElementLabel(result);
  if (result.skipped === "already-checked") {
    const state = ensureChecked ? "checked" : "unchecked";
    return `${label} already ${state}, no tap${searchSummary ? ` (${searchSummary})` : ""}`;
  }
  if (ensureChecked !== undefined && !result.error) {
    const beforeState = isTruthyFlag(result.element.checked) ? "checked" : "unchecked";
    const afterState = ensureChecked ? "checked" : "unchecked";
    const details = buildTapOnResultDetails(
      result.selectedElement,
      searchSummary,
      result.activatedSubtext,
    );
    return `${label} was ${beforeState}, tapped, now ${afterState} (verified)${details.length > 0 ? `; ${details.join("; ")}` : ""}`;
  }
  return buildTapOnResultMessage(result.selectedElement, searchSummary, result.activatedSubtext);
}

function tapOnElementLabel(result: TapOnElementResult): string {
  return (
    result.selectedElement?.text ||
    result.selectedElement?.resourceId ||
    result.selectedElement?.testTag ||
    result.element.text ||
    "toggle"
  );
}

export async function tapOnHandler(
  device: BootedDevice,
  args: TapOnArgs,
  progress?: ProgressCallback,
  signal?: AbortSignal,
) {
  RecompositionTracker.getInstance().recordInteraction(device.deviceId);
  const tapOnTextCommand = tapOnElementFactory(device);
  const result = await tapOnTextCommand.execute(
    {
      display: args.display,
      container: args.container,
      text: args.selector.text,
      textAny: args.selector.textAny,
      elementId: args.selector.elementId,
      testTag: args.selector.testTag,
      accessibilityLink: args.selector.accessibilityLink,
      sibling: args.sibling,
      selectionStrategy: args.selectionStrategy,
      index: args.index,
      action: args.action,
      duration: args.duration,
      searchUntil: args.searchUntil,
      preTapStability: args.preTapStability,
      retryIfNoChange: args.retryIfNoChange,
      ensureTap: args.ensureTap,
      ensureChecked: args.ensureChecked,
      subtext: args.subtext,
    },
    progress,
    signal,
    undefined,
    { requestDeadlineMs: resolveTransportDeadlineMs(args) },
  );

  const searchSummary = buildTapOnSearchSummary(result, Boolean(args.searchUntil));

  // A selector miss must not read as a completed tap: gate the message on the
  // outcome and mark the MCP envelope `isError`, exactly as other action tools do since
  // #5902 (#6152). `||` not `??`: an empty-string error must still yield the
  // non-empty fallback (#4183 P4). The failure keeps the search summary so the
  // user still sees how long the selector was looked for before it missed.
  const message = result.success
    ? `${buildTapOnSuccessMessage(result, searchSummary, args.ensureChecked)}${
        result.warnings?.length ? `. Warning: ${result.warnings.join("; ")}` : ""
      }`
    : `Failed to tap: ${result.error || "unknown error"}${searchSummary ? ` (${searchSummary})` : ""}`;
  const payload = { message, observation: result.observation, ...result };
  const response: StructuredToolResponse<typeof payload> & { isError?: true } =
    createStructuredToolResponse(payload);
  return result.success ? response : { ...response, isError: true as const };
}

export async function tapAtHandler(
  device: BootedDevice,
  args: TapAtArgs,
  progress?: ProgressCallback,
  signal?: AbortSignal,
) {
  RecompositionTracker.getInstance().recordInteraction(device.deviceId);
  const result = await tapAtElementFactory(device).execute(
    {
      ...(args.image !== undefined
        ? { image: args.image }
        : { x: args.x, y: args.y, coordinateSpace: args.coordinateSpace }),
      display: args.display,
      snapshotId: args.snapshotId,
      action: args.action,
      durationMs: args.durationMs,
    },
    progress,
    signal,
    args.__tapAtPlanContext ?? args.__tapAtRecordingContext,
  );
  const message = result.success
    ? `${result.action === "longPress" ? "Long pressed" : result.action === "doubleTap" ? "Double tapped" : "Tapped"} at (${result.x}, ${result.y})`
    : `Failed to tap at (${result.x}, ${result.y}): ${result.error || "unknown error"}`;
  const payload = {
    message,
    observation: result.observation,
    ...result,
    deviceId: device.deviceId,
    platform: device.platform,
  };
  const response: StructuredToolResponse<typeof payload> & { isError?: true } =
    createStructuredToolResponse(payload);
  return result.success ? response : { ...response, isError: true as const };
}

export async function hitTestHandler(device: BootedDevice, args: z.infer<typeof hitTestSchema>) {
  const observation = await hitTestObservationFactory(device).execute({
    display: args.display,
    freshness: "cached-ok",
    skipScreenshot: true,
    skipAccessibilityAudit: true,
    skipPerformanceAudit: true,
    skipRecompositionTracking: true,
  });
  if (args.snapshotId) {
    const staleReason = snapshotReferences.staleReason(
      args.snapshotId,
      device.deviceId,
      observation,
    );
    if (staleReason) {
      throw new ActionableError(staleReason);
    }
  }
  const preview = previewHierarchyHitTest(args, observation, device.platform);
  return createStructuredToolResponse({ ...preview, deviceId: device.deviceId });
}

// Injection seam for the tapAny handler (mirrors the tapOn factory seam above).
// Lets a unit test exercise the registered handler wiring with a fake
// TapAnyElement whose execute() returns a failure (#6163).
export type TapAnyElementLike = Pick<TapAnyElement, "execute">;

let tapAnyElementFactory: (device: BootedDevice) => TapAnyElementLike = (device) =>
  new TapAnyElement(device);

export function setTapAnyElementFactory(
  factory: (device: BootedDevice) => TapAnyElementLike,
): void {
  tapAnyElementFactory = factory;
}

export function resetTapAnyElementFactory(): void {
  tapAnyElementFactory = (device) => new TapAnyElement(device);
}

function buildTapAnySearchSummary(
  result: Pick<TapOnElementResult, "searchUntil">,
): string | undefined {
  const searchStats = result.searchUntil;
  const shouldIncludeSearchSummary =
    Boolean(searchStats) && (searchStats!.requestCount > 0 || searchStats!.changeCount > 0);
  return shouldIncludeSearchSummary && searchStats
    ? `${searchStats.changeCount} view hierarchy changes over ${searchStats.requestCount} requests within ${searchStats.durationMs}ms`
    : undefined;
}

export async function tapAnyHandler(
  device: BootedDevice,
  args: TapAnyArgs,
  progress?: ProgressCallback,
  signal?: AbortSignal,
) {
  RecompositionTracker.getInstance().recordInteraction(device.deviceId);
  const tapAnyCommand = tapAnyElementFactory(device);
  const result = await tapAnyCommand.execute(
    {
      display: args.display,
      container: args.container,
      selectionStrategy: args.selectionStrategy,
      scrollableContainer: args.scrollableContainer,
      action: args.action,
      duration: args.duration,
      searchUntil: args.searchUntil,
    },
    progress,
    signal,
    { requestDeadlineMs: resolveTransportDeadlineMs(args) },
  );

  const searchSummary = buildTapAnySearchSummary(result);
  // A miss must not read as a completed tap: gate the message on the outcome
  // and mark the MCP envelope `isError`, exactly as tapOn does (#6152, #6163).
  const failurePrefix = "Failed to tap clickable element: ";
  const failure = result.error || "unknown error";
  const message = result.success
    ? searchSummary
      ? `Tapped clickable element (${searchSummary})`
      : "Tapped clickable element"
    : failure.startsWith(failurePrefix)
      ? failure
      : `${failurePrefix}${failure}`;
  const response = createStructuredToolResponse({
    message,
    observation: result.observation,
    ...result,
  });
  return result.success ? response : { ...response, isError: true as const };
}

// Injection seam for the dragAndDrop handler. Lets a unit test exercise the
// registered handler wiring with a fake DragAndDrop whose execute() returns a
// failure (#6163).
export type DragAndDropLike = Pick<DragAndDrop, "execute">;

let dragAndDropFactory: (device: BootedDevice) => DragAndDropLike = (device) =>
  new DragAndDrop(device);

export function setDragAndDropFactory(factory: (device: BootedDevice) => DragAndDropLike): void {
  dragAndDropFactory = factory;
}

export function resetDragAndDropFactory(): void {
  dragAndDropFactory = (device) => new DragAndDrop(device);
}

export async function dragAndDropHandler(
  device: BootedDevice,
  args: DragAndDropArgs,
  progress?: ProgressCallback,
  signal?: AbortSignal,
) {
  RecompositionTracker.getInstance().recordInteraction(device.deviceId);
  const dragAndDrop = dragAndDropFactory(device);
  const result: DragAndDropResult = await dragAndDrop.execute(
    {
      display: args.display,
      source: args.source,
      target: args.target,
      pressDurationMs: args.pressDurationMs,
      dragDurationMs: args.dragDurationMs,
      holdDurationMs: args.holdDurationMs,
    },
    progress,
    signal,
  );

  const message = result.success
    ? "Dragged element to target"
    : `Failed to drag element to target: ${result.error || "unknown error"}`;
  const response = createJSONToolResponse({
    message,
    observation: result.observation,
    ...result,
  });
  return result.success ? response : { ...response, isError: true as const };
}

// Injection seam for the selectAllText handler. Lets a unit test exercise the
// registered handler wiring with a fake SelectAllText whose execute() returns
// a failure (#6163).
export type SelectAllTextLike = Pick<SelectAllText, "execute">;

let selectAllTextFactory: (device: BootedDevice) => SelectAllTextLike = (device) =>
  new SelectAllText(device);

export function setSelectAllTextFactory(
  factory: (device: BootedDevice) => SelectAllTextLike,
): void {
  selectAllTextFactory = factory;
}

export function resetSelectAllTextFactory(): void {
  selectAllTextFactory = (device) => new SelectAllText(device);
}

export async function selectAllTextHandler(
  device: BootedDevice,
  _args: SelectAllTextArgs,
  progress?: ProgressCallback,
  signal?: AbortSignal,
) {
  try {
    const selectAllText = selectAllTextFactory(device);
    const result: SelectAllTextResult = await selectAllText.execute(progress, signal);

    const message = result.success
      ? "Selected all text in focused input field"
      : `Failed to select all text: ${result.error || "unknown error"}`;
    const response = createJSONToolResponse({
      message,
      observation: result.observation,
      ...result,
    });
    return result.success ? response : { ...response, isError: true as const };
  } catch (error) {
    throw toActionableError(error, `Failed to select all text`);
  }
}

// Injection seam for the pressButton handler. Lets a unit test exercise the
// registered handler wiring with a fake PressButton whose execute() returns a
// failure (#6163).
export type PressButtonLike = Pick<PressButton, "execute">;

let pressButtonFactory: (device: BootedDevice) => PressButtonLike = (device) =>
  new PressButton(device);

export function setPressButtonFactory(factory: (device: BootedDevice) => PressButtonLike): void {
  pressButtonFactory = factory;
}

export function resetPressButtonFactory(): void {
  pressButtonFactory = (device) => new PressButton(device);
}

export async function pressButtonHandler(
  device: BootedDevice,
  args: PressButtonArgs,
  progress?: ProgressCallback,
  signal?: AbortSignal,
) {
  RecompositionTracker.getInstance().recordInteraction(device.deviceId);
  try {
    const pressButton = pressButtonFactory(device);
    const result: PressButtonResult = await pressButton.execute(args.button, progress, signal);

    const message = result.success
      ? `Pressed button ${args.button}`
      : `Failed to press button ${args.button}: ${result.error || "unknown error"}`;
    const response = createStructuredToolResponse({
      message,
      observation: result.observation,
      ...result,
    });
    return result.success ? response : { ...response, isError: true as const };
  } catch (error) {
    throw toActionableError(error, `Failed to press button`);
  }
}

// Injection seam for the rotate handler. In particular, persistent-orientation
// failures must reach MCP clients as errors rather than success-shaped results.
export type RotateLike = Pick<Rotate, "execute">;

let rotateFactory: (device: BootedDevice, options?: RotateOptions) => RotateLike = (
  device,
  options,
) => new Rotate(device, null, defaultTimer, options);

export function setRotateFactory(
  factory: (device: BootedDevice, options?: RotateOptions) => RotateLike,
): void {
  rotateFactory = factory;
}

export function resetRotateFactory(): void {
  rotateFactory = (device, options) => new Rotate(device, null, defaultTimer, options);
}

export type SetPostureLike = Pick<SetPosture, "execute" | "executeHingeAngle">;

let setPostureFactory: (device: BootedDevice) => SetPostureLike = (device) =>
  new SetPosture(device);

export function setSetPostureFactory(factory: (device: BootedDevice) => SetPostureLike): void {
  setPostureFactory = factory;
}

export function resetSetPostureFactory(): void {
  setPostureFactory = (device) => new SetPosture(device);
}

export async function setPostureHandler(
  device: BootedDevice,
  args: {
    posture?: RequestedPosture;
    hingeAngle?: number;
    displayPreset?: "phone" | "unfolded" | "tablet";
  },
  _progress?: ProgressCallback,
  signal?: AbortSignal,
) {
  try {
    throwIfAborted(signal);
    // The tool boundary validates public args before injecting execution metadata.
    // Direct callers still need the schema's cross-field invariants.
    if ((args.posture !== undefined) === (args.hingeAngle !== undefined)) {
      throw new ActionableError("Specify exactly one of posture or hingeAngle.");
    }
    if (args.hingeAngle !== undefined && args.displayPreset !== undefined) {
      throw new ActionableError(
        "displayPreset requires posture and cannot be combined with hingeAngle.",
      );
    }
    const action = setPostureFactory(device);
    const result: SetPostureOutput =
      args.hingeAngle !== undefined
        ? await action.executeHingeAngle(args.hingeAngle, {
            displayPreset: args.displayPreset,
            signal,
          })
        : await action.execute(args.posture!, args.displayPreset, signal);
    const message =
      "status" in result
        ? result.message
        : result.hingeAngle !== undefined
          ? result.observedHingeAngle === undefined
            ? `Requested hinge angle ${result.hingeAngle} degrees; the resulting angle could not be verified (posture ${result.posture})`
            : Math.abs(result.observedHingeAngle - result.hingeAngle) > 1
              ? `Requested hinge angle ${result.hingeAngle} degrees; the device reports ${result.observedHingeAngle} degrees (posture ${result.posture})`
              : `Set hinge angle to ${result.hingeAngle} degrees; device reports posture ${result.posture}${result.postureReason ? ` (${result.postureReason})` : ""}`
          : `Set device posture to ${result.posture}`;
    return createStructuredToolResponse({ message, ...result });
  } catch (error) {
    throw toActionableError(error, "Failed to set device posture");
  }
}

export function formatRotateMessage(
  result: Pick<RotateResult, "success" | "orientation" | "error" | "message">,
): string {
  if (!result.success) {
    return `Failed to rotate device: ${result.error || "unknown error"}`;
  }
  return result.message ?? `Rotated device to ${result.orientation} orientation`;
}

export async function rotateHandler(
  device: BootedDevice,
  args: RotateArgs,
  progress?: ProgressCallback,
  signal?: AbortSignal,
) {
  try {
    if (args.lockOrientation !== undefined && device.platform !== "android") {
      throw new ActionableError("lockOrientation is supported only on Android devices.");
    }
    const manager =
      args.sessionUuid && device.platform === "android" && DaemonState.getInstance().isInitialized()
        ? DaemonState.getInstance().getSessionManager()
        : undefined;
    const deadlineMs = resolveTransportDeadlineMs(args);
    const rotate = rotateFactory(device, {
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
      sessionRotation: (mutation) =>
        runSessionRotationMutation(manager, args.sessionUuid, device.deviceId, mutation),
    });
    const result = await rotate.execute(
      args.orientation,
      progress,
      args.lockOrientation,
      signal,
      args.display,
    );
    const response = createStructuredToolResponse({
      observation: result.observation,
      ...result,
      message: formatRotateMessage(result),
    });
    return result.success ? response : { ...response, isError: true as const };
  } catch (error) {
    throw toActionableError(error, `Failed to rotate device`);
  }
}

// An empty list is only honest when every rendered row could be attributed;
// otherwise say how many rows stayed unreadable so "0" is not mistaken for
// "this app has no notifications" (#6875).
function formatTrayListMessage(
  appId: string,
  result: { notifications: unknown[]; unattributedRows: number },
): string {
  const listed = `Listed ${result.notifications.length} notifications for ${appId}`;
  if (result.unattributedRows === 0) {
    return listed;
  }
  const rows = result.unattributedRows === 1 ? "row" : "rows";
  return `${listed} (${result.unattributedRows} shade ${rows} carry no app header and could not be correlated to ${appId})`;
}

function formatClearAllResult(
  appId: string | undefined,
  swipeCount: number,
  accounting:
    | {
        expectedKeys: readonly string[];
        remainingKeys: readonly string[];
      }
    | undefined,
): {
  arrivedCount?: number;
  dismissedCount: number;
  expectedCount?: number;
  message: string;
  remainingCount?: number;
  success: boolean;
} {
  if (!accounting) {
    return {
      message:
        swipeCount > 0
          ? `Cleared ${swipeCount} notification(s) for ${appId}`
          : `No notifications found for ${appId}`,
      dismissedCount: swipeCount,
      success: true,
    };
  }
  const expectedKeys = new Set(accounting.expectedKeys);
  const remainingKeys = new Set(accounting.remainingKeys);
  const expectedCount = expectedKeys.size;
  const remainingCount = remainingKeys.size;
  const dismissedCount = [...expectedKeys].filter((key) => !remainingKeys.has(key)).length;
  const arrivedCount = [...remainingKeys].filter((key) => !expectedKeys.has(key)).length;
  if (remainingCount === 0) {
    return expectedCount === 0
      ? {
          dismissedCount,
          expectedCount,
          message: `No notifications found for ${appId}`,
          remainingCount,
          success: true,
        }
      : {
          dismissedCount,
          expectedCount,
          message: `Cleared ${dismissedCount} notification(s) for ${appId}`,
          remainingCount,
          success: true,
        };
  }
  return {
    ...(arrivedCount === 0 ? {} : { arrivedCount }),
    dismissedCount,
    expectedCount,
    message:
      `Cleared ${dismissedCount} of ${expectedCount} notification(s) for ${appId}; ` +
      `${remainingCount} remain after clearing.` +
      (arrivedCount === 0 ? "" : ` ${arrivedCount} notification(s) arrived during the operation.`),
    remainingCount,
    success: false,
  };
}

const readRequiredActiveNotificationKeys = async (
  device: BootedDevice,
  appId: string,
  phase: "before" | "after",
  signal?: AbortSignal,
): Promise<string[]> => {
  const keys = await readActiveNotificationKeysForApp(device, appId, signal);
  if (keys === undefined) {
    throw new ActionableError(
      phase === "before"
        ? `Could not verify how many notifications exist for ${appId}.`
        : `Could not verify how many notifications remain for ${appId}.`,
    );
  }
  return keys;
};

// Resolve the label used to attribute shade rows for a destructive clearAll.
// A unique label is required (an ambiguous one could attribute another app's
// row); resolveUniqueTrayAppLabel throws on ambiguity, which we treat as "no
// attribution label" (null) so the header fallback fails closed rather than
// swiping the wrong notification.
const resolveClearAllAttributionLabel = async (
  device: BootedDevice,
  appId: string,
  installedApps: string[],
  signal?: AbortSignal,
): Promise<string | null> => {
  try {
    return await resolveUniqueTrayAppLabel(device, appId, installedApps, signal);
  } catch (error) {
    if (!(error instanceof ActionableError)) {
      throw error;
    }
    logger.debug(
      `[systemTray] could not verify a unique label for clearAll attribution: ${error}`,
      error,
    );
    return null;
  }
};

const readCompleteTrayAppIds = async (
  device: BootedDevice,
  signal?: AbortSignal,
): Promise<string[]> => {
  const inventory = await getSystemTrayDependencies()
    .appInventoryFactory(device)
    .executeDetailedResult(signal);
  if (!inventory.successful) {
    throw new ActionableError(
      "Cannot verify notification ownership because the installed-app inventory is incomplete.",
    );
  }
  return [
    ...new Set(
      [...Object.values(inventory.apps.profiles).flat(), ...inventory.apps.system].map(
        (app) => app.packageName,
      ),
    ),
  ];
};

const readCompleteIosTrayAppIds = async (
  device: BootedDevice,
  signal?: AbortSignal,
): Promise<string[]> => {
  throwIfAborted(signal);
  const inventory = await awaitWhileRequestIsLive(
    Promise.resolve(
      getSystemTrayDependencies().appInventoryFactory(device).executeIosDetailedResult?.(),
    ),
    signal,
  );
  throwIfAborted(signal);
  if (!inventory?.successful) {
    const reason = inventory?.error !== undefined ? ` ${errorMessage(inventory.error)}` : "";
    throw new ActionableError(
      `Cannot verify notification ownership because the installed apps could not be listed; the installed-app inventory is incomplete.${reason}`,
    );
  }
  return inventory.apps
    .map(getIosInstalledAppBundleId)
    .filter((bundleId): bundleId is string => bundleId !== undefined);
};

// ============================================================================
// Tool Registration
// ============================================================================

async function handleInstalledImeAction(
  device: BootedDevice,
  args: KeyboardArgs,
  signal?: AbortSignal,
) {
  if (device.platform !== "android") {
    throw new ActionableError("Installed IME actions are Android-only; select an Android device.");
  }
  if (args.action === "tapImeKey") {
    if (!args.imeId || !args.key) {
      throw new ActionableError("tapImeKey requires imeId and key.");
    }
    return createStructuredToolResponse(
      await createInstalledImeKeySession(device).tapKey(args.imeId, args.key, signal),
    );
  }
  const adb = defaultAdbClientFactory.create(device);
  const catalog = new AndroidImeCatalog(adb, device.deviceId, createForegroundUserSource(adb));
  if (args.action === "listImes") {
    return createStructuredToolResponse(await catalog.list(signal));
  }
  if (!args.imeId) {
    throw new ActionableError("keyboard setIme requires imeId from listImes.");
  }
  return createStructuredToolResponse(await catalog.select(args.imeId, signal));
}

// Per-command factories preserve the default device implementations in production.
let keyboardFactory: (device: BootedDevice) => Pick<Keyboard, "execute"> = (device) =>
  new Keyboard(device);
export function setKeyboardFactory(factory: typeof keyboardFactory): void {
  keyboardFactory = factory;
}
export function resetKeyboardFactory(): void {
  keyboardFactory = (device) => new Keyboard(device);
}
let openUrlFactory: (device: BootedDevice) => Pick<OpenURL, "execute"> = (device) =>
  new OpenURL(device);
export function setOpenUrlFactory(factory: typeof openUrlFactory): void {
  openUrlFactory = factory;
}
export function resetOpenUrlFactory(): void {
  openUrlFactory = (device) => new OpenURL(device);
}
let openLinkChooserFactory: (device: BootedDevice) => Pick<HandleIntentChooser, "execute"> = (
  device,
) => new HandleIntentChooser(device);
export function setOpenLinkChooserFactory(factory: typeof openLinkChooserFactory): void {
  openLinkChooserFactory = factory;
}
export function resetOpenLinkChooserFactory(): void {
  openLinkChooserFactory = (device) => new HandleIntentChooser(device);
}

let shakeFactory: (device: BootedDevice) => Pick<Shake, "execute"> = (device) => new Shake(device);
export function setShakeFactory(factory: (device: BootedDevice) => Pick<Shake, "execute">): void {
  shakeFactory = factory;
}
export function resetShakeFactory(): void {
  shakeFactory = (device) => new Shake(device);
}
let recentAppsFactory: (device: BootedDevice) => Pick<RecentApps, "execute"> = (device) =>
  new RecentApps(device);
export function setRecentAppsFactory(
  factory: (device: BootedDevice) => Pick<RecentApps, "execute">,
): void {
  recentAppsFactory = factory;
}
export function resetRecentAppsFactory(): void {
  recentAppsFactory = (device) => new RecentApps(device);
}
let clipboardFactory: (device: BootedDevice) => Pick<Clipboard, "execute"> = (device) =>
  new Clipboard(device);
export function setClipboardFactory(
  factory: (device: BootedDevice) => Pick<Clipboard, "execute">,
): void {
  clipboardFactory = factory;
}
export function resetClipboardFactory(): void {
  clipboardFactory = (device) => new Clipboard(device);
}
let wakeAndUnlockFactory: (device: BootedDevice) => Pick<WakeAndUnlock, "execute"> = (device) =>
  new WakeAndUnlock(device, undefined, {
    credentialStore: new DeviceLockStore(),
    iosUnlocker: device.platform === "ios" ? new IosLockScreenUnlocker(device) : undefined,
    iosRunnerRecovery:
      device.platform === "ios" ? IOSCtrlProxyClient.getInstance(device) : undefined,
  });
export function setWakeAndUnlockFactory(
  factory: (device: BootedDevice) => Pick<WakeAndUnlock, "execute">,
): void {
  wakeAndUnlockFactory = factory;
}
export function resetWakeAndUnlockFactory(): void {
  wakeAndUnlockFactory = (device) =>
    new WakeAndUnlock(device, undefined, {
      credentialStore: new DeviceLockStore(),
      iosUnlocker: device.platform === "ios" ? new IosLockScreenUnlocker(device) : undefined,
      iosRunnerRecovery:
        device.platform === "ios" ? IOSCtrlProxyClient.getInstance(device) : undefined,
    });
}

export function registerInteractionTools() {
  // tapOn, tapAny, dragAndDrop, selectAllText, pressButton, and swipeOn handlers
  // are defined at module scope (each with an
  // injectable factory) so a unit test can exercise the registered handler
  // wiring (#6152, #6163).

  // System tray handler
  const systemTrayHandler = async (
    device: BootedDevice,
    args: SystemTrayArgs,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    let restoreFailedClearAll: (() => Promise<void>) | undefined;
    try {
      throwIfAborted(signal);
      const awaitTimeoutMs = resolveSystemTrayAwaitTimeout(args.awaitTimeout);

      if (args.action === "open") {
        const result = await ensureSystemTrayOpen(device, awaitTimeoutMs, progress, signal);
        await captureSystemTrayTerminalEvidence(device, result.observation, signal);
        const success = result.skipped || result.opened;
        const response = createJSONToolResponse({
          message: result.skipped
            ? "System tray already open; no swipe needed"
            : result.opened
              ? "Opened system tray"
              : "Failed to open system tray: the tray remained closed",
          observation: result.observation,
          success,
          skipped: result.skipped,
        });
        return success ? response : { ...response, isError: true as const };
      }

      if (args.action === "close") {
        const result = await ensureSystemTrayClosed(device, awaitTimeoutMs, progress, signal);
        await captureSystemTrayTerminalEvidence(device, result.observation, signal);
        const success = result.skipped || result.closed;
        const response = createJSONToolResponse({
          message: result.skipped
            ? "System tray already closed; no collapse needed"
            : result.closed
              ? "Closed system tray (collapsed notification shade)"
              : "Failed to close system tray: the tray remained open",
          observation: result.observation,
          success,
          skipped: result.skipped,
        });
        return success ? response : { ...response, isError: true as const };
      }

      if (args.action === "list") {
        if (device.platform !== "android") {
          throw new ActionableError("systemTray list is supported only on Android.");
        }
        const appId = args.notification?.appId;
        if (!appId) {
          throw new ActionableError("list action requires notification.appId");
        }
        throwIfAborted(signal);
        const appIds = await readCompleteTrayAppIds(device, signal);
        throwIfAborted(signal);
        if (!appIds.includes(appId)) {
          throw new ActionableError(`App ${appId} is not installed.`);
        }
        const label = await resolveUniqueTrayAppLabel(device, appId, appIds, signal);
        const result = await listSystemTrayNotifications(
          device,
          appId,
          label,
          awaitTimeoutMs,
          progress,
          signal,
        );
        await captureSystemTrayTerminalEvidence(device, result.observation, signal);
        return createJSONToolResponse({
          message: formatTrayListMessage(appId, result),
          ...result,
          success: true,
        });
      }

      const notification = args.notification ?? {};
      let appLabel: string | null = null;
      let appMatchTexts: string[] = [];
      let installedApps: string[] = [];

      if (notification.appId) {
        throwIfAborted(signal);
        installedApps =
          device.platform === "android"
            ? await awaitWhileRequestIsLive(readCompleteTrayAppIds(device, signal), signal)
            : await readCompleteIosTrayAppIds(device, signal);
        if (!installedApps.includes(notification.appId)) {
          throw new ActionableError(`App ${notification.appId} is not installed.`);
        }

        throwIfAborted(signal);
        appLabel = await awaitWhileRequestIsLive(
          getSystemTrayDependencies().appLabelResolver(device, notification.appId, signal),
          signal,
        );
        appMatchTexts = [appLabel, notification.appId].filter(Boolean) as string[];
      }

      if (args.action === "find") {
        const { observation, match } = await waitForNotificationMatch(
          device,
          notification,
          appMatchTexts,
          awaitTimeoutMs,
          progress,
          signal,
        );

        if (!match) {
          throw new ActionableError(`Notification not found after ${awaitTimeoutMs}ms.`);
        }

        await captureSystemTrayTerminalEvidence(device, observation, signal);
        return createJSONToolResponse({
          message: "Found notification in system tray",
          match: match.match.matches,
          observation,
          success: true,
        });
      }

      if (args.action === "tap") {
        const actionStartMs = getSystemTrayDependencies().timer.now();
        const initialMatch = await waitForNotificationMatch(
          device,
          notification,
          appMatchTexts,
          awaitTimeoutMs,
          progress,
          signal,
        );

        if (!initialMatch.match) {
          throw new ActionableError(`Notification not found after ${awaitTimeoutMs}ms.`);
        }

        const { observation: baseline, match } = await expandAndRematchIfCollapsed(
          device,
          notification,
          appMatchTexts,
          actionStartMs + awaitTimeoutMs,
          progress,
          { observation: initialMatch.observation, match: initialMatch.match, signal },
        );

        const tapMatch = resolveNotificationTapElement(match, notification);
        if (!tapMatch) {
          throw new ActionableError(
            "No notification tap target was resolved within the matched notification.",
          );
        }

        await tapElement(device, tapMatch.element, signal);
        const { observation: nextObservation, settled } = await observeSystemTrayAfterTap(
          device,
          baseline,
          signal,
        );
        await captureSystemTrayTerminalEvidence(device, nextObservation, signal);

        return createJSONToolResponse({
          message:
            (notification.tapActionLabel
              ? `Tapped notification action "${notification.tapActionLabel}"`
              : "Tapped notification") +
            (settled ? "" : "; effect not yet settled — re-observe before continuing"),
          settled,
          match: match.match.matches,
          tapTarget: {
            text: tapMatch.text,
            matchType: tapMatch.matchType,
            bounds: tapMatch.element.bounds,
          },
          observation: nextObservation,
          success: true,
        });
      }

      if (args.action === "dismiss") {
        const actionStartMs = getSystemTrayDependencies().timer.now();
        const initialMatch = await waitForNotificationMatch(
          device,
          notification,
          appMatchTexts,
          awaitTimeoutMs,
          progress,
          signal,
        );

        if (!initialMatch.match) {
          throw new ActionableError(`Notification not found after ${awaitTimeoutMs}ms.`);
        }

        const { match, observation: swipeObservation } = await expandAndRematchIfCollapsed(
          device,
          notification,
          appMatchTexts,
          actionStartMs + awaitTimeoutMs,
          progress,
          { observation: initialMatch.observation, match: initialMatch.match, signal },
        );
        const groupExpansionState = match.candidate.groupNode
          ? resolveNotificationGroupExpansionState(match.candidate.groupNode)
          : null;
        if (groupExpansionState === "unknown") {
          throw new ActionableError(
            "Could not determine whether the notification group is expanded or collapsed; " +
              "refusing to swipe without expanding first.",
          );
        }
        if (groupExpansionState === "collapsed") {
          throw new ActionableError(
            "Could not isolate the specific notification from its collapsed group; " +
              "dismissing would clear the whole group instead of this notification.",
          );
        }

        const swipeTarget = resolveNotificationSwipeElement(match, notification, appMatchTexts);
        if (!swipeTarget) {
          throw new ActionableError(
            "No swipeable notification element was resolved within the matched notification.",
          );
        }
        if (!isSwipeTargetIsolatedFromGroup(match, swipeTarget)) {
          throw new ActionableError(
            "Could not isolate the specific notification from its collapsed group; " +
              "dismissing would clear the whole group instead of this notification.",
          );
        }

        await swipeElement(device, swipeTarget, signal);
        const { observeScreenFactory } = getSystemTrayDependencies();
        const observeScreen = observeScreenFactory(device);
        throwIfAborted(signal);
        const nextObservation = await awaitWhileRequestIsLive(
          observeScreen.execute({
            skipScreenshot: true,
            skipAccessibilityAudit: true,
            skipPerformanceAudit: true,
            signal,
          }),
          signal,
        );
        // #10010: only Android is verified here; the swipe itself says nothing
        // about whether the row left the shade (ongoing rows snap back).
        const verification =
          device.platform === "android" && swipeObservation.viewHierarchy
            ? await verifyNotificationDismissed(
                device,
                captureNotificationDismissBaseline(
                  swipeObservation.viewHierarchy,
                  match,
                  notification,
                  appMatchTexts,
                ),
                notification,
                appMatchTexts,
                nextObservation,
                signal,
              )
            : undefined;
        const finalObservation = verification?.observation ?? nextObservation;
        await captureSystemTrayTerminalEvidence(device, finalObservation, signal);

        if (verification?.outcome === "still-present") {
          return {
            ...createJSONToolResponse({
              message: verification.nonClearable
                ? "Could not dismiss notification: it is still in the system tray and appears to be " +
                  "ongoing/non-clearable (its row exposes no dismiss action)."
                : "Could not dismiss notification: it is still present in the system tray after the swipe.",
              match: match.match.matches,
              observation: finalObservation,
              success: false,
            }),
            isError: true as const,
          };
        }

        return createJSONToolResponse({
          message: "Dismissed notification",
          match: match.match.matches,
          observation: finalObservation,
          success: true,
        });
      }

      if (args.action !== "clearAll") {
        throw new ActionableError(`Unknown systemTray action: ${args.action}`);
      }

      const clearDetector =
        device.platform === "android"
          ? createNotificationUIDetector(device, getSystemTrayDependencies, signal)
          : undefined;
      if (clearDetector) {
        const initialObservation = await awaitWhileRequestIsLive(
          getSystemTrayDependencies()
            .observeScreenFactory(device)
            .execute({
              skipScreenshot: true,
              skipAccessibilityAudit: true,
              skipPerformanceAudit: true,
              minTimestamp: await clearDetector.getObservationTimestamp(),
              signal,
            }),
          signal,
        );
        const initiallyOpen = clearDetector.isTrayOpen(initialObservation.viewHierarchy);
        // Use statusbar commands directly: an unreadable hierarchy must not
        // make ensureSystemTrayClosed skip the cleanup of an expanded shade.
        restoreFailedClearAll = async () => {
          // Mark cleanup done before starting it, including when it throws or times out.
          restoreFailedClearAll = undefined;
          // Cleanup must still run after request cancellation.
          try {
            const restoreDetector = createNotificationUIDetector(device, getSystemTrayDependencies);
            await raceWithDeadline(
              () => (initiallyOpen ? restoreDetector.expandTray() : restoreDetector.collapseTray()),
              {
                timer: getSystemTrayDependencies().timer,
                timeoutMs: awaitTimeoutMs,
                label: "Notification shade restoration",
              },
            );
          } catch (restoreError) {
            logger.warn(
              `Failed to restore notification shade: ${errorMessage(restoreError)}`,
              restoreError,
            );
          }
        };
      }

      let expectedKeys: string[] | undefined;
      let clearMatchTexts = appMatchTexts;
      if (device.platform === "android" && notification.appId) {
        const attributionLabel = await resolveClearAllAttributionLabel(
          device,
          notification.appId,
          installedApps,
          signal,
        );
        const listed = await listSystemTrayNotifications(
          device,
          notification.appId,
          attributionLabel,
          awaitTimeoutMs,
          progress,
          signal,
        );
        expectedKeys = await readRequiredActiveNotificationKeys(
          device,
          notification.appId,
          "before",
          signal,
        );
        // All correlated rows' content text lets the existing row matcher
        // isolate them, whether ownership comes from a header or dumpsys.
        clearMatchTexts = [
          ...new Set([
            ...appMatchTexts,
            ...listed.notifications.flatMap((listedNotification) => listedNotification.texts),
          ]),
        ];
      }
      const drained =
        device.platform === "android"
          ? await clearMatchingSystemTrayNotifications(
              device,
              notification,
              clearMatchTexts,
              awaitTimeoutMs,
              {
                maxSwipes: expectedKeys?.length,
                progress,
                signal,
              },
            )
          : await clearIosSystemTrayNotifications(device, notification, clearMatchTexts, {
              progress,
              signal,
            });

      const remainingKeys =
        expectedKeys === undefined || !notification.appId
          ? undefined
          : await readRequiredActiveNotificationKeys(device, notification.appId, "after", signal);

      const result = formatClearAllResult(
        notification.appId,
        drained.dismissedCount,
        expectedKeys && remainingKeys ? { expectedKeys, remainingKeys } : undefined,
      );
      if (drained.stalled) {
        // The app inventory is authoritative even if UI/text fallback still matches a row.
        if (remainingKeys === undefined || remainingKeys.length > 0) {
          result.success = false;
        }
        result.message =
          expectedKeys === undefined
            ? `Cleared ${drained.dismissedCount} matching notification(s).`
            : result.message;
        result.message += result.success
          ? " Warning: a matching notification remains in the UI, but the app notification inventory is empty."
          : " A matching notification remains; dismissal was not confirmed or the swipe limit or deadline was reached.";
      }
      if (!result.success && restoreFailedClearAll) {
        await restoreFailedClearAll();
      }

      const { observeScreenFactory } = getSystemTrayDependencies();
      const observeScreen = observeScreenFactory(device);
      throwIfAborted(signal);
      const nextObservation = await awaitWhileRequestIsLive(
        observeScreen.execute({
          skipScreenshot: true,
          skipAccessibilityAudit: true,
          skipPerformanceAudit: true,
          signal,
        }),
        signal,
      );
      await captureSystemTrayTerminalEvidence(device, nextObservation, signal);

      restoreFailedClearAll = undefined;
      const response = createJSONToolResponse({
        ...result,
        observation: nextObservation,
      });
      return result.success ? response : { ...response, isError: true as const };
    } catch (error) {
      throwIfAborted(signal);
      if (args.action === "clearAll" && error instanceof NotificationShadeNotOpenError) {
        throw new ActionableError(
          "Could not clear notifications: shade not readable (shade not detected open during list).",
          { cause: error },
        );
      }
      if (error instanceof ActionableError) {
        throw error;
      }
      throw toActionableError(error, `systemTray failed`);
    } finally {
      if (restoreFailedClearAll) {
        await restoreFailedClearAll();
      }
    }
  };

  // swipeOn handler is defined at module scope (with an injectable SwipeOn
  // factory) so a unit test can exercise the registered handler wiring (#6163).

  // Pinch on handler
  // pinchOn handler is defined at module scope (with an injectable PinchOn
  // factory) so a unit test can exercise the registered handler wiring (#6056).

  const sendKeysHandler = async (
    device: BootedDevice,
    args: SendKeysArgs,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    await assertSendKeysRunnerCompatible(device);
    RecompositionTracker.getInstance().recordInteraction(device.deviceId);
    const sendKeys = sendKeysFactory(device);
    const result = await sendKeys.execute(
      args.commands,
      args.selector,
      progress,
      signal,
      args.display,
      { container: args.container, selectionStrategy: args.selectionStrategy },
    );
    const dismissal = await dismissKeyboardAfterSendKeys(
      device,
      serverConfig.isDismissKeyboardAfterInputEnabled(),
      result.success,
      async (closeSignal) => keyboardFactory(device).execute("close", closeSignal),
      signal,
    );
    const response = createStructuredToolResponse({
      message: result.success
        ? `Executed ${result.completedCommands} sendKeys command(s)${dismissal.warnings?.length ? `. Warning: ${dismissal.warnings.join("; ")}` : ""}`
        : `sendKeys stopped at command ${result.failedIndex}: ${result.error}`,
      ...result,
      ...dismissal,
    });
    return result.success ? response : { ...response, isError: true };
  };

  // Wake and unlock handler
  const wakeAndUnlockHandler = async (
    device: BootedDevice,
    args: WakeAndUnlockArgs,
    _progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    const wakeAndUnlock = wakeAndUnlockFactory(device);
    const transportDeadlineMs = (args as Record<string, unknown>)[
      INTERNAL_MCP_REQUEST_DEADLINE_PARAM
    ];
    const result = await wakeAndUnlock.execute(
      args.pin,
      typeof transportDeadlineMs === "number" ? transportDeadlineMs : undefined,
      signal,
    );
    const message = result.success
      ? result.wasLocked
        ? "Device unlocked"
        : "Device awake"
      : `Failed to unlock device: ${result.error ?? "unknown error"}`;
    const response = createStructuredToolResponse({
      message: result.warning ? `${message}. Warning: ${result.warning}` : message,
      ...result,
    });
    return withIsErrorOnFailure(response, result.success);
  };

  // Open link handler
  const openLinkHandler = async (
    device: BootedDevice,
    args: OpenLinkArgs,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    throwIfAborted(signal);
    // #6154 follow-up: `platform` is optional on the wire, so the schema's
    // iOS-rejects-activityName check (raw request platform) can be skipped
    // entirely when the caller omitted it. Re-validate against the resolved
    // `device.platform` before opening the URL.
    assertActiveWindowWaitForSupportedOnPlatform(device.platform, args.waitFor);
    if (args.chooserAppPackage && device.platform !== "android") {
      throw new ActionableError("chooserAppPackage is supported only on Android.");
    }

    const openUrl = openUrlFactory(device);
    const opened = await openUrl.execute(args.url, signal);
    throwIfAborted(signal);
    const result = args.chooserAppPackage
      ? await selectAndroidOpenLinkChooser(
          device,
          args.chooserAppPackage,
          opened,
          opened.url,
          openLinkChooserFactory(device),
          signal,
        )
      : opened;
    throwIfAborted(signal);
    const iosClient = device.platform === "ios" ? IOSCtrlProxyClient.getInstance(device) : null;
    const acceptedOpenAlert =
      args.acceptOpenAlert && result.success
        ? await acceptIosAppOpenAlert(
            device,
            result.observation,
            progress,
            signal,
            iosClient
              ? async () => {
                  const refreshed = await iosClient.requestHierarchySync(
                    undefined,
                    true,
                    signal,
                    IOS_OPEN_ALERT_HIERARCHY_TIMEOUT_MS,
                  );
                  return refreshed
                    ? iosClient.convertToViewHierarchyResult(refreshed.hierarchy)
                    : null;
                }
              : undefined,
            iosClient
              ? () =>
                  iosClient.requestAction(
                    "system_alert_accept",
                    undefined,
                    undefined,
                    IOS_OPEN_ALERT_HIERARCHY_TIMEOUT_MS,
                    undefined,
                    { abortSignal: signal },
                  )
              : undefined,
          )
        : null;
    const effectiveResult: OpenURLResult & { openAlertAccepted?: true } = acceptedOpenAlert
      ? {
          ...result,
          observation: acceptedOpenAlert.observation ?? result.observation,
          openAlertAccepted: true,
        }
      : result;

    // Integrated waitFor (issue #3490 §5): once the URL is opened, poll for the
    // predicate exactly as `observe` does, surfacing the awaited observation and
    // await metadata so callers no longer need a separate observe round-trip.
    const waitOutcome = args.waitFor
      ? await waitForObservation(
          new RealObserveScreen(device),
          { ...args.waitFor, settled: args.settled },
          signal,
          false,
          defaultTimer,
          device.platform,
          undefined,
          undefined,
          ...displayWaitInventory(device),
        )
      : null;

    const response = createStructuredToolResponse(
      buildOpenLinkPayload(args.url, effectiveResult, waitOutcome),
    );
    return withIsErrorOnFailure(response, effectiveResult.success);
  };

  // Shake handler
  const shakeHandler = async (
    device: BootedDevice,
    args: ShakeArgs,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    try {
      const shake = shakeFactory(device);
      const result = await shake.execute(
        {
          duration: args.duration ?? 1000,
          intensity: args.intensity ?? 100,
        },
        progress,
        signal,
      );

      const response = createJSONToolResponse({
        message: result.success
          ? `Shook device for ${args.duration ?? 1000}ms with intensity ${args.intensity ?? 100}`
          : `Failed to shake device: ${result.error ?? "unknown error"}`,
        observation: result.observation,
        ...result,
      });
      return withIsErrorOnFailure(response, result.success);
    } catch (error) {
      throw toActionableError(error, `Failed to shake device`);
    }
  };

  // Keyboard handler
  const keyboardHandler = async (
    device: BootedDevice,
    args: KeyboardArgs,
    _progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    try {
      throwIfAborted(signal);
      if (args.action === "setProfile") {
        return createStructuredToolResponse(
          await setKeyboardProfileForTool(device, args.profile, undefined, signal),
        );
      }
      if (args.action === "listProfiles") {
        return createStructuredToolResponse(
          await listKeyboardProfilesForTool(device, undefined, signal),
        );
      }
      if (args.action === "listImes" || args.action === "setIme" || args.action === "tapImeKey") {
        return handleInstalledImeAction(device, args, signal);
      }
      throwIfAborted(signal);
      const keyboard = keyboardFactory(device);
      const result = await keyboard.execute(args.action, signal);
      throwIfAborted(signal);

      const response = createStructuredToolResponse(result);
      return withIsErrorOnFailure(response, result.success);
    } catch (error) {
      // A click/tap already sent when the abort landed is indeterminate; keep that
      // warning instead of reporting a plain cancellation.
      if (!(error instanceof KeyboardOpenIndeterminateError)) {
        throwIfAborted(signal);
      }
      throw toActionableError(error, `Failed to execute keyboard ${args.action}`);
    }
  };

  // Recent Apps handler
  const recentAppsHandler = async (
    device: BootedDevice,
    args: RecentAppsArgs,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    try {
      const recentApps = recentAppsFactory(device);
      const result = await recentApps.execute(progress, signal);

      const response = createJSONToolResponse({
        message: formatRecentAppsMessage(result),
        observation: result.observation,
        ...result,
      });
      return result.success ? response : { ...response, isError: true as const };
    } catch (error) {
      throw toActionableError(error, `Failed to open recent apps`);
    }
  };

  // Home Screen handler
  const homeScreenHandler = async (
    device: BootedDevice,
    args: any,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    try {
      throwIfAborted(signal);
      const homeScreen = new HomeScreen(device);
      const result = await homeScreen.execute(progress, signal);

      const response = createJSONToolResponse({
        message: "Pressed home button to return to the home screen",
        observation: result.observation,
        ...result,
      });
      return withIsErrorOnFailure(response, result.success);
    } catch (error) {
      throwIfAborted(signal);
      throw toActionableError(error, `Failed to go to home screen`);
    }
  };

  // Clipboard handler
  const clipboardHandler = async (
    device: BootedDevice,
    args: ClipboardArgs,
    _progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    try {
      const clipboard = clipboardFactory(device);
      const result = await clipboard.execute(args.action, args.text, signal);

      let message = formatClipboardMessage(result);

      if (result.method) {
        message += ` (via ${result.method})`;
      }

      const response = createJSONToolResponse({
        message,
        ...result,
      });
      return result.success ? response : { ...response, isError: true as const };
    } catch (error) {
      throw toActionableError(error, `Failed to execute clipboard ${args.action}`);
    }
  };

  // Register with the tool registry
  ToolRegistry.registerDeviceAware(
    "selectAllText",
    "Select all text in focused input",
    selectAllTextSchema,
    selectAllTextHandler,
    { defaultEnabled: false, supportsProgress: true },
  );

  ToolRegistry.registerDeviceAware(
    "pressButton",
    "Press a device or navigation button. On iOS simulators, volume_up, volume_down, and power use hardware-button events; menu is unsupported on iOS.",
    pressButtonSchema,
    pressButtonHandler,
    { outputSchema: pressButtonResultSchema, defaultEnabled: true, supportsProgress: true },
  );

  ToolRegistry.registerDeviceAware(
    "systemTray",
    "System tray actions for notifications (open/close/list/find/tap/dismiss/clearAll)",
    systemTraySchema,
    systemTrayHandler,
    { defaultEnabled: false, supportsProgress: true },
  );

  ToolRegistry.registerDeviceAware(
    "sendKeys",
    "Execute ordered typing, clear, raw-key, and semantic IME commands. Unicode: iOS any mode; Android a11y/ime/auto/eventAll/eventLast (event modes use a11y for unsupported runs). Android eventOnly/imeKeyEvents are ASCII-only. textLength counts code points.",
    sendKeysSchema,
    sendKeysHandler,
    { defaultEnabled: true, supportsProgress: true, outputSchema: sendKeysResultSchema },
  );

  ToolRegistry.registerDeviceAware(
    "wakeAndUnlock",
    "Wake a device and unlock its keyguard. Android: swipe lock or secure PIN via `pin`; iOS: wake + swipe-dismiss (pin ignored).",
    wakeAndUnlockSchema,
    wakeAndUnlockHandler,
    { outputSchema: wakeAndUnlockResultSchema, defaultEnabled: true },
  );

  ToolRegistry.registerDeviceAware(
    "openLink",
    "Open URL in browser",
    openLinkSchema,
    openLinkHandler,
    { defaultEnabled: false, outputSchema: openLinkResultSchema },
  );

  ToolRegistry.registerDeviceAware(
    "tapOn",
    "Tap an element by text/content-desc, resource-id, or Android test tag; use sibling for adjacent controls.",
    tapOnSchema,
    tapOnHandler,
    { defaultEnabled: true, supportsProgress: true, outputSchema: tapOnResultSchema },
  );

  ToolRegistry.registerDeviceAware(
    "tapAt",
    "Tap, long press, or double tap at screen coordinates in native, normalized, or percent units.",
    tapAtSchema,
    tapAtHandler,
    { defaultEnabled: true, supportsProgress: true },
  );

  ToolRegistry.registerDeviceAware(
    "hitTest",
    "Preview hierarchy-bounds candidates at a platform-native screen point; no input is dispatched and the actual event recipient is unknown.",
    hitTestSchema,
    hitTestHandler,
    { defaultEnabled: false },
  );

  ToolRegistry.registerDeviceAware(
    "tapAny",
    "Tap any clickable element; scope with container or scrollableContainer.",
    tapAnySchema,
    tapAnyHandler,
    { defaultEnabled: true, supportsProgress: true },
  );

  ToolRegistry.registerDeviceAware(
    "dragAndDrop",
    "Drag and drop element",
    dragAndDropSchema,
    dragAndDropHandler,
    { defaultEnabled: false, supportsProgress: true },
  );

  ToolRegistry.registerDeviceAware(
    "swipeOn",
    "Swipe/scroll on screen or elements",
    swipeOnSchema,
    swipeOnHandler,
    { defaultEnabled: true, supportsProgress: true },
  );

  ToolRegistry.registerDeviceAware("pinchOn", "Pinch to zoom", pinchOnSchema, pinchOnHandler, {
    defaultEnabled: false,
    supportsProgress: true,
  });

  ToolRegistry.registerDeviceAware(
    "shake",
    "Shake device; iOS Simulator only.",
    shakeSchema,
    shakeHandler,
    { defaultEnabled: false, supportsProgress: true },
  );

  ToolRegistry.registerDeviceAware(
    "keyboard",
    "Open, close, detect, list/select installed Android IMEs, or switch the AutoMobile typing profile",
    keyboardSchema,
    keyboardHandler,
    { defaultEnabled: true, outputSchema: keyboardResultSchema },
  );

  ToolRegistry.registerDeviceAware(
    "recentApps",
    "Open recent apps",
    recentAppsSchema,
    recentAppsHandler,
    { defaultEnabled: true, supportsProgress: true },
  );

  ToolRegistry.registerDeviceAware(
    "homeScreen",
    "Go to home screen",
    homeScreenSchema,
    homeScreenHandler,
    { defaultEnabled: true, supportsProgress: true },
  );

  // Register the new rotate tool
  ToolRegistry.registerDeviceAware(
    "rotate",
    "Rotate device orientation",
    rotateSchema,
    rotateHandler,
    { defaultEnabled: false, supportsProgress: true, outputSchema: rotateResultSchema },
  );

  ToolRegistry.registerDeviceAware(
    "setPosture",
    "Set Android device posture or iPhone Duo simulator posture, with an optional Resizable Android display preset. Specify exactly one of posture or hingeAngle (finite degrees, 0-180 inclusive). Hinge angle is BEST EFFORT, emulator/simulator only, without displayPreset; unsupported returns status: unsupported with a reason and no state change. Android console support is detected at call time; iOS requires a runner advertising set_hinge_angle (#8547). Angle results echo hingeAngle and device posture read-back, or unknown with postureReason. Android strictly parses emu sensor get hinge-angle0 output as hinge-angle0 = <n>; iOS uses the runner angle. Both report observedHingeAngle when available and warn without failing when the resulting angle is unavailable or differs by more than 1 degree.",
    setPostureSchema,
    setPostureHandler,
    { defaultEnabled: false, outputSchema: setPostureResultSchema },
  );

  // Register the clipboard tool
  ToolRegistry.registerDeviceAware(
    "clipboard",
    "Clipboard operations (copy/paste/clear/get)",
    clipboardSchema,
    clipboardHandler,
    { defaultEnabled: false },
  );
}
