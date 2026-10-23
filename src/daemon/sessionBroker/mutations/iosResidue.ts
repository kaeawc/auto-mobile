import { isDeepStrictEqual } from "node:util";
import type {
  IosResidueFileArea,
  IosResidueSnapshot,
  KeyboardDefaultValue,
} from "../../../utils/ios-cmdline-tools/SimulatorResidueReader";
import type { DeviceBaseline } from "./types";

/** Baseline kinds the residue guard inventories; each is complete only when all are read. */
export const IOS_RESIDUE_KINDS = ["media", "shared-file", "keyboard", "accessibility"] as const;

const OBSERVATION_KEYS = {
  photos: { kind: "media", key: "dcim" },
  documents: { kind: "shared-file", key: "documents" },
  safariDocuments: { kind: "shared-file", key: "safari-documents" },
  keyboard: { kind: "keyboard", key: "defaults" },
  accessibility: { kind: "accessibility", key: "defaults" },
} as const;

export function residueObservations(snapshot: IosResidueSnapshot): DeviceBaseline["observations"] {
  return (Object.keys(OBSERVATION_KEYS) as (keyof typeof OBSERVATION_KEYS)[]).map((name) => ({
    ...OBSERVATION_KEYS[name],
    value: { state: "present" as const, value: snapshot[name] },
  }));
}

export function hasResidueBaseline(baseline: DeviceBaseline | undefined): boolean {
  return IOS_RESIDUE_KINDS.every((kind) => baseline?.completeKinds.includes(kind));
}

function observed(baseline: DeviceBaseline, name: keyof typeof OBSERVATION_KEYS): unknown {
  const { kind, key } = OBSERVATION_KEYS[name];
  const entry = baseline.observations.find((item) => item.kind === kind && item.key === key);
  return entry?.value.state === "present" ? entry.value.value : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function keyboardDefaults(value: unknown): Record<string, KeyboardDefaultValue> {
  const defaults: Record<string, KeyboardDefaultValue> = {};
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "boolean" || typeof item === "number" || typeof item === "string") {
        defaults[key] = item;
      }
    }
  }
  return defaults;
}

/** An inventoried area with no stored observation was empty when the baseline was taken. */
export function residueFromBaseline(baseline: DeviceBaseline): IosResidueSnapshot {
  return {
    photos: stringList(observed(baseline, "photos")),
    documents: stringList(observed(baseline, "documents")),
    safariDocuments: stringList(observed(baseline, "safariDocuments")),
    keyboard: keyboardDefaults(observed(baseline, "keyboard")),
    accessibility: keyboardDefaults(observed(baseline, "accessibility")),
  };
}

export interface IosResidueRevertPlan {
  /** Residue simctl and the filesystem cannot revert: the reset must fall back to erase. */
  unrevertible: string[];
  removals: { area: IosResidueFileArea; names: string[] }[];
  /** Keyboard defaults to restore; an undefined `prior` means the key was absent and is deleted. */
  keyboard: { key: string; prior: KeyboardDefaultValue | undefined }[];
  /** `com.apple.Accessibility` increase-contrast defaults to restore, with the same `prior` rule. */
  accessibility: { key: string; prior: KeyboardDefaultValue | undefined }[];
}

function added(current: readonly string[], baseline: readonly string[]): string[] {
  return current.filter((name) => !baseline.includes(name));
}

export function planResidueRevert(
  baseline: IosResidueSnapshot,
  current: IosResidueSnapshot,
): IosResidueRevertPlan {
  const unrevertible: string[] = [];
  const addedPhotos = added(current.photos, baseline.photos).length;
  const removedPhotos = added(baseline.photos, current.photos).length;
  if (addedPhotos > 0) {
    unrevertible.push(`iOS reset cannot revert ${addedPhotos} added photo(s)`);
  }
  if (removedPhotos > 0) {
    unrevertible.push(`iOS reset cannot restore ${removedPhotos} removed photo(s)`);
  }
  const removals: IosResidueRevertPlan["removals"] = [];
  for (const [area, label, before, after] of [
    ["documents", "Documents", baseline.documents, current.documents],
    ["safari-documents", "Safari Documents", baseline.safariDocuments, current.safariDocuments],
  ] as const) {
    const missing = added(before, after).length;
    if (missing > 0) {
      unrevertible.push(`iOS reset cannot restore ${missing} removed ${label} file(s)`);
    }
    const extra = added(after, before);
    if (extra.length > 0) {
      removals.push({ area, names: extra });
    }
  }
  return {
    unrevertible,
    removals,
    keyboard: changedDefaults(baseline.keyboard, current.keyboard),
    accessibility: changedDefaults(baseline.accessibility, current.accessibility),
  };
}

function changedDefaults(
  baseline: Record<string, KeyboardDefaultValue>,
  current: Record<string, KeyboardDefaultValue>,
): { key: string; prior: KeyboardDefaultValue | undefined }[] {
  return [...new Set([...Object.keys(baseline), ...Object.keys(current)])]
    .sort()
    .filter((key) => !isDeepStrictEqual(baseline[key], current[key]))
    .map((key) => ({ key, prior: baseline[key] }));
}

export function residueIsClean(plan: IosResidueRevertPlan): boolean {
  return (
    plan.unrevertible.length === 0 &&
    plan.removals.length === 0 &&
    plan.keyboard.length === 0 &&
    plan.accessibility.length === 0
  );
}
