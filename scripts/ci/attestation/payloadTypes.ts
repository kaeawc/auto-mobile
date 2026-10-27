import type { AttestationTier } from "./attestationSchema";

/**
 * The payload type registry (#11974): each tier's payload has its own type tag and its own
 * independent version. An unknown tag, a version the tag does not list, or a tag used for another
 * tier is rejected, so a verifier fails closed (the job runs for real).
 */
export interface PayloadTypeEntry {
  readonly tier: AttestationTier;
  readonly versions: readonly number[];
}

export const PAYLOAD_TYPES: Readonly<Record<string, PayloadTypeEntry>> = Object.freeze({
  "auto-mobile.prepush.node": { tier: 1, versions: [1] },
  "auto-mobile.prepush.android": { tier: 2, versions: [1] },
  "auto-mobile.prepush.ios": { tier: 3, versions: [1] },
});

export function payloadTypeAccepted(
  payloadType: string,
  payloadVersion: number,
  tier: number,
): boolean {
  if (!Object.hasOwn(PAYLOAD_TYPES, payloadType)) {
    return false;
  }
  const entry = PAYLOAD_TYPES[payloadType]!;
  return entry.tier === tier && entry.versions.includes(payloadVersion);
}
