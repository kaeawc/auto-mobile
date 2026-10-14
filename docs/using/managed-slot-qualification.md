# Managed-slot qualification

## What qualification proves

Qualification binds reproducible case results to an identified artifact. The
three proof levels are separate:

- `source-tests`: `bun test` on a commit, with an explicit test-file list.
- `local-build`: a tarball packed from a checkout, identified as `local-build`.
- `published-package`: the extracted npm tarball whose integrity equals
  `npm view @kaeawc/auto-mobile@<version> dist.integrity`, identified as
  `published-package`.

Each case states its proof level. Supply an identity when aggregating; a summary
must never mix artifacts. Without an identity, results are explicitly unbound.
Source tests and injected faults do not establish native recovery behavior.

## Identify the artifact

Build and pack a local candidate, then extract it:

```bash
bun run build
npm pack
mkdir pkg && tar -xzf <tgz> -C pkg
bun run qualify:identity --package-dir pkg/package --tarball <tgz> \
  --repo . --expect-source-sha <sha> --out identity.json
```

The package is under `pkg/package`. For published proof, download the exact npm
version's tarball, extract it, and add `--expected-integrity <sri>` using the
registry's `dist.integrity`. The identifier checks package contents against the
tarball, required runtime assets, source SHA, native-resource checksum pins and
the shipped managed-slot contract. It refuses a source checkout even if built.

`package_file_types` refuses symlinks and other non-regular entries outside
`node_modules/.bin/`; links in that directory are counted. `published_exactness`
warns when extra files (including allowed `node_modules/` files) or any non-regular
entries prevent published proof: use an exact `tar -xzf` extraction.

A local build whose source SHA differs from the release tag for the same version
receives a warning that it is not that release. That disagreement fails published
proof; `--expect-source-sha` mismatches always fail.

`dist/build-info.json` exists in packages packed after this change. Older packages
fall back to a release tag resolved in `--repo`. Version `0.0.84` resolves to
`b51bfe50dfeb608ed838acf89481b70652084b81`, so
`--expect-source-sha d78115c7b861d8a051152fc6f79bd1eebdd13154` refuses it.
The runner SHA lives inside the IPA and is only recorded, not independently
verified by the identity tool.

## Contract and compatibility

[schemas/managed-slot-contract.json](../../schemas/managed-slot-contract.json)
is also shipped in the package. These rows describe its compatibility boundary;
`native-qualification` identifies evidence still owed, not a passing test.

| ID                                  | Supported | Outcome                        | Verified by          |
| ----------------------------------- | --------- | ------------------------------ | -------------------- |
| v1-on-current-daemon                | yes       | acquire                        | unit-test            |
| frontend-daemon-build-mismatch      | no        | contract_unsupported           | unit-test            |
| v1-on-v1-only-daemon                | yes       | acquire                        | unit-test            |
| device-family-on-v1-only-daemon     | no        | contract_unsupported           | unit-test            |
| device-family-on-current-daemon     | yes       | acquire                        | unit-test            |
| any-on-daemon-without-managed-slots | no        | contract_unsupported           | unit-test            |
| contract-version-2                  | no        | contract_unsupported           | unit-test            |
| multi-device-group                  | no        | managed_slot_group_unsupported | unit-test            |
| unmanaged-frontend-shares-daemon    | yes       | unmanaged                      | native-qualification |

Unsupported compatibility rows are refused before mutation. A daemon handshake
version or build mismatch is non-retryable `contract_unsupported`; restart the
daemon from this client's installation. A restart cooldown remains retryable.
`registry.olderBuildOnNewerRegistry` is refused before any write with
`registry_schema_unsupported` (non-retryable). Upgrade every daemon sharing the
registry to the build that migrated it, restarting older daemons. Packages
`<=0.0.84` have no managed slots.

## Recording cases

