import { prototypeStatusRuleAccepts } from "./prototypeDeviceStatusMirror";
import {
  prototypeStatusValuesEqual,
  type PrototypeStatusModule,
  type PrototypeStatusUpdate,
  type PrototypeStatusValues,
} from "./prototypeDeviceStatusReference";
import { PROTOTYPE_PLATFORM_MODULES } from "./prototypePlatform";

/**
 * The simulate override reference for the `battery`, `power` and `audio` modules (#14316, #14300
 * state seeding): how real readings, `platformMode` switches and `simulate state` seeds combine into
 * the values a runtime shows under `/platform/<module>`. Pure, so the shared fixtures under
 * `test/fixtures/prototype-device-status/override-*.json` replay identically in every runtime.
 *
 * - In `real` mode (the default) the values are the latest reading.
 * - Switching to `fake` freezes the values at the last reading; later readings are recorded but not shown.
 * - A seed merges into the shown values; a `null` seed value removes the key (an unknown reading).
 *   Seeding is refused in `real` mode, for a key outside the module's state table, a key the target
 *   platform does not report, or a value the key's contract rule refuses.
 * - Switching back to `real` drops the override and shows the latest reading at once.
 *
 * The result lists the shown values each time they change; the first entry is the baseline, so
 * feeding it to `prototypeStatusChangeEvents` gives the `<module>.changed` deliveries.
 */

export type PrototypeStatusMode = "real" | "fake";
export type PrototypeStatusSeed = Readonly<Record<string, string | number | boolean | null>>;

export type PrototypeStatusInput =
  | { timestampMs: number; reading: PrototypeStatusValues }
  | { timestampMs: number; mode: PrototypeStatusMode }
  | { timestampMs: number; seed: PrototypeStatusSeed };

export type PrototypeStatusOverrideResult =
  | { success: true; updates: PrototypeStatusUpdate[] }
  | { success: false; index: number; path: string; error: string };

interface Shown {
  mode: PrototypeStatusMode;
  real?: PrototypeStatusValues;
  values?: PrototypeStatusValues;
}

export function prototypeStatusOverrideUpdates(
  module: PrototypeStatusModule,
  platform: "android" | "ios",
  inputs: readonly PrototypeStatusInput[],
): PrototypeStatusOverrideResult {
  const updates: PrototypeStatusUpdate[] = [];
  let shown: Shown = { mode: "real" };
  for (const [index, input] of inputs.entries()) {
    const next = applyInput(module, platform, shown, input);
    if ("error" in next) {
      return { success: false, index, path: `inputs[${index}]${next.path}`, error: next.error };
    }
    if (
      next.values !== undefined &&
      (shown.values === undefined || !prototypeStatusValuesEqual(next.values, shown.values))
    ) {
      updates.push({ timestampMs: input.timestampMs, values: next.values });
    }
    shown = next;
  }
  return { success: true, updates };
}

function applyInput(
  module: PrototypeStatusModule,
  platform: "android" | "ios",
  shown: Shown,
  input: PrototypeStatusInput,
): Shown | { path: string; error: string } {
  if ("reading" in input) {
    return shown.mode === "real"
      ? { mode: "real", real: input.reading, values: input.reading }
      : { ...shown, real: input.reading };
  }
  if ("mode" in input) {
    if (input.mode === shown.mode) {
      return shown;
    }
    return input.mode === "fake"
      ? { ...shown, mode: "fake" }
      : { mode: "real", real: shown.real, values: shown.real ?? (shown.values && {}) };
  }
  if (shown.mode !== "fake") {
    return { path: ".seed", error: `simulate state needs ${module} in fake platformMode` };
  }
  return seeded(module, platform, shown, input.seed);
}

function seeded(
  module: PrototypeStatusModule,
  platform: "android" | "ios",
  shown: Shown,
  seed: PrototypeStatusSeed,
): Shown | { path: string; error: string } {
  const state = PROTOTYPE_PLATFORM_MODULES[module]?.state ?? {};
  const values: Record<string, string | number | boolean> = { ...shown.values };
  for (const [key, value] of Object.entries(seed)) {
    const entry = Object.hasOwn(state, key) ? state[key] : undefined;
    if (!entry || !entry.platforms.includes(platform)) {
      return {
        path: `.seed.${key}`,
        error: entry
          ? `/platform/${module}/${key} is not reported on ${platform}`
          : `/platform/${module} has no key ${key}`,
      };
    }
    if (value === null) {
      delete values[key];
    } else if (prototypeStatusRuleAccepts(value, entry.value)) {
      values[key] = value;
    } else {
      return { path: `.seed.${key}`, error: `${JSON.stringify(value)} is not a valid ${key}` };
    }
  }
  return shown.values !== undefined && prototypeStatusValuesEqual(values, shown.values)
    ? shown
    : { ...shown, values };
}
