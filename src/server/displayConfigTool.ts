import { z } from "zod/v4";
import { PLAN_RELEVANT } from "./toolRegistryTypes";
import { displayConfigResultSchema } from "./utilityToolOutputSchemas";
import {
  runSessionDisplayProfileMutation,
  type SessionDisplayProfileHost,
} from "./sessionDisplayProfile";
import { recordDeviceSettingDefaultsBeforeChange } from "../features/utility/DeviceSettingDefaults";
import type { DeviceSettingKey } from "../models/DeviceSettingDefaults";
import {
  DisplayConfig,
  MAX_ANDROID_DENSITY_DPI,
  MIN_ANDROID_DENSITY_DPI,
  type DisplayConfigDependencies,
  type DisplayConfigResult,
  type SetDisplayConfigInput,
} from "../features/utility/DisplayConfig";
import {
  DISPLAY_CUTOUTS,
  MAX_ANDROID_DISPLAY_SIDE_PX,
  MIN_ANDROID_DISPLAY_SIDE_PX,
  NAVIGATION_MODES,
} from "../features/utility/androidDisplayGeometryCommands";
import { DISPLAY_GEOMETRY_FIELDS } from "../features/utility/AndroidDisplayGeometry";
import { resolvePrototypeDisplayId } from "../features/prototype/prototypeDisplay";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { defaultDaemonContext } from "../daemon/daemonContext";
import {
  ACCESSIBILITY_DISPLAY_FIELDS,
  COLOR_CORRECTION_MODES,
} from "../features/utility/AccessibilityDisplayPreferences";
import { IOS_CONTENT_SIZE_CATEGORIES } from "../features/utility/IosSimulatorDisplayConfig";
import { createStructuredToolResponse } from "../utils/toolUtils";
import type { BootedDevice } from "../models";
import { addDeviceTargetingToSchema } from "../utils/schemaHelpers";

// Display configuration (issue #6096): font scale, effective density, and
// light/dark theme. A call with no set field is a getter; any set field (or
// `reset`) makes it a setter that returns applied + previous values so the
// client can restore. Android supports all three fields; the iOS Simulator
// supports theme (`simctl ui appearance`) and font scale as a Dynamic Type
// category (`simctl ui content_size`, #14087); physical iOS has no
// automatable per-device control for any field. increaseContrast, reduceMotion
// and boldText (#14088) are accessibility display preferences on both platforms. Android also
// takes a runtime screen size, navigation mode and display-cutout emulation (#14101).
const displaySideSchema = z
  .number()
  .int()
  .min(MIN_ANDROID_DISPLAY_SIDE_PX)
  .max(MAX_ANDROID_DISPLAY_SIDE_PX);

export const displayConfigSchema = addDeviceTargetingToSchema(
  z
    .object({
      fontScale: z
        .union([z.number().min(0.1).max(10), z.literal("default")])
        .optional()
        .describe(
          "System text scale, or 'default' to remove Android's explicit override and restore " +
            "its inherited default. On the iOS Simulator, selects the nearest Dynamic Type " +
            "category (1 = large; 'default' = large). Omit to leave unchanged.",
        ),
      contentSize: z
        .enum(IOS_CONTENT_SIZE_CATEGORIES)
        .optional()
        .describe(
          "iOS Simulator only: an exact Dynamic Type category for `simctl ui content_size`, " +
            "instead of the nearest one to fontScale. Cannot be combined with fontScale. " +
            "Omit to leave unchanged.",
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
      size: z
        .union([
          z.object({ width: displaySideSchema, height: displaySideSchema }).strict(),
          z.literal("default"),
        ])
        .optional()
        .describe(
          "Android: override the screen size in pixels, natural orientation (`wm size WxH`), or " +
            `'default' to remove the override. Each side must be ${MIN_ANDROID_DISPLAY_SIDE_PX} px ` +
            "to twice the physical size. Best-effort on physical devices. Omit to leave unchanged.",
        ),
      navigationMode: z
        .enum([...NAVIGATION_MODES, "default"])
        .optional()
        .describe(
          "Android: gesture, threeButton or twoButton navigation via the system image's navbar " +
            "overlay (`cmd overlay enable-exclusive --category`); 'default' disables every navbar " +
            "overlay. Values the image does not ship are refused; read `available`. Omit to leave unchanged.",
        ),
      displayCutout: z
        .enum(["none", ...DISPLAY_CUTOUTS])
        .optional()
        .describe(
          "Android: emulate a display cutout via the system image's cutout-emulation overlay, or " +
            "'none' to disable it. Values the image does not ship are refused; read `available`. " +
            "Omit to leave unchanged.",
        ),
      display: z
        .string()
        .optional()
        .describe(
          "Android panel key, role, or active that size reads and sets; the default display " +
            "when omitted. navigationMode and displayCutout are device-wide.",
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
        .union([z.boolean(), z.literal("factory")])
        .optional()
        .describe(
          'Pass "factory" to restore platform defaults no matter which baselines were recorded, ' +
            "including after a daemon restart or for changes made outside a session: light theme, " +
            "iOS content size large, accessibility display preferences off, font scale 1.0, density " +
            "and size defaults. Pass true for the baseline-only reset described next. " +
            "On Android, restore font scale, density and screen size to device defaults, and navigation " +
            "mode and display cutout to the values recorded before they were first changed. Restore " +
            "night mode only to the value displayConfig replaced earlier in this process; otherwise " +
            "leave it unchanged. " +
            "Android reset never forces light mode. On the iOS Simulator, reset restores light appearance and the content size category displayConfig replaced earlier in this process. " +
            "On both, restore each accessibility display preference that displayConfig " +
            "changed earlier in this process.",
        ),
    })
    .strict(),
).superRefine((values, ctx) => {
  if (values.reset !== undefined && values.reset !== false && displayConfigFieldsPresent(values)) {
    ctx.addIssue({
      code: "custom",
      path: ["reset"],
      message:
        "reset cannot be combined with an explicit display field or accessibility display " +
        "preference; send reset on its own.",
    });
  }
  if (values.fontScale !== undefined && values.contentSize !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["contentSize"],
      message: "fontScale and contentSize both select the text size; send one of them.",
    });
  }
});