Prepare directories under `scratch/qualification/<run>/`, including `cases/`.
Commands below are templates; replace placeholders with the case's reproducible
command. Device work goes through the [manual-test harness](manual-test-harness.md)
and its private environment, never the resident daemon.

```bash
bun run qualify:run-case --case-id android.reuse-stable-device \
  --title 'Reuse stable device with a fresh session' --platform android \
  --proof-level local-build --observation native --matrix-item 1 \
  --identity identity.json --fixture target=fixture-android-target \
  --evidence scratch/qualification/<run>/reuse.json:json \
  --out scratch/qualification/<run>/cases/reuse.json -- <harness-command> <args>

bun run qualify:run-case --case-id host.injected-registry-busy \
  --title 'Injected registry busy' --platform host --proof-level source-tests \
  --observation injected-fault --fault-mechanism fake-registry --fault sqlite-busy \
  --fixture registry=fixture-busy-registry \
  --out scratch/qualification/<run>/cases/busy.json -- bun test <explicit-test-file>

bun run qualify:run-case --case-id ios.native-io-fault \
  --title 'Native registry I/O fault' --platform ios --proof-level local-build \
  --observation native --matrix-item 6 --identity identity.json \
  --not-exercised --boundary 'Host cannot induce native disk I/O failure; injected coverage only.' \
  --out scratch/qualification/<run>/cases/io-gap.json -- <harness-command> <args>
```

Injected faults are never native observations; the schema rejects `native` at
`source-tests` level. Fixture identifiers must be sanitized `fixture-…` values,
never serials or UDIDs. Sanitize command arguments, paths and log contents too;
the schema cannot infer identifiers embedded in free text.

The observation label is declared by the operator and reviewed in the summary;
the schema blocks only `native` at `source-tests` level and cannot detect a
mislabelled case.

The runner validates before execution, records repo-relative cwd, command timing,
evidence SHA-256s when files exist, and the command's exit status. Missing evidence
has a null hash. `--not-exercised` records the intended command without running it
and requires a supported boundary. It records zero durations. The format also
supports named operation timings and budgets from case-specific producers; an
over-budget measurement is valid evidence and produces an aggregation warning.

## Aggregating

```bash
bun run qualify:aggregate --results scratch/qualification/<run>/cases \
  --identity identity.json --markdown summary.md --require-pass
```

The aggregator validates every non-recursive `*.json` case file, rejects duplicate
platform/case pairs and mixed artifact bindings, and separates native observations,
injected faults, deterministic tests and gaps. Null artifact fields generate warnings
with an identity. Exit 1 means validation errors, or a failed/blocked case with
`--require-pass`; `not-exercised` remains a recorded gap, not a pass. Usage errors
exit 2. Generate/check the format with
`bun scripts/qualification/caseResult.ts --write` / `--check`.

## Retry and recovery by failure code

Retryability below is the nested acquisition failure's value. Client class comes
from the refusal-wire expectations: the outer `managed_slot_acquisition_failed`
envelope is classified `fail` even when its nested cause is retryable. Read
`automobile:managed-slots` before relaunching; do not blindly retry a tool call on
the same failed execution. Source paths identify production guidance replacing
synthetic fixture text.

