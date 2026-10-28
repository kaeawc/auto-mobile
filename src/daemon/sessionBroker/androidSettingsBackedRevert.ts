import { ANDROID_ANIMATION_SCALE_KEYS } from "../../features/utility/AccessibilityDisplayPreferences";
import type { DeviceMutationInput, MutationValue } from "./mutations/types";

/**
 * The raw settings rows behind the settings-backed `device-setting` journal keys that
 * displayConfig and changeLocalization record on Android. Multi-key fields journal their raw
 * values joined by commas in this order, with `null` for an unset row (see
 * AccessibilityDisplayPreferences).
 */
const SETTINGS_BACKED_KEYS: Readonly<Record<string, readonly string[]>> = {
  fontScale: ["system:font_scale"],
  timeFormat: ["system:time_12_24"],
  increaseContrast: ["secure:high_text_contrast_enabled"],
  reduceMotion: ANDROID_ANIMATION_SCALE_KEYS.map((key) => `global:${key}`),
  boldText: ["secure:font_weight_adjustment"],
  colorInversion: ["secure:accessibility_display_inversion_enabled"],
  colorCorrection: [
    "secure:accessibility_display_daltonizer_enabled",
    "secure:accessibility_display_daltonizer",
  ],
  magnification: ["secure:accessibility_display_magnification_enabled"],
  magnificationScale: ["secure:accessibility_display_magnification_scale"],
  extraDim: ["secure:reduce_bright_colors_activated"],
};

const NUMERIC_SETTING = /^[+]?(?:\d+(?:\.\d*)?|\.\d+)$/;

type RawPriors = (string | null)[] | null;

/** DisplayConfig journals "default" for a device with no font-scale override. */
function fontScalePriors(value: unknown): RawPriors {
  if (value === "default") {
    return [null];
  }
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? [String(value)] : null;
}

/** Accessibility snapshots: numeric raw values joined by commas, `null` for an unset row. */
function joinedPriors(value: unknown, rows: number): RawPriors {
  if (typeof value !== "string") {
    return null;
  }
  const parts = value.split(",");
  return parts.length === rows &&
    parts.every((part) => part === "null" || NUMERIC_SETTING.test(part))
    ? parts.map((part) => (part === "null" ? null : part))
    : null;
}

/** The raw values a journaled prior restores, one per row; `null` deletes the row. */
function rawPriors(key: string, prior: MutationValue, rows: number): RawPriors {
  if (prior.state === "absent") {
    return Array.from({ length: rows }, () => null);
  }
  if (prior.state !== "present") {
    return null;
  }
  if (key === "fontScale") {
    return fontScalePriors(prior.value);
  }
  if (key === "timeFormat") {
    return prior.value === "12" || prior.value === "24" ? [prior.value] : null;
  }
  return joinedPriors(prior.value, rows);
}

/**
 * Raw settings mutations that restore a settings-backed `device-setting` journal row, or null
 * when the key is not settings-backed or its prior is not the exact shape the prior reader
 * records, so an unreadable or foreign prior is never "restored".
 */
export function settingsBackedRawMutations(
  mutation: DeviceMutationInput,
): DeviceMutationInput[] | null {
  if (!Object.hasOwn(SETTINGS_BACKED_KEYS, mutation.key)) {
    return null;
  }
  const rows = SETTINGS_BACKED_KEYS[mutation.key]!;
  const priors = rawPriors(mutation.key, mutation.priorValue, rows.length);
  return priors
    ? rows.map((key, index) => {
        const raw = priors[index];
        return {
          kind: "device-setting",
          key,
          priorValue: raw === null ? { state: "absent" } : { state: "present", value: raw },
          toolName: mutation.toolName,
        };
      })
    : null;
}
