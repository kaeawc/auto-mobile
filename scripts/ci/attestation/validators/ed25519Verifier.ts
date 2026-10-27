import type { KeyObject } from "node:crypto";
import { parseEnvelope, SUPPORTED_SIGNATURE_ALGORITHMS } from "../attestationSchema";
import { ED25519_ALGORITHM, verifyEnvelopeEd25519 } from "../envelopeSigning";
import type { EnvelopeVerifier, VerificationResult } from "./trustPolicy";

/** The public key a producer key id names, and the identity it was issued to. */
export interface Ed25519KeyDirectory {
  lookup(keyId: string): { publicKey: KeyObject; identity: string } | null;
}

/**
 * The verifier-bound claims (base SHA, task) the validators require. They are not part of the
 * signature: the caller that knows the pushed state (the service, or the gate for a local check)
 * supplies them, so an envelope alone can never claim them.
 */
export interface VerifierClaims {
  baseSha?: string;
  task?: string;
}

const UNVERIFIED = (keyId: string): VerificationResult => ({
  verified: false,
  keyId,
  identity: "",
});

/**
 * Verifies an envelope's Ed25519 signature against the producer's registered key. Fail-closed: an
 * envelope that does not parse, carries no signature, names any algorithm but `ed25519-v1`, names an
 * unknown key, or does not verify under that key is unverified, whatever else it says.
 */
export class Ed25519EnvelopeVerifier implements EnvelopeVerifier {
  constructor(
    private readonly keys: Ed25519KeyDirectory,
    private readonly claims: () => VerifierClaims = () => ({}),
  ) {}

  verify(raw: unknown): VerificationResult {
    const parsed = parseEnvelope(raw);
    if (!parsed.ok || parsed.envelope.signature === null) {
      return UNVERIFIED("");
    }
    const { signature, payload, envelopeVersion } = parsed.envelope;
    if (
      signature.algorithm !== ED25519_ALGORITHM ||
      !SUPPORTED_SIGNATURE_ALGORITHMS.includes(signature.algorithm)
    ) {
      return UNVERIFIED(signature.keyId);
    }
    const key = this.keys.lookup(signature.keyId);
    if (!key || !verifyEnvelopeEd25519(payload, signature, key.publicKey, envelopeVersion)) {
      return UNVERIFIED(signature.keyId);
    }
    return { verified: true, keyId: signature.keyId, identity: key.identity, ...this.claims() };
  }
}