| Code                                 | Retryable | Client class        | Recovery                                                                                                                                                                                |
| ------------------------------------ | --------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cancelled`                          | yes       | fail                | The preparation was cancelled; retry when needed. (src/daemon/managedSlots/managedSlotAcquisition.ts)                                                                                   |
| `capacity_exhausted`                 | yes       | fail                | Shut down a device or raise the boot limit, then retry. (src/daemon/managedSlots/reconciler.ts)                                                                                         |
| `cleanup_pending`                    | yes       | fail                | The previous device could not be removed; retry after cleanup succeeds. (src/daemon/managedSlots/reconciler.ts)                                                                         |
| `concurrent_modification`            | yes       | fail                | The slot changed concurrently; retry to converge on its new state. (src/daemon/managedSlots/reconciler.ts)                                                                              |
| `contract_unsupported`               | no        | fail                | Restart the daemon from a build that supports managed slots. (src/daemon/managedSlotProxyAcquisition.ts)                                                                                |
| `daemon_unavailable`                 | yes       | fail                | Retry once the AutoMobile daemon is reachable. (src/daemon/managedSlotProxyAcquisition.ts)                                                                                              |
| `device_busy`                        | yes       | fail                | Wait for the device's live session or foreign claim to end, then retry. (src/daemon/managedSlots/reconciler.ts)                                                                         |
| `discovery_incomplete`               | yes       | fail                | Retry once device discovery completes; nothing destructive was done. (src/daemon/managedSlots/reconciler.ts)                                                                            |
| `execution_hold_failed`              | yes       | fail                | Relaunch the execution; the slot keeps its device. (src/daemon/managedSlotProxyAcquisition.ts)                                                                                          |
| `execution_policy_failed`            | yes       | fail                | Retry; the session could not be held for the execution. (src/daemon/managedSlots/managedSlotAcquisition.ts)                                                                             |
| `liveness_owner_conflict`            | yes       | fail                | Retry; another owner claimed the slot's session. (src/daemon/managedSlots/managedSlotAcquisition.ts)                                                                                    |
| `managed_slot_config_invalid`        | no        | fail                | Fix the managed slot config; nothing changed. (src/daemon/managedSlotProxyAcquisition.ts)                                                                                               |
| `managed_slot_group_unsupported`     | no        | fail                | "managed slot groups larger than 1 slot/device are not supported"; not retryable. (src/models/managedSlotConfig.ts)                                                                     |
| `managed_slots_unsupported`          | no        | fail                | managed slots not yet supported by this build; remove --managed-slot-config / AUTOMOBILE_MANAGED_SLOT_CONFIG to run an unmanaged proxy (src/models/managedSlotConfig.ts)                |
| `managed_slot_budget_exhausted`      | yes       | fail                | Reset or release managed slot scopes that are no longer needed, or raise AUTOMOBILE_MANAGED_SLOT_MAX_DEVICES, then retry. (src/daemon/managedSlots/reconciler.ts)                       |
| `provision_failed`                   | no        | fail                | Inspect the provision failure code; retry if it is retryable. (src/daemon/managedSlots/reconciler.ts)                                                                                   |
| `readiness_incomplete`               | yes       | fail                | Retry; the device did not reach automation readiness. (src/daemon/managedSlots/reconciler.ts)                                                                                           |
| `reconcile_in_progress`              | yes       | fail                | Another reconciliation of this slot is in progress; retry later. (src/daemon/managedSlots/reconciler.ts)                                                                                |
| `registry_schema_unsupported`        | no        | fail                | Upgrade this daemon and every daemon sharing the registry to the build that migrated it, restarting older daemons; nothing was changed. (src/daemon/managedSlots/managedSlotRefusal.ts) |
| `runtime_incompatible`               | no        | fail                | Request a model/runtime pair the host supports; nothing was changed. (src/daemon/managedSlots/reconciler.ts)                                                                            |
| `scope_invalidated`                  | no        | fail                | This runner incarnation was reset; launch with the current runnerIncarnation. (src/daemon/managedSlots/managedSlotAcquisition.ts)                                                       |
| `scope_not_valid`                    | no        | fail                | Use the current runner incarnation; this scope no longer accepts work. (src/daemon/managedSlots/reconciler.ts)                                                                          |
| `scope_transition_pending`           | yes       | fail                | Wait for the previous runner incarnation's executions and cleanup to settle, then retry. (src/daemon/managedSlots/managedSlotAcquisition.ts)                                            |
| `slot_in_use`                        | yes       | fail                | Wait for the slot's live execution to end, then retry. (src/daemon/managedSlots/reconciler.ts)                                                                                          |
| `slot_settling`                      | yes       | fail                | Wait for the previous execution's released work to settle, then retry. (src/daemon/managedSlots/reconciler.ts)                                                                          |
| `spec_unsupported`                   | no        | fail                | Fix the requested spec; nothing was changed. (src/daemon/managedSlots/reconciler.ts)                                                                                                    |
| `stale_session`                      | yes       | fail                | Retry; an earlier execution's session on the slot device could not be released. (src/daemon/managedSlots/reconciler.ts)                                                                 |
| `timeout`                            | yes       | fail                | Retry with a longer preparationTimeoutMs. (src/daemon/managedSlots/managedSlotAcquisition.ts)                                                                                           |
| `managed_slot_acquisition_failed`    | no        | fail                | Tool call on a proxy whose acquisition failed; carries the underlying failure.                                                                                                          |
| `device_assigned_to_managed_slot`    | no        | fail                | It stays reserved while idle; use another device, or reset the slot's scope to release it.                                                                                              |
| `device_outside_managed_slots`       | no        | fail                | Slot devices are acquired, started, stopped and deleted only by managed slot acquisition and release. Reads stay open; use a separate MCP connection for anything else.                 |
| `managed_slot_ownership_unconfirmed` | yes       | retry               | Slot ownership is not recorded for this daemon yet (the managed slot registry is busy or the slot is not ready); retry shortly.                                                         |
| `managed_execution_ended`            | no        | fail                | "device calls are refused until the runner relaunches the execution; reads that name a deviceId still work." (`relaunch_execution`) (src/server/deviceSessionResult.ts)                 |
| `session_ownership_lost`             | no        | acquire-new-session | "Acquire a new device with getAndroid or getApple." (`acquire_new_session`) (src/daemon/managedSlots/managedSlotRefusal.ts)                                                             |

## What qualification still requires

Both native matrices are owed: Linux/Android and macOS/iOS, using isolated named
resources and independent frontend/daemon processes on the identified artifact.
Issue #12060 items 1–10 require:

1. Stable-device reuse with fresh sessions, partial specs, changed defaults and
   family constraints; invalid profiles/specs preserve a good assignment.
2. Cache headroom, shared-cap eviction, concurrent reservations and confirmed
   deletion; protected idle assignments and uncertain inventory/teardown.
3. Tool-free managed heartbeats beyond idle expiry; owner death, heartbeat lapse,
   execution completion and ordinary-session policy.
4. Cancelled/refused acquisition, lost replies, final-heartbeat stalls, delayed
   native completion and restoration failures within preparation/settlement budgets.
5. Crashes around deletion, creation, readiness, assignment commit and handoff;
   SIGTERM, EOF, SIGKILL, daemon restart and frontend suspension/resume, without
   repeating committed destructive work.
6. A real peer SQLite write lock, injected busy/full/I/O and malformed inventory;
   exclusion, journal coverage, bounded shutdown, durable cleanup and event-loop
   stall measurements against heartbeat budgets.
7. Delayed execution-A cleanup after B starts; session/slot/device fencing of
   recording, observation, viewer, network-rule and resource cleanup with provenance.
8. Retained-device restoration, including delayed/lost network clear and device-side
   proof that old rules/simulations no longer affect the next execution.
9. Reported capacity versus cold/peer boot admission and external-resource attribution.
10. V1 refusal of multi-device groups before mutation, retaining the role-keyed
    future contract without requiring group implementation.

Research gates remain owed: prove request-owned native descendants and asynchronous
work terminate or remain durably fenced after cancellation/process death; retained
emulators/simulators are intentional. Vet execution-owner PID reuse with native
evidence, or document the measured limitation and a narrow follow-up. Numeric PID
liveness and a deterministic generation model alone do not prove native impact.

Record every unexercised platform/fault case and its supported boundary. Resolve
boundaries that contradict the supported contract, then publish the tested version
and its evidence. These source tools do not complete native qualification or publication.
