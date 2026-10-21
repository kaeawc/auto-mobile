import { z } from "zod/v4";
import { PLAN_RELEVANT } from "./toolRegistryTypes";
import { displayConfigResultSchema } from "./utilityToolOutputSchemas";
import { recordDeviceSettingDefaultsBeforeChange } from "../features/utility/DeviceSettingDefaults";
import type { DeviceSettingKey } from "../models/DeviceSettingDefaults";
import {
  DisplayConfig,
  MAX_ANDROID_DENSITY_DPI,
  MIN_ANDROID_DENSITY_DPI,
  type DisplayConfigResult,
  type SetDisplayConfigInput,
} from "../features/utility/DisplayConfig";
import {
  ACCESSIBILITY_DISPLAY_FIELDS,
  COLOR_CORRECTION_MODES,
} from "../features/utility/AccessibilityDisplayPreferences";
import { createStructuredToolResponse } from "../utils/toolUtils";
import type { BootedDevice } from "../models";
import { addDeviceTargetingToSchema } from "../utils/schemaHelpers";

// Display configuration (issue #6096): font scale, effective density, and
// light/dark theme. A call with no set field is a getter; any set field (or
// `reset`) makes it a setter that returns applied + previous values so the
// client can restore. Android supports all three fields; the iOS Simulator
// supports theme only (via `simctl ui appearance`); physical iOS has no
// automatable per-device control for any field. increaseContrast, reduceMotion
// and boldText (#14088) are accessibility display preferences on both platforms.
export const displayConfigSchema = addDeviceTargetingToSchema(
  z
    .object({
      fontScale: z
        .union([z.number().min(0.1).max(10), z.literal("default")])
        .optional()
        .describe(
          "System text scale, or 'default' to remove Android's explicit override and restore " +
            "its inherited default. Android only. Omit to leave unchanged.",
        ),
      density: z
        .union([
          z.number().min(MIN_ANDROID_DENSITY_DPI).max(MAX_ANDROID_DENSITY_DPI),
          z.enum(["smaller", "default", "larger"]),
        ])
        .optional()
        .describe(
          "Effective display density: an explicit dpi (e.g. 480), or a relative bucket " +
            `(smaller/default/larger). Numeric values must be ${MIN_ANDROID_DENSITY_DPI}-${MAX_ANDROID_DENSITY_DPI} dpi. ` +
            "Android only; best-effort on physical devices. Omit to leave unchanged.",
        ),
      theme: z
        .enum(["light", "dark", "system", "custom"])
        .optional()
        .describe(
          "Light, dark, system (follow-device), or custom (Android user-defined night-mode " +
            "schedule) theme / night mode. Supported on Android; the iOS Simulator supports only " +
            "'light'/'dark'. 'custom' mainly exists to restore a device previously on a custom " +
            "schedule (from an earlier call's `previous.theme`). Omit to leave unchanged.",
        ),
      increaseContrast: z
        .boolean()
        .optional()
        .describe(
          "Increase Contrast. Android: high-contrast text (secure high_text_contrast_enabled). " +
            "iOS Simulator: `simctl ui increase_contrast`. Omit to leave unchanged.",
        ),
      reduceMotion: z
        .boolean()
        .optional()
        .describe(
          "Reduce Motion. Android: Remove animations (all three animation scales 0; false " +
            "restores the scales replaced earlier, else 1). iOS Simulator: partial, written to " +
            "com.apple.Accessibility defaults; relaunch the app to observe. Omit to leave unchanged.",
        ),
      boldText: z
        .boolean()
        .optional()
        .describe(
          "Bold Text. Android API 31+: secure font_weight_adjustment 300. iOS Simulator: partial, " +
            "written to com.apple.Accessibility defaults; relaunch the app to observe. Omit to leave unchanged.",
        ),
      colorInversion: z
        .boolean()
        .optional()
        .describe("Android: color inversion (secure accessibility_display_inversion_enabled)."),
      colorCorrection: z
        .enum(COLOR_CORRECTION_MODES)
        .optional()
        .describe(
          "Android: color correction (daltonizer) mode, or 'off'. 'grayscale' is monochromacy.",
        ),
      magnification: z
        .boolean()
        .optional()
        .describe(
          "Android: enable the triple-tap magnification gesture. Enabling it does not zoom the " +
            "screen until the gesture is performed.",
        ),
      magnificationScale: z
        .number()
        .min(1)
        .max(8)
        .optional()
        .describe("Android: the magnification gesture's zoom factor (AOSP default 2)."),
      extraDim: z
        .boolean()
        .optional()
        .describe("Android API 31+: Extra dim (secure reduce_bright_colors_activated)."),
      reset: z
        .boolean()
        .optional()
        .describe(
          "On Android, restore font scale and density to device defaults. Restore night mode only " +
            "to the value displayConfig replaced earlier in this process; otherwise leave it unchanged. " +
            "Android reset never forces light mode. On the iOS Simulator, reset restores light appearance. " +
            "On both, restore each accessibility display preference that displayConfig " +
            "changed earlier in this process.",
        ),
    })
    .strict(),
).superRefine((values, ctx) => {
  if (values.reset === true && displayConfigFieldsPresent(values)) {
    ctx.addIssue({
      code: "custom",
      path: ["reset"],
      message:
        "reset cannot be combined with an explicit display field or accessibility display " +
        "preference; send reset on its own.",
    });
  }
});

