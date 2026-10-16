import { compareStrictNumericVersions } from "../../utils/deviceMatcher";
import { failure, success } from "./result";
import type { AndroidVersionPrecision, EffectiveOsSelector, RequirementResult } from "./types";

export interface NumericVersion {
  value: string;
  components: readonly string[];
  precision: number;
}

function normalizeComponent(component: string): string {
  return component.replace(/^0+(?=\d)/, "");
}

/**
 * Parse a positive dotted numeric release. Letter releases, QPR labels, API
 * labels, signs, and whitespace are rejected at this boundary.
 */
export function parseNumericVersion(
  value: string,
  field = "os.version",
): RequirementResult<NumericVersion> {
  if (!/^\d+(?:\.\d+)*$/.test(value)) {
    return failure("invalid_request", `${field} must be a dotted numeric release.`, { field });
  }
  const normalized = value.split(".").map(normalizeComponent);
  while (normalized.length > 1 && normalized.at(-1) === "0") {
    normalized.pop();
  }
  if (normalized.every((component) => component === "0")) {
    return failure("invalid_request", `${field} must be greater than zero.`, { field });
  }
  return success({
    value: normalized.join("."),
    components: normalized,
    precision: normalized.length,
  });
}

export function compareNumericVersions(a: string, b: string): number {
  return compareStrictNumericVersions(a, b);
}

export function normalizeOsSelector(
  selector: EffectiveOsSelector,
  field = "os",
): RequirementResult<EffectiveOsSelector> {
  if (selector.kind === "major") {
    if (!Number.isSafeInteger(selector.major) || selector.major <= 0) {
      return failure("invalid_request", `${field}.major must be a positive safe integer.`, {
        field: `${field}.major`,
      });
    }
    return success(selector);
  }
  const parsed = parseNumericVersion(selector.version, `${field}.version`);
  return parsed.ok ? success({ kind: selector.kind, version: parsed.value.value }) : parsed;
}

export function osSelectorMatchesVersion(selector: EffectiveOsSelector, version: string): boolean {
  const parsed = parseNumericVersion(version);
  if (!parsed.ok) {
    return false;
  }
  if (selector.kind === "major") {
    return parsed.value.components[0] === String(selector.major);
  }
  const delta = compareNumericVersions(parsed.value.value, selector.version);
  return selector.kind === "exact" ? delta === 0 : delta >= 0;
}

export function androidPrecisionRank(precision: AndroidVersionPrecision): number {
  return precision === "major" ? 1 : precision === "minor" ? 2 : 3;
}

/**
 * Creation and reuse use the same version proof. A major-only observation can prove >=16
 * satisfies >=15.1, but cannot prove a reported 15.1 satisfies >=15.1 or exact15.1. Trailing
 * zeros do not demand more precision (15, 15.0 and 15.0.0 describe the same exact release).
 */
export function androidOsEvidenceMatches(
  selector: EffectiveOsSelector,
  version: string,
  precision: AndroidVersionPrecision | undefined,
): boolean {
  if (!precision) {
    return false;
  }
  const parsed = parseNumericVersion(version);
  if (!parsed.ok) {
    return false;
  }
  const rank = androidPrecisionRank(precision);
  const knownVersion = parsed.value.components.slice(0, rank).join(".");
  if (selector.kind === "exact") {
    const requested = parseNumericVersion(selector.version);
    if (!requested.ok || requested.value.precision > rank || parsed.value.precision > rank) {
      return false;
    }
  }
  return osSelectorMatchesVersion(selector, knownVersion);
}
