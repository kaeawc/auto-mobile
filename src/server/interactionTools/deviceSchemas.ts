import { z } from "zod/v4";
import { MAX_ROTARY_STEPS, ROTARY_BUTTONS } from "../../features/action/RotaryInput";
import { KEYBOARD_PROFILE_IDS } from "../../features/action/keyboardProfiles";
import { HINGE_ANGLE_MAX_DEGREES, HINGE_ANGLE_MIN_DEGREES } from "../../features/device/SetPosture";
import { hierarchyLayerSchema } from "../../models/elementSelectorSchemas";
import {
  SHAKE_DURATION_MAX_MS,
  SHAKE_DURATION_MIN_MS,
  SHAKE_INTENSITY_MAX,
  SHAKE_INTENSITY_MIN,
} from "../../models/ShakeOptions";
import {
  addDeviceTargetingToSchema,
  appIdFieldAliases,
  platformSchema,
  watchAwarePlatformSchema,
  responseShapeControlFields,
  withAppIdAliases,
  withJsonSchemaOverride,
} from "../../utils/schemaHelpers";
import {
  overrideWaitForJsonSchema,
  refineWaitForArgs,
  settledSchema,
  waitForSchema,
} from "../observeTools";

// ============================================================================
// Schema Definitions
// ============================================================================

export const shakeInput = z.object({
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
});

export const keyboardInput = z.object({
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
});

/** Keyboard actions that change no UI (#10965): reads, allowed without holding the device. */
export { KEYBOARD_READ_ACTIONS } from "../interactionToolTypes";

export const selectAllTextInput = z.object({
  layer: hierarchyLayerSchema.optional(),
  // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
  // not required — a device handle from getAndroid/getApple is sufficient on
  // its own.
  platform: platformSchema.optional(),
  ...responseShapeControlFields,
});

export const pressButtonInput = z.object({
  button: z.enum([
    "up",
    "down",
    "left",
    "right",
    "select",
    "playPause",
    "home",
    "back",
    "menu",
    "power",
    "volume_up",
    "volume_down",
    "recent",
    "action",
    "camera",
    // Android system actions (#14095); a CtrlProxy/API that lacks one refuses it.
    "lock",
    "power_dialog",
    "quick_settings",
    "screenshot",
    "split_screen",
    "dismiss_notification_shade",
    // Rotary controller input on Android Automotive (#14920); refused on other devices.
    ...ROTARY_BUTTONS,
  ]),
  steps: z
    .number()
    .int()
    .min(1)
    .max(MAX_ROTARY_STEPS)
    .optional()
    .describe("Detents for rotary_rotate_cw / rotary_rotate_ccw (default 1)."),
  // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
  // not required — a device handle from getAndroid/getApple is sufficient on
  // its own.
  platform: watchAwarePlatformSchema(),
  ...responseShapeControlFields,
});

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

export const wakeAndUnlockInput = z.object({
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
});

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

export const recentAppsInput = z.object({
  // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
  // not required — a device handle from getAndroid/getApple is sufficient on
  // its own.
  platform: platformSchema.optional(),
  ...responseShapeControlFields,
});

export const homeScreenInput = z.object({
  // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
  // not required — a device handle from getAndroid/getApple is sufficient on
  // its own.
  platform: platformSchema.optional(),
  ...responseShapeControlFields,
});

export const rotateInput = z.object({
  orientation: z.enum(["portrait", "landscape"]),
  lockOrientation: z
    .boolean()
    .optional()
    .describe(
      "Android only. true keeps automatic rotation off to hold the requested orientation. Omission restores the prior automatic-rotation setting after orientation confirmation, including in a device session; an unreadable initial setting is left unchanged. false enables automatic rotation, even if originally locked; in a session it also restores original user_rotation. orientationLockState reports the confirmed lock.",
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
});

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
