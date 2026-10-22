import {
  requestedAccessibilityFields,
  type AccessibilityDisplayField,
  type AccessibilityDisplayValues,
} from "./AccessibilityDisplayPreferences";
import { hasDisplayGeometryField, type DisplayGeometryChange } from "./AndroidDisplayGeometry";
import type { DisplayConfigResult, SetDisplayConfigInput } from "./DisplayConfig";

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
