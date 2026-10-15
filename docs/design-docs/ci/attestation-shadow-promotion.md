# CI attestation shadow promotion

Shadow mode computes a tier decision while running CI normally. `agree` covers every run not classified as `false-hit`, `false-miss`, or `excluded`, including a skip whose CI run passed and correct non-skip decisions; `false-hit` is a would-skip whose run failed and signals a missing hash input; `false-miss` is a passing run with an attestation where a safe skip was forgone; `excluded` is cancelled CI. False hits are bugs to investigate, never tuning signals.

The recorder writes `ci-attestation/shadow-metrics.json` beneath the AutoMobile data directory. The JSON shape is `{ schemaVersion: 1, records: ShadowRecord[], metrics: ShadowMetrics }`; metrics contain generated time and per-tier run, would-skip, hit, false-hit, false-miss, ignore-reason, bake-time, and run-id data.

| Tier | Lane                              | Promotion target | Minimum evidence                 | False-hit requirement |
| ---- | --------------------------------- | ---------------- | -------------------------------- | --------------------- |
| 1    | MCP server TypeScript, Bun, Turbo | Enforce skip     | 50 would-skip runs over 7 days   | 0 hits and 0 rate     |
| 2    | Gradle Android, desktop, IntelliJ | Enforce skip     | 100 would-skip runs over 14 days | 0 hits and 0 rate     |
| 3    | iOS XcodeGen                      | Advisory only    | 100 would-skip runs over 14 days | 0 hits and 0 rate     |

Tier 3 can be promoted beyond advisory only after a separate human review of its evidence and implementation readiness; this report never recommends a skip target for tier 3. Promotion is a human decision, never automatic.
