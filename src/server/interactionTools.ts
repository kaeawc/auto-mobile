import { z } from "zod/v4";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { TapOnElement } from "../features/action/TapOnElement";
import { TapAtCoordinate } from "../features/action/TapAtCoordinate";
import { TapAnyElement } from "../features/action/TapAnyElement";
import { WakeAndUnlock } from "../features/action/WakeAndUnlock";
import { DeviceLockStore } from "../features/action/DeviceLockStore";
import { IosLockScreenUnlocker } from "../features/action/IosLockScreenUnlocker";
import { SelectAllText } from "../features/action/SelectAllText";
import { PressButton } from "../features/action/PressButton";
import { DragAndDrop } from "../features/action/DragAndDrop";
import { SwipeOn } from "../features/action/swipeon";
import { PinchOn } from "../features/action/PinchOn";
import { Shake } from "../features/action/Shake";
import { RecentApps } from "../features/action/RecentApps";
import { HomeScreen } from "../features/action/HomeScreen";
import { Rotate } from "../features/action/Rotate";
import { OpenURL } from "../features/action/OpenURL";
import { Clipboard } from "../features/action/Clipboard";
import { Keyboard } from "../features/action/Keyboard";
import { KEYBOARD_PROFILE_IDS } from "../features/action/keyboardProfiles";
import {
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
import { ListInstalledApps } from "../features/observe/ListInstalledApps";
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
import { logger } from "../utils/logger";
import {
  createJSONToolResponse,
  createStructuredToolResponse,
  StructuredToolResponse,
} from "../utils/toolUtils";
import { resolveSwipeDirection } from "../utils/swipeOnUtils";
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
import { isTruthyFlag } from "../utils/elementProperties";
import {
  createElementIdTextSelectorSchema,
  elementContainerSchema,
  elementSelectionStrategySchema,
} from "./elementSelectorSchemas";
import { tapOnResultSchema } from "./toolOutputSchemas";

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

import {
  SystemTrayObserver,
  SystemTrayAdb,
  SystemTrayDependencies,
  setSystemTrayDependencies,
  resetSystemTrayDependencies,
  getSystemTrayDependencies,
  waitForNotificationMatch,
  listSystemTrayNotifications,
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
  resolveNotificationGroupExpansionState,
  isSwipeTargetIsolatedFromGroup,
  tapElement,
  swipeElement,
  SYSTEM_TRAY_CLEAR_MAX_ITERATIONS,
  SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS,
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
  z.object({
    duration: z.number().optional().describe("Shake duration ms (default 1000)"),
    intensity: z.number().optional().describe("Shake intensity (Android; default 100)"),
    // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
    // not required — a device handle from getAndroid/getApple is sufficient on
    // its own.
    platform: platformSchema.optional(),
    ...responseShapeControlFields,
  }),
);

export const keyboardSchema = addDeviceTargetingToSchema(
  z.object({
    action: z.enum(["open", "close", "detect", "setProfile"]).describe("Keyboard action"),
    profile: z
      .enum(KEYBOARD_PROFILE_IDS)
      .optional()
      .describe("Android keyboard behavior profile; required for setProfile"),
    // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
    // not required — a device handle from getAndroid/getApple is sufficient on
    // its own.
    platform: platformSchema.optional(),
  }),
);

export async function setKeyboardProfileForTool(
  device: BootedDevice,
  profile: KeyboardArgs["profile"],
  client?: Pick<AndroidCtrlProxyClient, "supportsCommand" | "setKeyboardProfile">,
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
  if (!(await profileClient.supportsCommand("request_set_keyboard_profile"))) {
    throw new ActionableError(
      "The installed control-proxy build does not support keyboard profiles; update/re-cut the APK.",
    );
  }
  const result = await profileClient.setKeyboardProfile(profile);
  if (!result.success) {
    throw new ActionableError(result.error ?? "Failed to set keyboard profile.");
  }
  return { activeProfileId: result.activeProfileId, previousProfileId: result.previousProfileId };
}

const tapOnSelectorSchema = z
  .union([
    z
      .object({ elementId: z.string().min(1).describe("Resource ID, e.g. com.app:id/btn_login") })
      .strict(),
    z.object({ testTag: z.string().min(1).describe("Android accessibility test tag") }).strict(),
    z.object({ text: z.string().min(1).describe("Text, content-desc, or placeholder") }).strict(),
    z
      .object({
        accessibilityLink: z
          .string()
          .trim()
          .min(1)
          .describe("Exact visible text of a semantic accessibility link"),
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
    "Element to tap: elementId, Android testTag, text, semantic accessibility link, or ordered text variants",
  );

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
        sibling: z
          .boolean()
          .optional()
          .describe("Tap a clickable sibling of the match, e.g. checkbox beside label"),
        container: elementContainerSchema.optional().describe("Scope search to a container"),
        action: z
          .enum(["tap", "doubleTap", "longPress", "focus"])
          .default("tap")
          .describe("Action type (default: tap)"),
        selectionStrategy: elementSelectionStrategySchema
          .optional()
          .describe("Selection strategy when multiple match (default: first)"),
        index: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "0-based index to tap the Nth on-screen match (in hierarchy order, i.e. top-to-bottom " +
              "for a vertical list) instead of applying " +
              "selectionStrategy — for repeated controls with no unique text. Out of range → no match.",
          ),
        // A negative duration used to be accepted and silently degraded a
        // longPress into a plain tap (#5769); bound it like the sibling params.
        duration: z.number().min(0, "must be >= 0").optional().describe("Long press duration (ms)"),
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
              .describe("Polling duration (ms, default: 500)"),
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
    if (!isDirectLink && !value.subtext) {
      return;
    }
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
    addIssue(value.ensureChecked, "semantic link activation cannot ensure checked state", [
      "ensureChecked",
    ]);
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

export const tapAtSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        x: z
          .number()
          .describe("Absolute screen x coordinate in the native observe coordinate space"),
        y: z
          .number()
          .describe("Absolute screen y coordinate in the native observe coordinate space"),
        ...responseShapeControlFields,
      })
      .strict(),
  ),
  (js) => {
    js.description =
      "Tap one absolute point in the platform-native coordinate space returned by observe.";
  },
);

