/**
 * The hardware-attestation ceiling (#14074): an emulator has no TEE/StrongBox and an
 * unverified boot, so it can present failure/basic-tier attestation signals but can
 * never present a passing one. A request for a passing state is refused up front, with
 * text naming the real-hardware requirement, rather than applied best-effort.
 */
export const ATTESTATION_CEILING_CODE = "attestation_ceiling";

/** Normalized (lowercase, alphanumeric-only) values that only real hardware can present. */
const UNSATISFIABLE_VALUES: ReadonlySet<string> = new Set([
  "verified",
  "green",
  "verifiedboot",
  "meetsdeviceintegrity",
  "meetsstrongintegrity",
  "ctsprofilematch",
  "strongbox",
  "hardwarebacked",
]);

/** Keys whose mere presence with a truthy value asks for a passing state. */
const UNSATISFIABLE_KEYS: ReadonlySet<string> = new Set([
  "ctsprofilematch",
  "meetsdeviceintegrity",
  "meetsstrongintegrity",
]);

const normalize = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

function findUnsatisfiable(value: unknown, path: string): string | undefined {
  if (typeof value === "string") {
    return UNSATISFIABLE_VALUES.has(normalize(value)) ? `${path}: "${value}"` : undefined;
  }
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (UNSATISFIABLE_KEYS.has(normalize(key)) && child === true) {
      return childPath;
    }
    const found = findUnsatisfiable(child, childPath);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * Refusal text when a raw `deviceCondition` request asks for a passing attestation
 * state an emulator can never present, or undefined when the request is admissible.
 */
export function attestationCeilingRefusal(raw: unknown): string | undefined {
  const found = findUnsatisfiable(raw, "");
  if (found === undefined) {
    return undefined;
  }
  return (
    `${ATTESTATION_CEILING_CODE}: deviceCondition requested ${found}, a passing hardware-attestation ` +
    "state (verifiedBootState=Verified, MEETS_DEVICE_INTEGRITY/MEETS_STRONG_INTEGRITY, ctsProfileMatch). " +
    "An emulator has no TEE/StrongBox and an unverified boot, so it can never present one; nothing was applied. " +
    "Run this test on a physical device. Failing, rooted and tampered attestation states are supported."
  );
}
