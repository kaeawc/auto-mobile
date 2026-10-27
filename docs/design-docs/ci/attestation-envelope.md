# Attestation signing envelope

Spec for #11974 (epic #11972). The envelope answers two questions and nothing else: is this
attestation authentic, and which payload schema is inside?

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

Lengths are byte lengths, so one field cannot be shifted into the next. The leading domain string
separates this protocol from any other use of the key.

## Signature scheme

**Ed25519** (RFC 8032), algorithm name `ed25519-v1`, signature base64 (88 characters).

- Built in on both ends: `node:crypto` for the producer, `crypto/ed25519` in Go for the service. No
  new dependency (checked: `node:crypto`, the installed packages, and the Go standard library).
- Deterministic signatures, 32-byte keys, fast verification, no parameter choices to get wrong.

Not chosen: ECDSA P-256 (nondeterministic unless hedged, malleable signatures), RSA (large keys, padding
choices), HMAC (the verifier would hold the signing secret).

**Not enabled yet.** `SUPPORTED_SIGNATURE_ALGORITHMS` stays empty until the owner approves the scheme,
so every attestation is still ignored (fail closed). Enabling it is adding `ed25519-v1` to that list.

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
- Go reference for the service lands with the service (#11979), against the byte format above.
