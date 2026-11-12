# Ed25519 for the attestation envelope

- Kind: decision
- Date: 2026-10-27
- Source: moved from `how-it-works/ci/attestation-envelope.md`; #11972, #11974, #15551, #15586
- Shaped: [Attestation signing envelope](../how-it-works/ci/attestation-envelope.md)

## Context

The CI attestation envelope (#11974, epic #11972) needs a signature scheme that a TypeScript producer
and a Go verifier service can both implement byte for byte.

## Options

- Ed25519 (RFC 8032).
- ECDSA P-256: nondeterministic unless hedged, malleable signatures.
- RSA: large keys, padding choices.
- HMAC: the verifier would hold the signing secret.

## Decision

Ed25519, named `ed25519-v1`. It is built in on both ends (`node:crypto` for the producer,
`crypto/ed25519` in Go), so it adds no dependency (checked: `node:crypto`, the installed packages, and
the Go standard library). Signatures are deterministic, keys are 32 bytes, verification is fast, and
there are no parameter choices to get wrong. The owner enabled it on #11972, with a fail-closed
verifier (#15586).

## Consequences

`SUPPORTED_SIGNATURE_ALGORITHMS` holds only `ed25519-v1`; any other algorithm leaves the envelope
unverified and the job runs for real. Enabling the algorithm does not make a tier skip a job on its own:
the key directory (#11980), decision service (#11979) and GitHub App transport (#11981) are also
required.
