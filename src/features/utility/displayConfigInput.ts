import {
  requestedAccessibilityFields,
  type AccessibilityDisplayField,
  type AccessibilityDisplayValues,
} from "./AccessibilityDisplayPreferences";
import { hasDisplayGeometryField, type DisplayGeometryChange } from "./AndroidDisplayGeometry";
import type {
  DisplayConfig,
  DisplayConfigResult,
  DisplayConfigSupport,
  DisplayTheme,
  SetDisplayConfigInput,
} from "./DisplayConfig";
import { IOS_DEFAULT_CONTENT_SIZE } from "./IosSimulatorDisplayConfig";

/** Why a set request contradicts itself or asks for nothing, before any platform check. */
export function setInputContradiction(input: SetDisplayConfigInput): string | undefined {
  // `reset` restores every field to its device default, so pairing it with an
  // explicit field is contradictory — the explicit value would be silently
  // dropped (reset wins) or race the reset. Reject it up front rather than
  // half-honoring the request (issue #6096 review).
  const explicit =
    hasDisplayField(input) ||
    hasDisplayGeometryField(input) ||
    requestedAccessibilityFields(input).length > 0;
  if (input.reset === true && explicit) {
    return (
      "reset cannot be combined with an explicit fontScale, contentSize, density, theme, size, " +
      "navigationMode, displayCutout, or accessibility display preference: reset restores the platform defaults and recorded " +
      "baselines. Send reset on its own, or send only the explicit fields you want to change."
    );
  }
  if (input.reset !== true && !explicit) {
    return (
      "At least one of fontScale, contentSize, density, theme, size, navigationMode, displayCutout, " +
      "an accessibility display preference, or reset must be provided to set display config."
    );
  }
  if (input.fontScale !== undefined && input.contentSize !== undefined) {
    return "fontScale and contentSize both select the text size: send one of them.";
  }
  return undefined;
}

export function hasDisplayField(input: SetDisplayConfigInput): boolean {
  return (
    input.fontScale !== undefined ||
    input.density !== undefined ||
    input.theme !== undefined ||
    input.contentSize !== undefined
  );
}

export function displayFieldsOf(input: SetDisplayConfigInput): SetDisplayConfigInput {
  return {
    ...(input.fontScale !== undefined ? { fontScale: input.fontScale } : {}),
    ...(input.density !== undefined ? { density: input.density } : {}),
    ...(input.theme !== undefined ? { theme: input.theme } : {}),
    ...(input.contentSize !== undefined ? { contentSize: input.contentSize } : {}),
    ...(input.reset !== undefined ? { reset: input.reset } : {}),
  };
}

export function accessibilityValuesOf(input: SetDisplayConfigInput): AccessibilityDisplayValues {
  return Object.fromEntries(
    requestedAccessibilityFields(input).map((field) => [field, input[field]]),
  ) as AccessibilityDisplayValues;
}

export function mergedMessage(
  error: string | undefined,
  displayMessage: string | undefined,
  reset: boolean,
  restored: readonly AccessibilityDisplayField[],
): string | undefined {
  if (error !== undefined) {
    return error;
  }
  const resetNote = reset ? accessibilityResetMessage(restored) : undefined;
  return [displayMessage, resetNote].filter(Boolean).join(" ") || undefined;
}

function accessibilityResetMessage(restored: readonly AccessibilityDisplayField[]): string {
  return restored.length > 0
    ? `Restored ${restored.join(", ")} to the value displayConfig replaced.`
    : "No accessibility display preference changed by displayConfig needed restoring.";
}

/** One result from the font/density/theme/accessibility part (if any) and the geometry change. */
export function mergeGeometryChange(
  display: DisplayConfigResult | undefined,
  change: DisplayGeometryChange,
  identity: Pick<DisplayConfigResult, "deviceId" | "platform" | "supported">,
): DisplayConfigResult {
  const errors = [...(display?.error ? [display.error] : []), ...change.errors];
  const error = errors.length > 0 ? errors.join("; ") : undefined;
  const message = error ?? display?.message;
  return {
    ...display,
    ...identity,
    ...(display ? { supported: display.supported } : {}),
    success: error === undefined,
    applied: { ...display?.applied, ...change.applied },
    previous: { ...display?.previous, ...change.previous },
    ...(change.available ? { available: change.available } : {}),
    ...(error ? { error } : {}),
    ...(message === undefined ? {} : { message }),
  };
}

/** Platform defaults for every field a target supports, forced by `reset: "factory"` (#15337). */
export function factoryDefaults(
  platform: "android" | "ios",
  support: DisplayConfigSupport,
): SetDisplayConfigInput {
  const on = (level: boolean | "partial" | undefined) => level === true || level === "partial";
  const defaults: SetDisplayConfigInput = {};
  if (support.theme) {
    defaults.theme = "light";
  }
  if (platform === "ios" && support.fontScale) {
    defaults.contentSize = IOS_DEFAULT_CONTENT_SIZE;
  }
  for (const field of [
    "increaseContrast",
    "reduceMotion",
    "boldText",
    "colorInversion",
    "magnification",
    "extraDim",
  ] as const) {
    if (on(support[field])) {
      defaults[field] = false;
    }
  }
  if (on(support.colorCorrection)) {
    defaults.colorCorrection = "off";
  }
  return defaults;
}

/**
 * `reset` followed by explicit platform defaults for whatever the recorded baselines missed, then
 * the recorded baselines are dropped: the forced values are defaults, not a state to return to.
 */
export async function setFactoryDisplayConfig(
  config: DisplayConfig,
  platform: "android" | "ios",
): Promise<DisplayConfigResult> {
  const reset = await config.setConfig({ reset: true });
  if (!reset.success && reset.previous === undefined) {
    return reset;
  }
  const accessibilitySupport = (await config.accessibility().read()).supported;
  const defaults = factoryDefaults(platform, { ...reset.supported, ...accessibilitySupport });
  const forced = Object.keys(defaults).length > 0 ? await config.setConfig(defaults) : undefined;
  config.clearBaselines();
  const errors = [reset.error, forced?.error].filter((e): e is string => e !== undefined);
  const error = errors.length > 0 ? errors.join("; ") : undefined;
  const fields = Object.keys(defaults).join(", ") || "none needed";
  return {
    ...reset,
    success: error === undefined,
    applied: { ...reset.applied, ...forced?.applied },
    ...(error ? { error } : {}),
    message: error ?? `Factory reset: restored platform defaults (${fields}).`,
  };
}

export function androidResultMessage(
  reset: boolean | undefined,
  theme: DisplayTheme | undefined,
  error: string | undefined,
): string | undefined {
  if (error !== undefined) {
    return error;
  }
  if (!reset) {
    return undefined;
  }
  const nightMode =
    theme === undefined
      ? "night mode left unchanged (no night-mode baseline was recorded by displayConfig)"
      : `night mode restored to ${theme} (changed earlier by displayConfig)`;
  return `Reset font scale and density to device defaults; ${nightMode}.`;
}