export const tapAnySchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        container: elementContainerSchema.optional().describe("Scope search to a container"),
        selectionStrategy: elementSelectionStrategySchema
          .optional()
          .describe("Element selection strategy: 'first' (default) or 'random'"),
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
        duration: z.number().min(0, "must be >= 0").optional().describe("Long press duration (ms)"),
        searchUntil: z
          .object({
            duration: z
              .number()
              .min(100)
              .max(12000)
              .optional()
              .describe("Polling duration (ms, default: 500)"),
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

const dragAndDropSelectorSchema = (label: "Source" | "Target") =>
  createElementIdTextSelectorSchema({
    elementId: `${label} ID`,
    text: `${label} text`,
  }).describe(`${label} element`);

const swipeOnLookForSchema = createElementIdTextSelectorSchema({
  elementId: "ID of the element to look for",
  text: "Text to look for",
});

// #6613: dragAndDrop/swipeOn/pinchOn advertised
// `additionalProperties: false` but were not `.strict()`, so an undeclared
// caller argument was silently dropped instead of rejected. Same treatment as
// tapOn/tapAny (#6154).
export const dragAndDropSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        source: dragAndDropSelectorSchema("Source"),
        target: dragAndDropSelectorSchema("Target"),
        pressDurationMs: z
          .number()
          .min(600)
          .max(3000)
          .optional()
          .describe("Press duration ms (min: 600, max: 3000, default: 600)"),
        dragDurationMs: z
          .number()
          .min(300)
          .max(1000)
          .optional()
          .describe("Drag duration ms (min: 300, max: 1000, default: 300)"),
        holdDurationMs: z
          .number()
          .min(100)
          .max(3000)
          .optional()
          .describe("Hold duration ms (min: 100, max: 3000, default: 100)"),
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
        includeSystemInsets: z
          .boolean()
          .optional()
          .describe("Use full screen including status/nav bars"),
        container: elementContainerSchema.optional().describe("Scope search to a container"),
        autoTarget: z
          .boolean()
          .optional()
          .describe("Auto-target scrollable containers (default: true)"),
        direction: z.enum(["up", "down", "left", "right"]).describe("Swipe/scroll direction"),
        gestureType: z
          .enum(["swipeFingerTowardsDirection", "scrollTowardsDirection"])
          .optional()
          .describe(
            "Finger direction or content scroll direction; default: scrollTowardsDirection",
          ),
        lookFor: swipeOnLookForSchema.optional().describe("Element to look for during swipe"),
        boomerang: z.boolean().optional().describe("Return to start position after swipe apex"),
        apexPause: z
          .number()
          .min(0)
          .max(3000)
          .optional()
          .describe("Pause duration at swipe apex in ms (0-3000)"),
        returnSpeed: z
          .number()
          .min(0.1)
          .max(3.0)
          .optional()
          .describe("Speed multiplier for return swipe (0.1-3.0)"),
        speed: z.enum(["slow", "normal", "fast"]).optional().describe("Swipe speed preset"),
        // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
        // not required — a device handle from getAndroid/getApple is sufficient on
        // its own.
        platform: platformSchema.optional(),
        ...responseShapeControlFields,
      })
      .strict(),
  ),
  (js) => compactExclusiveSelectorProperties(js, ["container", "lookFor"]),
);

