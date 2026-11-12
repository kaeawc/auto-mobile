# Attestation signing envelope

The envelope (#11974) answers two questions only: is this attestation authentic, and which payload
schema is inside?

## Shape

```json
{
  "envelopeVersion": 1,
  "payload": {
    "payloadType": "auto-mobile.prepush.node",
    "payloadVersion": 1,
    "tier": 1,
    "...": "..."
  },
  "signature": { "keyId": "producer-1", "algorithm": "ed25519-v1", "value": "<base64>" }
}
```

The payload carries the type tag (`payloadType`), its independent version (`payloadVersion`), the
tier, the producer's timestamp and the result. Because the signature covers the whole payload, a
result cannot be flipped from fail to pass, and a tier 3 payload cannot be relabeled as tier 1. The
key id and algorithm are signed too, so a signature cannot be replayed under another key id or scheme.

## Serialization

Canonical JSON: every object's keys sorted by UTF-16 code unit (never by locale), no insignificant
whitespace (`scripts/ci/attestation/canonicalJson.ts`). The signed bytes are:

```
"auto-mobile attestation envelope v1\n"
<len(keyId)>:<keyId>\n
<len(algorithm)>:<algorithm>\n
<canonical payload JSON>
```

Lengths are byte lengths, so one field cannot be shifted into the next. The leading domain line
separates this protocol from any other use of the key and carries `envelopeVersion`, so the version is
signed too.

### Rules for a verifier in another language

The service verifies by recomputing these bytes from the parsed payload, so its serializer must match
byte for byte. It follows RFC 8785 (JSON Canonicalization Scheme), which the TypeScript side already
matches:

- Object keys sorted by UTF-16 code unit (JCS), not by UTF-8 bytes and not by locale. The two orders
  differ for characters outside the Basic Multilingual Plane, so Go must not use its default map-key order.
- Strings escaped minimally: `"` and `\`, the short forms `\b \f \n \r \t`, other control characters as
  lowercase `\u00xx`; everything else, including `<`, `>`, `&`, U+2028 and U+2029, stays raw UTF-8
  (Go's `encoding/json` escapes those by default and must be configured not to).
- Numbers as ECMAScript `Number.prototype.toString` (JCS 3.2.2.3). The payload carries integers and
  gate durations.
- The producer refuses what cannot be serialized identically: `undefined`, NaN, Infinity, negative zero
  and lone surrogates throw before anything is signed.

`test/scripts/attestation/canonicalJson.test.ts` pins a golden vector (canonical payload, signing bytes
and a deterministic signature under a fixed key) that the service's tests should reproduce.

## Signature scheme

**Ed25519** (RFC 8032), algorithm name `ed25519-v1`, signature base64 (88 characters). The producer
uses `node:crypto`; the service uses Go's `crypto/ed25519`.

`SUPPORTED_SIGNATURE_ALGORITHMS` lists `ed25519-v1` and nothing else; an envelope naming any other
algorithm, or none, is ignored and the job runs for real.

`Ed25519EnvelopeVerifier` (`scripts/ci/attestation/validators/ed25519Verifier.ts`) parses the envelope,
requires the supported algorithm, looks the key id up in a key directory, and verifies the signature
over the signed bytes. Every failure (unparseable, unsigned, other algorithm, unknown key, wrong key,
tampered payload) leaves the envelope unverified. It decides nothing by itself: base SHA and task come
from the caller's claims, never from the envelope.

A verified signature does not by itself make a tier skip a job. That also needs the producer key
directory (#11980), the decision service (#11979) and the GitHub App transport (#11981); without them
the gate stays shadow-only.

## Payload type registry

`scripts/ci/attestation/payloadTypes.ts` maps each type tag to its tier and its accepted versions.
A tag not listed, a version the tag does not list, or a tag used for another tier makes the envelope
fail to parse, and the job runs for real. A tier's payload version changes independently of the others.

## Validation order

1. Verify the signature against the producer's trusted public key (key valid, not expired, not revoked).
2. Only then dispatch on the type tag and version to the tier's validator.

Envelope code never reads payload contents beyond the bytes to verify. A test asserts that
`envelopeSigning.ts` and `canonicalJson.ts` import only `node:crypto` and each other.

## Reference implementations

- Producer side, used from pre-push: `signEnvelopeEd25519`, `Ed25519Signer`.
- Verifier primitive: `verifyEnvelopeEd25519`. The verifier-bound claims the validators require (key
  identity, base SHA, task) are bound by whatever calls it; the service does that.
- The Go reference verifier belongs to the service (#11979) and follows the byte format above.

## Background

- [Ed25519 for the attestation envelope](../../devlog/2026-10-27-attestation-envelope-ed25519.md)
