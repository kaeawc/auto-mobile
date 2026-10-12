import type { FormFactor } from "./DeviceMatchCriteria";

/** Android profile hints and geometry, shared by inventory enrichment and managed-slot matching. */
export function androidProfileFormFactor(input: {
  profileId?: string | null;
  width?: number | null;
  height?: number | null;
  density?: number | null;
}): FormFactor {
  const hint = /pixel[_ ]tablet|nexus (?:9|10)/i.test(input.profileId ?? "") ? "tablet" : undefined;
  return formFactorFrom({ ...input, hint, deviceType: input.profileId });
}

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