export const pinchOnSchema = withJsonSchemaOverride(
  addDeviceTargetingToSchema(
    z
      .object({
        direction: z.enum(["in", "out"]).describe("Pinch direction"),
        distanceStart: z.number().optional().describe("Initial finger distance (px, default: 400)"),
        distanceEnd: z.number().optional().describe("Final finger distance (px, default: 100)"),
        scale: z.number().optional().describe("Scale factor (overrides distances)"),
        duration: z.number().optional().describe("Gesture duration (ms)"),
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
        container: elementContainerSchema.optional().describe("Scope search to a container"),
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
  z.object({
    // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
    // not required — a device handle from getAndroid/getApple is sufficient on
    // its own.
    platform: platformSchema.optional(),
    ...responseShapeControlFields,
  }),
);

export const pressButtonSchema = addDeviceTargetingToSchema(
  z.object({
    button: z.enum(["home", "back", "menu", "power", "volume_up", "volume_down", "recent"]),
    // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
    // not required — a device handle from getAndroid/getApple is sufficient on
    // its own.
    platform: platformSchema.optional(),
    ...responseShapeControlFields,
  }),
);

const systemTrayNotificationSchema = z.object({
  title: z.string().optional().describe("Notification title to match"),
  body: z.string().optional().describe("Notification body to match"),
  appId: z.string().optional().describe("App package ID to match"),
  tapActionLabel: z.string().optional().describe("Action button label to tap (for 'tap' action)"),
});

const systemTraySchemaBase = z.object({
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
});

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

const sendKeysCommandSchema = withCanonicalDiscriminatedUnionJsonSchema(
  z.discriminatedUnion("action", [
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
            "Android delivery mode. ime is an opt-in companion input method for WYSIWYG/markdown rich-text editors. iOS accepts these values for cross-platform plans and reports xcuiTypeText as the resolved mode",
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
          .max(INPUT_KEY_MODIFIERS.length)
          .optional()
          .describe("Raw-key modifier chord: shift, ctrl, alt, or meta"),
      })
      .strict(),
    z.object({ action: z.literal("clear") }).strict(),
  ]),
);

export const sendKeysSchema = addDeviceTargetingToSchema(
  z.object({
    selector: sendKeysSelectorSchema
      .optional()
      .describe("Field to focus once before executing the ordered command sequence"),
    commands: z
      .array(sendKeysCommandSchema)
      .min(1)
      .max(100)
      .describe("One to 100 commands executed serially; execution stops on the first failure"),
    // #5870: Device or session targeting resolves the platform.
    platform: platformSchema.optional(),
    ...responseShapeControlFields,
  }),
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
  z.object({
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
  }),
);

// openLink gains an optional integrated waitFor (issue #3490 §5): after opening
// the URL, poll for the predicate — reusing observe's waitFor/settled schema and
// semantics — so the open→settle→observe→verify workaround collapses into one call.
export const openLinkSchema = withAppIdAliases(
  withJsonSchemaOverride(
    addDeviceTargetingToSchema(
      z.object({
        url: z.string().describe("URL to open"),
        acceptOpenAlert: z
          .boolean()
          .optional()
          .describe("On iOS, automatically tap Open when a system 'Open in <app>?' alert appears"),
        // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
        // not required — a device handle from getAndroid/getApple is sufficient on
        // its own.
        platform: platformSchema.optional(),
        waitFor: waitForSchema
          .optional()
          .describe("After opening, wait for this predicate before returning the observation"),
        settled: settledSchema
          .optional()
          .describe("After waitFor matches, wait for a quiet hierarchy period (requires waitFor)"),
        ...responseShapeControlFields,
      }),
    ).superRefine(refineWaitForArgs),
    overrideWaitForJsonSchema,
  ),
);

/** Outcome of a post-open waitFor poll, as produced by {@link waitForObservation}. */
export type OpenLinkWaitOutcome = WaitForObservationOutcome;

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
  if (!waitOutcome) {
    return {
      message: `Opened link ${url}`,
      ...openResult,
      observation: openResult.observation,
    };
  }
  return {
    message: `Opened link ${url}`,
    ...openResult,
    observation: waitOutcome.observation,
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
  };
};