/** The displayConfig set fields; a call carrying none (and no reset) is a read. */
const DISPLAY_CONFIG_SET_FIELDS = [
  "fontScale",
  "contentSize",
  "density",
  "theme",
  "size",
  "navigationMode",
  "displayCutout",
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
  return isResetRequest(args.reset) || displayConfigFieldsPresent(args);
}

/** Project the wire args onto the feature's set-input shape, dropping absent fields. */
function displayConfigSetInput(args: DisplayConfigArgs): SetDisplayConfigInput {
  return {
    ...(args.fontScale !== undefined ? { fontScale: args.fontScale } : {}),
    ...(args.density !== undefined ? { density: args.density } : {}),
    ...(args.theme !== undefined ? { theme: args.theme } : {}),
    ...(args.size !== undefined ? { size: args.size } : {}),
    ...(args.navigationMode !== undefined ? { navigationMode: args.navigationMode } : {}),
    ...(args.displayCutout !== undefined ? { displayCutout: args.displayCutout } : {}),
    ...accessibilityArgs(args),
    ...(args.contentSize !== undefined ? { contentSize: args.contentSize } : {}),
    ...(args.reset !== undefined ? { reset: isResetRequest(args.reset) } : {}),
    ...(args.reset === "factory" ? { factory: true } : {}),
  };
}

/** `reset: true` and `reset: "factory"` both reset; `false` is absent. */
function isResetRequest(reset: boolean | "factory" | undefined): boolean {
  return reset === true || reset === "factory";
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
  if (isResetRequest(args.reset)) {
    return ["fontScale", "contentSize", "density", "nightMode", ...ACCESSIBILITY_DISPLAY_FIELDS];
  }
  // Android records fontScale and the iOS Simulator its content size category; each platform
  // omits the key it cannot read, so naming both is safe (#14087).
  return [
    ...(args.fontScale !== undefined ? (["fontScale", "contentSize"] as const) : []),
    ...(args.contentSize !== undefined ? (["contentSize"] as const) : []),
    ...(args.density !== undefined ? (["density"] as const) : []),
    ...(args.theme !== undefined ? (["nightMode"] as const) : []),
    ...ACCESSIBILITY_DISPLAY_FIELDS.filter((field) => args[field] !== undefined),
  ];
}

export interface DisplayConfigToolDependencies {
  sessionManager?: () => SessionDisplayProfileHost | undefined;
  /** Resolve `display` to an Android logical display id; undefined is the default display. */
  resolveDisplayId?: (
    device: BootedDevice,
    display: string,
    signal?: AbortSignal,
  ) => Promise<number | undefined>;
  /** Feature seams; the handler adds the resolved display and the owning session. */
  displayConfig?: DisplayConfigDependencies;
}

const defaultResolveDisplayId: NonNullable<DisplayConfigToolDependencies["resolveDisplayId"]> = (
  device,
  display,
  signal,
) =>
  resolvePrototypeDisplayId(device, display, {
    adb: defaultAdbClientFactory.create(device),
    signal,
  });

