import type { FormFactor } from "./DeviceMatchCriteria";

type NonGeometricFormFactor = "tv" | "watch" | "automotive";

/**
 * Non-handheld form factors, keyed by system-image tag and avdmanager profile id.
 * Names are from sdkmanager/avdmanager listings; confirm with `sdkmanager --list` and
 * `avdmanager list device` (docs/design-docs/plat/android/form-factors.md, checklist row 10).
 * A wrong name is a one-line fix here.
 */
const NON_GEOMETRIC_FORM_FACTORS: ReadonlyArray<{
  formFactor: NonGeometricFormFactor;
  systemImageTags: readonly string[];
  profileIdPattern: RegExp;
}> = [
  { formFactor: "tv", systemImageTags: ["android-tv", "google-tv"], profileIdPattern: /^tv_/i },
  {
    formFactor: "watch",
    systemImageTags: ["android-wear", "android-wear-cn"],
    profileIdPattern: /^wear(?:os)?_/i,
  },
  {
    formFactor: "automotive",
    systemImageTags: ["android-automotive", "android-automotive-playstore"],
    profileIdPattern: /^automotive_/i,
  },
];

function nonGeometricFormFactor(input: {
  systemImageTag?: string | null;
  profileId?: string | null;
}): NonGeometricFormFactor | undefined {
  const tag = input.systemImageTag?.trim().toLowerCase();
  const profileId = input.profileId?.trim();
  const byTag = NON_GEOMETRIC_FORM_FACTORS.find((entry) =>
    tag ? entry.systemImageTags.includes(tag) : false,
  );
  if (byTag) {
    return byTag.formFactor;
  }
  return NON_GEOMETRIC_FORM_FACTORS.find((entry) =>
    profileId ? entry.profileIdPattern.test(profileId) : false,
  )?.formFactor;
}

/** Android profile hints and geometry, shared by inventory enrichment and broker binding matching. */
export function androidProfileFormFactor(input: {
  systemImageTag?: string | null;
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
 * matching. Order: system-image tag, then profile id (tv, watch, automotive), then a hint of
 * those kinds, then the profile's fold/flip identity, then geometry.
 */
export function formFactorFrom(input: {
  /** Android system-image tag (`android-tv`, ...); wins over the profile and geometry. */
  systemImageTag?: string | null;
  hint?: string | null;
  width?: number | null;
  height?: number | null;
  density?: number | null;
  deviceType?: string | null;
}): FormFactor {
  const nonGeometric = nonGeometricFormFactor({
    systemImageTag: input.systemImageTag,
    profileId: input.deviceType,
  });
  if (nonGeometric) {
    return nonGeometric;
  }
  const profile = `${input.deviceType ?? ""} ${input.hint ?? ""}`;
  if (/fold|flip/i.test(profile)) {
    return "foldable";
  }

  const hint = input.hint?.trim().toLowerCase();
  if (hint !== undefined && EXPLICIT_HINTS.has(hint)) {
    return hint as FormFactor;
  }
  return geometryFormFactor(input);
}

const EXPLICIT_HINTS: ReadonlySet<string> = new Set([
  "phone",
  "tablet",
  "tv",
  "watch",
  "automotive",
]);

function geometryFormFactor(input: {
  width?: number | null;
  height?: number | null;
  density?: number | null;
}): FormFactor {
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
