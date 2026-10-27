import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { canonicalJson } from "./canonicalJson";

/**
 * Signing of the shared attestation envelope (#11974). This file knows nothing about any tier's
 * payload: it signs and verifies bytes, and the type tag inside the payload is only dispatched on
 * after the signature holds.
 *
 * The scheme is Ed25519 (RFC 8032) over a domain-separated, length-prefixed byte string, so a
 * signature cannot be replayed under another key id, algorithm or protocol. See
 * docs/design-docs/ci/attestation-envelope.md.
 */
export const ED25519_ALGORITHM = "ed25519-v1";

const DOMAIN = "auto-mobile attestation envelope v1\n";

/** The exact bytes signed: key id and algorithm are bound together with the canonical payload. */
export function envelopeSigningBytes(
  keyId: string,
  algorithm: string,
  canonicalPayload: string,
): Buffer {
  return Buffer.from(
    `${DOMAIN}${Buffer.byteLength(keyId)}:${keyId}\n${Buffer.byteLength(algorithm)}:${algorithm}\n${canonicalPayload}`,
    "utf8",
  );
}

export interface EnvelopeSignature {
  keyId: string;
  algorithm: string;
  value: string;
}

export function signEnvelopeEd25519(
  keyId: string,
  canonicalPayload: string,
  privateKey: KeyObject,
): EnvelopeSignature {
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("the producer key is not an Ed25519 key");
  }
  const bytes = envelopeSigningBytes(keyId, ED25519_ALGORITHM, canonicalPayload);
  return {
    keyId,
    algorithm: ED25519_ALGORITHM,
    value: sign(null, bytes, privateKey).toString("base64"),
  };
}

/** Whether `signature` holds over this payload under `publicKey`; any malformation is false. */
export function verifyEnvelopeEd25519(
  payload: unknown,
  signature: EnvelopeSignature,
  publicKey: KeyObject,
): boolean {
  try {
    if (
      signature.algorithm !== ED25519_ALGORITHM ||
      publicKey.asymmetricKeyType !== "ed25519" ||
      !/^[A-Za-z0-9+/]{86}==$/.test(signature.value)
    ) {
      return false;
    }
    const bytes = envelopeSigningBytes(
      signature.keyId,
      signature.algorithm,
      canonicalJson(payload),
    );
    return verify(null, bytes, publicKey, Buffer.from(signature.value, "base64"));
  } catch {
    // A payload that cannot be serialized or a key that cannot verify is an unverified envelope.
    return false;
  }
}

/** A public key from its SPKI PEM, for a registry that stores keys as text. */
export function ed25519PublicKeyFromPem(pem: string): KeyObject {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("not an Ed25519 public key");
  }
  return key;
}