export const recentAppsSchema = addDeviceTargetingToSchema(
  z.object({
    // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
    // not required — a device handle from getAndroid/getApple is sufficient on
    // its own.
    platform: platformSchema.optional(),
    ...responseShapeControlFields,
  }),
);

export const homeScreenSchema = addDeviceTargetingToSchema(
  z.object({
    // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
    // not required — a device handle from getAndroid/getApple is sufficient on
    // its own.
    platform: platformSchema.optional(),
    ...responseShapeControlFields,
  }),
);

export const rotateSchema = addDeviceTargetingToSchema(
  z.object({
    orientation: z.enum(["portrait", "landscape"]),
    lockOrientation: z
      .boolean()
      .optional()
      .describe(
        "Android only. true keeps the requested orientation locked after rotation; false explicitly restores automatic rotation after a persistent request. Omit to preserve the existing behavior.",
      ),
    // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
    // not required — a device handle from getAndroid/getApple is sufficient on
    // its own.
    platform: platformSchema.optional(),
    ...responseShapeControlFields,
  }),
);

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
    z.object({
      action: z.literal("copy").describe("Clipboard action"),
      text: z
        .string({ error: clipboardTextRequiredMessage })
        .min(1, clipboardTextRequiredMessage)
        .describe("Text to copy (required for 'copy' action)"),
      ...clipboardPlatformSchema,
    }),
  ),
  addDeviceTargetingToSchema(
    z.object({
      action: z.literal("paste").describe("Clipboard action"),
      text: optionalClipboardTextSchema,
      ...clipboardPlatformSchema,
    }),
  ),
  addDeviceTargetingToSchema(
    z.object({
      action: z.literal("clear").describe("Clipboard action"),
      text: optionalClipboardTextSchema,
      ...clipboardPlatformSchema,
    }),
  ),
  addDeviceTargetingToSchema(
    z.object({
      action: z.literal("get").describe("Clipboard action"),
      text: optionalClipboardTextSchema,
      ...clipboardPlatformSchema,
    }),
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
): Promise<StructuredToolResponse<SwipeOnToolPayload> & { isError?: true }> {
  RecompositionTracker.getInstance().recordInteraction();
  const swipeOn = swipeOnFactory(device);
  const resolvedDirection = resolveSwipeDirection({
    direction: args.direction,
    gestureType: args.gestureType,
  });
  const result = await swipeOn.execute(
    {
      container: args.container,
      autoTarget: args.autoTarget ?? true,
      direction: resolvedDirection.direction,
      lookFor: args.lookFor,
      speed: args.speed,
      includeSystemInsets: args.includeSystemInsets ?? false,
      boomerang: args.boomerang,
      apexPause: args.apexPause,
      returnSpeed: args.returnSpeed,
    },
    progress,
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
) {
  RecompositionTracker.getInstance().recordInteraction();
  const pinchOn = pinchOnFactory(device);
  const result = await pinchOn.execute(
    {
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
  const attributes =
    node.$ && typeof node.$ === "object" && !Array.isArray(node.$)
      ? (node.$ as Record<string, unknown>)
      : undefined;
  return node[key] ?? attributes?.[key];
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
  const hasFreshnessTimestamp =
    typeof freshness?.requestedAfter === "number" && typeof freshness?.actualTimestamp === "number";
  const hasConfirmedFreshObservation =
    hasFreshnessTimestamp && freshness.actualTimestamp >= freshness.requestedAfter;
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
) {
  RecompositionTracker.getInstance().recordInteraction();
  const tapOnTextCommand = tapOnElementFactory(device);
  const result = await tapOnTextCommand.execute(
    {
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
  );

  const searchSummary = buildTapOnSearchSummary(result, Boolean(args.searchUntil));

  // A selector miss must not read as a completed tap: gate the message on the
  // outcome and mark the MCP envelope `isError`, exactly as other action tools do since
  // #5902 (#6152). `||` not `??`: an empty-string error must still yield the
  // non-empty fallback (#4183 P4). The failure keeps the search summary so the
  // user still sees how long the selector was looked for before it missed.
  const message = result.success
    ? buildTapOnSuccessMessage(result, searchSummary, args.ensureChecked)
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
) {
  RecompositionTracker.getInstance().recordInteraction();
  const result = await tapAtElementFactory(device).execute({ x: args.x, y: args.y }, progress);
  const message = result.success
    ? `Tapped at (${result.x}, ${result.y})`
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
) {
  RecompositionTracker.getInstance().recordInteraction();
  const tapAnyCommand = tapAnyElementFactory(device);
  const result = await tapAnyCommand.execute(
    {
      container: args.container,
      selectionStrategy: args.selectionStrategy,
      scrollableContainer: args.scrollableContainer,
      action: args.action,
      duration: args.duration,
      searchUntil: args.searchUntil,
    },
    progress,
  );

  const searchSummary = buildTapAnySearchSummary(result);
  // A miss must not read as a completed tap: gate the message on the outcome
  // and mark the MCP envelope `isError`, exactly as tapOn does (#6152, #6163).
  const message = result.success
    ? searchSummary
      ? `Tapped clickable element (${searchSummary})`
      : "Tapped clickable element"
    : `Failed to tap clickable element: ${result.error || "unknown error"}`;
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
) {
  RecompositionTracker.getInstance().recordInteraction();
  const dragAndDrop = dragAndDropFactory(device);
  const result: DragAndDropResult = await dragAndDrop.execute(
    {
      source: args.source,
      target: args.target,
      pressDurationMs: args.pressDurationMs,
      dragDurationMs: args.dragDurationMs,
      holdDurationMs: args.holdDurationMs,
    },
    progress,
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
) {
  try {
    const selectAllText = selectAllTextFactory(device);
    const result: SelectAllTextResult = await selectAllText.execute(progress);

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
    throw new ActionableError(`Failed to select all text: ${error}`);
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
) {
  RecompositionTracker.getInstance().recordInteraction();
  try {
    const pressButton = pressButtonFactory(device);
    const result: PressButtonResult = await pressButton.execute(args.button, progress);

    const message = result.success
      ? `Pressed button ${args.button}`
      : `Failed to press button ${args.button}: ${result.error || "unknown error"}`;
    const response = createJSONToolResponse({
      message,
      observation: result.observation,
      ...result,
    });
    return result.success ? response : { ...response, isError: true as const };
  } catch (error) {
    throw new ActionableError(`Failed to press button: ${error}`);
  }
}

// Injection seam for the rotate handler. In particular, persistent-orientation
// failures must reach MCP clients as errors rather than success-shaped results.
export type RotateLike = Pick<Rotate, "execute">;

let rotateFactory: (device: BootedDevice) => RotateLike = (device) => new Rotate(device);

export function setRotateFactory(factory: (device: BootedDevice) => RotateLike): void {
  rotateFactory = factory;
}

export function resetRotateFactory(): void {
  rotateFactory = (device) => new Rotate(device);
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
) {
  try {
    if (args.lockOrientation !== undefined && device.platform !== "android") {
      throw new ActionableError("lockOrientation is supported only on Android devices.");
    }
    const rotate = rotateFactory(device);
    const result = await rotate.execute(args.orientation, progress, args.lockOrientation);
    const response = createJSONToolResponse({
      observation: result.observation,
      ...result,
      message: formatRotateMessage(result),
    });
    return result.success ? response : { ...response, isError: true as const };
  } catch (error) {
    throw new ActionableError(`Failed to rotate device: ${error}`);
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

// ============================================================================
// Tool Registration
// ============================================================================

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
    try {
      const awaitTimeoutMs = resolveSystemTrayAwaitTimeout(args.awaitTimeout);

      if (args.action === "open") {
        const result = await ensureSystemTrayOpen(device, awaitTimeoutMs, progress);
        await captureSystemTrayTerminalEvidence(device, result.observation);
        return createJSONToolResponse({
          message: result.skipped
            ? "System tray already open; no swipe needed"
            : "Opened system tray by swiping down from the status bar",
          observation: result.observation,
          success: true,
          skipped: result.skipped,
        });
      }

      if (args.action === "close") {
        const result = await ensureSystemTrayClosed(device, awaitTimeoutMs, progress);
        await captureSystemTrayTerminalEvidence(device, result.observation);
        return createJSONToolResponse({
          message: result.skipped
            ? "System tray already closed; no collapse needed"
            : "Closed system tray (collapsed notification shade)",
          observation: result.observation,
          success: true,
          skipped: result.skipped,
        });
      }

      if (args.action === "list") {
        if (device.platform !== "android") {
          throw new ActionableError("systemTray list is supported only on Android.");
        }
        const appId = args.notification?.appId;
        if (!appId) {
          throw new ActionableError("list action requires notification.appId");
        }
        signal?.throwIfAborted();
        const inventory = await getSystemTrayDependencies()
          .appInventoryFactory(device)
          .executeDetailedResult(signal);
        signal?.throwIfAborted();
        if (!inventory.successful) {
          throw new ActionableError(
            "Cannot verify notification ownership because the installed-app inventory is incomplete.",
          );
        }
        const appIds = [
          ...new Set(
            [...Object.values(inventory.apps.profiles).flat(), ...inventory.apps.system].map(
              (app) => app.packageName,
            ),
          ),
        ];
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
        await captureSystemTrayTerminalEvidence(device, result.observation);
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
        const listInstalledApps = new ListInstalledApps(device);
        installedApps = await listInstalledApps.execute();
        if (!installedApps.includes(notification.appId)) {
          throw new ActionableError(`App ${notification.appId} is not installed.`);
        }

        appLabel = await getSystemTrayDependencies().appLabelResolver(
          device,
          notification.appId,
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
        );

        if (!match) {
          throw new ActionableError(`Notification not found after ${awaitTimeoutMs}ms.`);
        }

        await captureSystemTrayTerminalEvidence(device, observation);
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
          { observation: initialMatch.observation, match: initialMatch.match },
        );

        const tapMatch = resolveNotificationTapElement(match, notification);
        if (!tapMatch) {
          throw new ActionableError(
            "No notification tap target was resolved within the matched notification.",
          );
        }

        await tapElement(device, tapMatch.element);
        const { observation: nextObservation, settled } = await observeSystemTrayAfterTap(
          device,
          baseline,
          signal,
        );
        await captureSystemTrayTerminalEvidence(device, nextObservation);

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
        );

        if (!initialMatch.match) {
          throw new ActionableError(`Notification not found after ${awaitTimeoutMs}ms.`);
        }

        const { match } = await expandAndRematchIfCollapsed(
          device,
          notification,
          appMatchTexts,
          actionStartMs + awaitTimeoutMs,
          progress,
          { observation: initialMatch.observation, match: initialMatch.match },
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

        await swipeElement(device, swipeTarget);
        const { observeScreenFactory } = getSystemTrayDependencies();
        const observeScreen = observeScreenFactory(device);
        const nextObservation = await observeScreen.execute({
          skipScreenshot: true,
          skipAccessibilityAudit: true,
        });
        await captureSystemTrayTerminalEvidence(device, nextObservation);

        return createJSONToolResponse({
          message: "Dismissed notification",
          match: match.match.matches,
          observation: nextObservation,
          success: true,
        });
      }

      if (args.action === "clearAll") {
        let swipeCount = 0;
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
        const { timer } = getSystemTrayDependencies();

        for (let i = 0; i < SYSTEM_TRAY_CLEAR_MAX_ITERATIONS; i++) {
          const { match } = await waitForNotificationMatch(
            device,
            notification,
            clearMatchTexts,
            500,
            progress,
          );

          if (!match) {
            break;
          }

          const swipeTarget = resolveNotificationSwipeElement(match, notification, clearMatchTexts);
          if (!swipeTarget) {
            break;
          }

          await swipeElement(device, swipeTarget);
          swipeCount++;
          await timer.sleep(SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS + 100);
        }

        const remainingKeys =
          expectedKeys === undefined || !notification.appId
            ? undefined
            : await readRequiredActiveNotificationKeys(device, notification.appId, "after", signal);

        const { observeScreenFactory } = getSystemTrayDependencies();
        const observeScreen = observeScreenFactory(device);
        const nextObservation = await observeScreen.execute({
          skipScreenshot: true,
          skipAccessibilityAudit: true,
        });
        await captureSystemTrayTerminalEvidence(device, nextObservation);

        const result = formatClearAllResult(
          notification.appId,
          swipeCount,
          expectedKeys && remainingKeys ? { expectedKeys, remainingKeys } : undefined,
        );
        return createJSONToolResponse({
          ...result,
          observation: nextObservation,
        });
      }

      throw new ActionableError(`Unknown systemTray action: ${args.action}`);
    } catch (error) {
      if (error instanceof ActionableError) {
        throw error;
      }
      throw new ActionableError(`systemTray failed: ${error}`);
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
    RecompositionTracker.getInstance().recordInteraction();
    const sendKeys = new SendKeys(device);
    const result = await sendKeys.execute(args.commands, args.selector, progress, signal);
    const response = createJSONToolResponse({
      message: result.success
        ? `Executed ${result.completedCommands} sendKeys command(s)`
        : `sendKeys stopped at command ${result.failedIndex}: ${result.error}`,
      ...result,
    });
    return result.success ? response : { ...response, isError: true };
  };

  // Wake and unlock handler
  const wakeAndUnlockHandler = async (device: BootedDevice, args: WakeAndUnlockArgs) => {
    const iosUnlocker = device.platform === "ios" ? new IosLockScreenUnlocker(device) : undefined;
    const wakeAndUnlock = new WakeAndUnlock(device, undefined, {
      credentialStore: new DeviceLockStore(),
      iosUnlocker,
    });
    const result = await wakeAndUnlock.execute(args.pin);
    const message = result.success
      ? result.wasLocked
        ? "Device unlocked"
        : "Device awake"
      : `Failed to unlock device: ${result.error ?? "unknown error"}`;
    return createJSONToolResponse({ message, ...result });
  };

  // Open link handler
  const openLinkHandler = async (
    device: BootedDevice,
    args: OpenLinkArgs,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    // #6154 follow-up: `platform` is optional on the wire, so the schema's
    // iOS-rejects-activityName check (raw request platform) can be skipped
    // entirely when the caller omitted it. Re-validate against the resolved
    // `device.platform` before opening the URL.
    assertActiveWindowWaitForSupportedOnPlatform(device.platform, args.waitFor);

    const openUrl = new OpenURL(device);
    const result = await openUrl.execute(args.url);
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
                    signal,
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
        )
      : null;

    return createJSONToolResponse(buildOpenLinkPayload(args.url, effectiveResult, waitOutcome));
  };

  // Shake handler
  const shakeHandler = async (
    device: BootedDevice,
    args: ShakeArgs,
    progress?: ProgressCallback,
  ) => {
    try {
      const shake = new Shake(device);
      const result = await shake.execute(
        {
          duration: args.duration ?? 1000,
          intensity: args.intensity ?? 100,
        },
        progress,
      );

      return createJSONToolResponse({
        message: result.success
          ? `Shook device for ${args.duration ?? 1000}ms with intensity ${args.intensity ?? 100}`
          : `Failed to shake device: ${result.error ?? "unknown error"}`,
        observation: result.observation,
        ...result,
      });
    } catch (error) {
      throw new ActionableError(`Failed to shake device: ${error}`);
    }
  };

  // Keyboard handler
  const keyboardHandler = async (device: BootedDevice, args: KeyboardArgs) => {
    try {
      if (args.action === "setProfile") {
        return createJSONToolResponse(await setKeyboardProfileForTool(device, args.profile));
      }
      const keyboard = new Keyboard(device);
      const result = await keyboard.execute(args.action);

      return createJSONToolResponse(result);
    } catch (error) {
      throw new ActionableError(`Failed to execute keyboard ${args.action}: ${error}`);
    }
  };

  // Recent Apps handler
  const recentAppsHandler = async (
    device: BootedDevice,
    args: RecentAppsArgs,
    progress?: ProgressCallback,
  ) => {
    try {
      const recentApps = new RecentApps(device);
      const result = await recentApps.execute(progress);

      return createJSONToolResponse({
        message: formatRecentAppsMessage(result),
        observation: result.observation,
        ...result,
      });
    } catch (error) {
      throw new ActionableError(`Failed to open recent apps: ${error}`);
    }
  };

  // Home Screen handler
  const homeScreenHandler = async (
    device: BootedDevice,
    args: any,
    progress?: ProgressCallback,
  ) => {
    try {
      const homeScreen = new HomeScreen(device);
      const result = await homeScreen.execute(progress);

      return createJSONToolResponse({
        message: "Pressed home button to return to the home screen",
        observation: result.observation,
        ...result,
      });
    } catch (error) {
      throw new ActionableError(`Failed to go to home screen: ${error}`);
    }
  };

  // Clipboard handler
  const clipboardHandler = async (device: BootedDevice, args: ClipboardArgs) => {
    try {
      const clipboard = new Clipboard(device);
      const result = await clipboard.execute(args.action, args.text);

      let message = formatClipboardMessage(result);

      if (result.method) {
        message += ` (via ${result.method})`;
      }

      return createJSONToolResponse({
        message,
        ...result,
      });
    } catch (error) {
      throw new ActionableError(`Failed to execute clipboard ${args.action}: ${error}`);
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
    "Press device or navigation button",
    pressButtonSchema,
    pressButtonHandler,
    { defaultEnabled: true, supportsProgress: true },
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
    "Execute an ordered sequence of text insertion/replacement, clear, raw keys, and semantic IME keys.",
    sendKeysSchema,
    sendKeysHandler,
    { defaultEnabled: true, supportsProgress: true },
  );

  ToolRegistry.registerDeviceAware(
    "wakeAndUnlock",
    "Wake a device and unlock its keyguard. Android: swipe lock or secure PIN via `pin`; iOS: wake + swipe-dismiss (pin ignored).",
    wakeAndUnlockSchema,
    wakeAndUnlockHandler,
    { defaultEnabled: true },
  );

  ToolRegistry.registerDeviceAware(
    "openLink",
    "Open URL in browser",
    openLinkSchema,
    openLinkHandler,
    { defaultEnabled: false },
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
    "Tap one absolute platform-native screen coordinate visible through observe.",
    tapAtSchema,
    tapAtHandler,
    { defaultEnabled: true, supportsProgress: true },
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
    "Open, close, detect, or switch the on-screen keyboard profile",
    keyboardSchema,
    keyboardHandler,
    { defaultEnabled: true },
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
    { defaultEnabled: false, supportsProgress: true },
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
