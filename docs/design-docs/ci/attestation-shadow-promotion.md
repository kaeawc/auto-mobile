# CI attestation shadow promotion

Shadow mode computes a tier decision while running CI normally. `agree` covers every run not classified as `false-hit`, `false-miss`, or `excluded`, including a skip whose CI run passed and correct non-skip decisions; `false-hit` is a would-skip whose run failed and signals a missing hash input; `false-miss` is a passing run with an attestation where a safe skip was forgone; `excluded` is cancelled CI. False hits are bugs to investigate, never tuning signals.

The injected `ShadowStore` directory contains `shadow-metrics.json`; the advisory action uses a runner-temp directory. The JSON shape is `{ schemaVersion: 1, records: ShadowRecord[], metrics: ShadowMetrics }`; metrics contain generated time and per-tier run, would-skip, hit, false-hit, false-miss, ignore-reason, bake-time, and run-id data.

| Tier | Lane                              | Promotion target | Minimum evidence                 | False-hit requirement |
| ---- | --------------------------------- | ---------------- | -------------------------------- | --------------------- |
| 1    | MCP server TypeScript, Bun, Turbo | Enforce skip     | 50 would-skip runs over 7 days   | 0 hits and 0 rate     |
| 2    | Gradle Android, desktop, IntelliJ | Enforce skip     | 100 would-skip runs over 14 days | 0 hits and 0 rate     |
| 3    | iOS XcodeGen                      | Advisory only    | 100 would-skip runs over 14 days | 0 hits and 0 rate     |

Tier 3 can be promoted beyond advisory only after a separate human review of its evidence and implementation readiness; this report never recommends a skip target for tier 3. Promotion is a human decision, never automatic.

## Unified shadow gate

All CI-only implementation code lives in `scripts/ci/attestation/`: the root owns
`attestationSchema.ts` and the producer, with `validators/`, `transport/`,
`shadow/`, and `gate/` beneath it. Tests mirror these directories under
`test/scripts/attestation/`. No shipped runtime module depends on these files.

The v1 wire envelope is unchanged. The verifier must bind the full canonical
payload, signing key, producer identity, base SHA, and task; base/task claims are
returned by verification rather than accepted as unsigned envelope additions.
CI independently checks `payload.commitId` against its selected commit. Unknown,
unsigned, unverified, partial, skipped-gate, stale, or mismatched inputs remain
ignored. Environment policy keys project from canonical `os`, `arch`,
`bunVersion` and `toolVersions`; policy-required version keys are never inferred
from producer data or relaxed when absent. The default verifier returns
`verified: false`, and its key registry trusts no keys.

`gate/defaults.ts` composes the service adapter, policy validators, producer's
lane input hasher, and recorder bridge. A service verdict can only lower the
independent local policy verdict. Invalid or incomplete transport configuration
remains unavailable. Every gate result has `applied: "run-tier"`; there is no
enforcement mode and no required-check change.

The bridge writes both the existing gate JSONL and `ShadowStore` metrics, with
independent failure handling. The action uploads both from the runner temp
directory, without accessing the user's data directory. `GITHUB_RUN_ID` identifies
the run. The `ci-result` action input (or `ATTESTATION_CI_RESULT` for the CLI) must
be the actual completed lane outcome. Its default is `cancelled`, which excludes
unknown/pending outcomes from correctness metrics. The standalone advisory PR
job does not yet observe completed lane results, so its observations are excluded;
promotion metrics require a caller that supplies those results. No gate becomes
required and no job depends on the shadow job.