/** `display` only steers `size` (read, written or reset); other fields never need it resolved. */
function sizeDisplayId(
  device: BootedDevice,
  args: DisplayConfigArgs,
  resolve: NonNullable<DisplayConfigToolDependencies["resolveDisplayId"]>,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const targetsSize =
    args.size !== undefined || isResetRequest(args.reset) || isDisplayConfigRead(args);
  return device.platform === "android" && args.display !== undefined && targetsSize
    ? resolve(device, args.display, signal)
    : Promise.resolve(undefined);
}

export function createDisplayConfigHandler(dependencies: DisplayConfigToolDependencies = {}) {
  return async (
    device: BootedDevice,
    args: DisplayConfigArgs,
    _progress?: unknown,
    signal?: AbortSignal,
  ) => {
    const isSet = displayConfigArgsAreSet(args);
    if (isSet) {
      await recordDeviceSettingDefaultsBeforeChange(device, displayConfigChangedSettings(args));
    }
    const displayId = await sizeDisplayId(
      device,
      args,
      dependencies.resolveDisplayId ?? defaultResolveDisplayId,
      signal,
    );
    const run = (owner?: string) => {
      const displayConfig = new DisplayConfig(device, {
        ...dependencies.displayConfig,
        geometry: {
          ...dependencies.displayConfig?.geometry,
          ...(displayId === undefined ? {} : { displayId }),
          ...(owner === undefined ? {} : { owner }),
        },
      });
      return isSet
        ? displayConfig.setConfig(displayConfigSetInput(args))
        : displayConfig.getConfig();
    };
    // Geometry writes (and reset, which can restore them) are session-owned: release restores them.
    const restorable =
      isResetRequest(args.reset) ||
      DISPLAY_GEOMETRY_FIELDS.some((field) => args[field] !== undefined);
    const sessionManager =
      restorable && args.sessionUuid
        ? (dependencies.sessionManager ?? (() => defaultDaemonContext.sessionManager()))()
        : undefined;
    const result = restorable
      ? await runSessionDisplayProfileMutation(
          sessionManager,
          args.sessionUuid,
          device.deviceId,
          run,
        )
      : await run();
    const response = createStructuredToolResponse({
      message: displayConfigMessage(result),
      ...result,
    });
    return result.success ? response : { ...response, isError: true as const };
  };
}

export const displayConfigHandler = createDisplayConfigHandler();

export const DISPLAY_CONFIG_DESCRIPTION =
  'Read or set the visual display configuration — font/text scale, effective display density, light/dark (night mode) theme, and on Android the runtime screen size, navigation mode (gesture / 3-button / 2-button) and display-cutout emulation — for adaptive-layout, edge-to-edge and large-font accessibility testing. A call with no set field reads current values; providing fontScale, density, theme, size, navigationMode, displayCutout, or reset applies the change and returns applied + previous values so the client can restore. Android supports all three fields (density overrides are best-effort on physical devices); iOS supports theme (the Simulator via `simctl ui appearance`, physical devices through the CtrlProxy runner) and, on the Simulator only, font scale as a Dynamic Type category (via `simctl ui content_size`; fontScale maps to the nearest category and contentSize selects one exactly; reads report both). Android size, navigationMode and displayCutout use `wm size` and the system image\'s overlays; values the image does not ship are refused and `available` lists the ones it has; size, overlay and density changes invalidate cached observations and coordinates. On Android, reset restores font scale, density and screen size to device defaults, navigation mode and display cutout to the values recorded before they were first changed, and night mode only to the value displayConfig replaced earlier in this process; otherwise night mode is left unchanged. Releasing or rebinding the session that changed size, navigationMode or displayCutout restores them through the same record as displayProfile; sessionless changes persist until reset. Android reset never forces light mode. iOS Simulator reset restores light appearance and the content size category displayConfig replaced earlier in this process; physical iOS reset restores the appearance displayConfig first replaced there (light if none). The accessibility display preferences increaseContrast, reduceMotion and boldText are read and set on Android and the iOS Simulator, and colorInversion, colorCorrection, magnification, magnificationScale and extraDim (API 31+) on Android; `supported` reports each as true (proven by read-back), partial (stored setting reads back but running apps must relaunch; reason in supportNotes) or false, and reset restores the ones displayConfig changed. reset: "factory" additionally forces platform defaults (light theme, iOS content size large, accessibility display preferences off) regardless of recorded baselines, including after a daemon restart.';