/** The displayConfig set fields; a call carrying none (and no reset) is a read. */
const DISPLAY_CONFIG_SET_FIELDS = [
  "fontScale",
  "density",
  "theme",
  "increaseContrast",
  "reduceMotion",
  "boldText",
  "colorInversion",
  "colorCorrection",
  "magnification",
  "magnificationScale",
  "extraDim",
] as const;

function displayConfigFieldsPresent(
  values: Partial<Record<(typeof DISPLAY_CONFIG_SET_FIELDS)[number], unknown>>,
): boolean {
  return DISPLAY_CONFIG_SET_FIELDS.some((field) => values[field] !== undefined);
}

export type DisplayConfigArgs = z.infer<typeof displayConfigSchema>;

/** A displayConfig call is a setter when it carries reset or any display field. */
function displayConfigArgsAreSet(args: DisplayConfigArgs): boolean {
  return args.reset === true || displayConfigFieldsPresent(args);
}

/** Project the wire args onto the feature's set-input shape, dropping absent fields. */
function displayConfigSetInput(args: DisplayConfigArgs): SetDisplayConfigInput {
  return {
    ...(args.fontScale !== undefined ? { fontScale: args.fontScale } : {}),
    ...(args.density !== undefined ? { density: args.density } : {}),
    ...(args.theme !== undefined ? { theme: args.theme } : {}),
    ...accessibilityArgs(args),
    ...(args.reset !== undefined ? { reset: args.reset } : {}),
  };
}

/** The accessibility display preferences present in the wire args. */
function accessibilityArgs(args: DisplayConfigArgs): Partial<SetDisplayConfigInput> {
  return Object.fromEntries(
    ACCESSIBILITY_DISPLAY_FIELDS.filter((field) => args[field] !== undefined).map((field) => [
      field,
      args[field],
    ]),
  );
}

function displayConfigMessage(result: DisplayConfigResult): string {
  if (result.success) {
    return result.applied ? "Applied display configuration" : "Read display configuration";
  }
  return result.error ?? "Failed to apply display configuration";
}

/** A call with no set field reads (#10965); any set field or reset is control. */
function isDisplayConfigRead(args: DisplayConfigArgs): boolean {
  return !displayConfigArgsAreSet(args);
}

export const displayConfigToolOptions = {
  ...PLAN_RELEVANT,
  defaultEnabled: false,
  deviceReadOnly: isDisplayConfigRead,
  deviceReadOnlyArgs: [{ absentArguments: ["reset", ...DISPLAY_CONFIG_SET_FIELDS] }],
  outputSchema: displayConfigResultSchema,
};

/** The device settings a displayConfig call may change (#11145). */
function displayConfigChangedSettings(args: DisplayConfigArgs): DeviceSettingKey[] {
  if (args.reset === true) {
    return ["fontScale", "density", "nightMode", ...ACCESSIBILITY_DISPLAY_FIELDS];
  }
  return [
    ...(args.fontScale !== undefined ? (["fontScale"] as const) : []),
    ...(args.density !== undefined ? (["density"] as const) : []),
    ...(args.theme !== undefined ? (["nightMode"] as const) : []),
    ...ACCESSIBILITY_DISPLAY_FIELDS.filter((field) => args[field] !== undefined),
  ];
}

export const displayConfigHandler = async (device: BootedDevice, args: DisplayConfigArgs) => {
  const displayConfig = new DisplayConfig(device);
  if (displayConfigArgsAreSet(args)) {
    await recordDeviceSettingDefaultsBeforeChange(device, displayConfigChangedSettings(args));
  }
  const result = displayConfigArgsAreSet(args)
    ? await displayConfig.setConfig(displayConfigSetInput(args))
    : await displayConfig.getConfig();
  const response = createStructuredToolResponse({
    message: displayConfigMessage(result),
    ...result,
  });
  return result.success ? response : { ...response, isError: true as const };
};

export const DISPLAY_CONFIG_DESCRIPTION =
  "Read or set the visual display configuration — font/text scale, effective display density, and light/dark (night mode) theme — for adaptive-layout and large-font accessibility testing. A call with no set field reads current values; providing fontScale, density, theme, or reset applies the change and returns applied + previous values so the client can restore. Android supports all three fields (density overrides are best-effort on physical devices); iOS supports theme only (the Simulator via `simctl ui appearance`, physical devices through the CtrlProxy runner). On Android, reset restores font scale and density to device defaults and restores night mode only to the value displayConfig replaced earlier in this process; otherwise night mode is left unchanged. Android reset never forces light mode. iOS Simulator reset restores light appearance; physical iOS reset restores the appearance displayConfig first replaced there (light if none). The accessibility display preferences increaseContrast, reduceMotion and boldText are read and set on Android and the iOS Simulator, and colorInversion, colorCorrection, magnification, magnificationScale and extraDim (API 31+) on Android; `supported` reports each as true (proven by read-back), partial (stored setting reads back but running apps must relaunch; reason in supportNotes) or false, and reset restores the ones displayConfig changed.";
