import type { FormFactor } from "./DeviceMatchCriteria";

function isPositiveFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Classify a device profile or display into the form-factor vocabulary used by
 * matching. The profile's fold/flip identity takes precedence over geometry.
 */
export function formFactorFrom(input: {
  hint?: string | null;
  width?: number | null;
  height?: number | null;
  density?: number | null;
  deviceType?: string | null;
}): FormFactor {
  const profile = `${input.deviceType ?? ""} ${input.hint ?? ""}`;
  if (/fold|flip/i.test(profile)) {
    return "foldable";
  }

  const hint = input.hint?.trim().toLowerCase();
  if (hint === "phone" || hint === "tablet") {
    return hint;
  }

  const { width, height, density } = input;
  if (
    !isPositiveFiniteNumber(width) ||
    !isPositiveFiniteNumber(height) ||
    !isPositiveFiniteNumber(density)
  ) {
    return "unknown";
  }

  return Math.hypot(width, height) / density >= 7 ? "tablet" : "phone";
}
