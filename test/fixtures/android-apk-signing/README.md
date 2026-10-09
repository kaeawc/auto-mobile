# Signed APK fixtures

Real APKs signed by `apksigner` 35.0.1 (build-tools 35.0.1, JDK 21), stored as base64 text so no
binary asset enters the tree. Each wraps the same two entries (`a.txt` and a compiled
`AndroidManifest.xml` taken from the control-proxy debug build) and differs only in how it is signed.
Signing keys are throwaway RSA-2048 keystores (`CN=Fixture a`, `CN=Fixture b`) that are not kept.

| File                       | Signing                                                                       |
| -------------------------- | ----------------------------------------------------------------------------- |
| `single-a.apk.b64`         | key A, `--min-sdk-version 24`, v2 + v3                                        |
| `single-b.apk.b64`         | key B, same content and flags (same app, different identity)                  |
| `multi-ab.apk.b64`         | keys A and B as two simultaneous v2 signers (`--next-signer`)                 |
| `v3-only-a.apk.b64`        | key A, `--min-sdk-version 28 --v1-signing-enabled false` (v2 + v3)            |
| `rotated-b-from-a.apk.b64` | lineage A to B (`apksigner rotate`); v2/v3 signer A (SDK 24-32), v3.1 B (33+) |
| `v1-only-a.apk.b64`        | key A, JAR (v1) signature only, no APK Signing Block                          |

`generate.sh.txt` is the exact script; `apksigner-verify-print-certs.txt` is the output of
`apksigner verify -v --print-certs` for each file, the ground truth for the SHA-256 digests the tests
assert (A = `f83432a1...e8ad`, B = `2dc8cc04...660e`). `v1-only-a` does not verify because its target
SDK needs v2+; it is only a "no signing block" sample.
