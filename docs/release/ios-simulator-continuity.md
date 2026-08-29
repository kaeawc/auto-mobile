# macOS host contract for managed iOS simulator continuity

Tracking issue: #5104.

An iOS simulator appearing available after a deployment does **not** prove that
the same simulator process, simulator identity, or CoreSimulator data survived
the rollout. This document defines the host contract that a managed macOS worker
must satisfy so that continuity — or a controlled replacement — is _provable_,
and gives the repeatable validation that proves it before and after a real
deploy. A successful `simctl list` alone is never continuity evidence.

> **Redaction note.** This is a public document, so it uses **placeholders** for
> the managed host name, simulator UDIDs, process identifiers, and the owning
> team. Fill these in your internal deployment record, not here. The validation
> command emits a redacted artifact (see [Evidence retention](#evidence-retention-and-redaction))
> precisely so evidence can be retained and shared without exposing those values.

## 1. Host and deployment ownership boundary

Record the following in your internal deployment record (one row per managed
host). The bracketed values are placeholders.

| Field                       | Value                               | Notes                                                                                     |
| --------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| Managed macOS host          | `<host-identity>`                   | Hostname or stable host id of the worker.                                                 |
| Owning team                 | `<team>`                            | Who is paged when continuity fails.                                                       |
| Deployment trigger          | `<rollout-trigger>`                 | What starts a rollout (CI job, orchestrator, manual).                                     |
| Process supervisor          | `launchd` (typical)                 | Supervises the AutoMobile daemon, iOS control runner, and worker process.                 |
| AutoMobile data root        | `~/.auto-mobile`                    | Stable per-user base; see §3.                                                             |
| CoreSimulator data boundary | `~/Library/Developer/CoreSimulator` | Owned by the macOS `CoreSimulator` service, **outside** any package/temp extraction path. |

The four processes in scope are the **AutoMobile daemon**, the **iOS control
runner**, the **worker process** that drives leases, and the macOS
**CoreSimulator service** that owns simulator state. Continuity is a property of
the simulator + its CoreSimulator data across a rollout of the first three.

## 2. Supported continuity contract

A rollout of the worker or AutoMobile on a managed host must do exactly one of:

- **Preserve the booted simulator and its CoreSimulator data** — same UDID, same
  data root, booted and responsive throughout, worker reporting restored after
  the rollout completes. This is `same-device-continuity`.
- **Perform a controlled replacement of one idle simulator at a time** — an
  explicit lifecycle transition to a new/re-created device, declared as
  `plannedReplacement`. The replacement must clear the **same post-deploy proof**
  as a survival (booted, responsive, reporting, with a valid boot-session time)
  and stay **on the same managed host**; only then is it `controlled-replacement`.

Everything else is a continuity failure and is enumerated as its own outcome so
it can be distinguished (see §5): `boot-recovery`, `shutdown`, `reporting-delay`,
`orphaned-or-erased-state`, `failed-probe`, `incomplete-evidence`.

A controlled replacement must operate on an **idle** simulator (no active lease,
execution, or drain). Never replace a device that has active work — the validation
enforces this: a declared replacement of a device whose before-snapshot has
`activeWork: true` classifies as `orphaned-or-erased-state` (not proven), because
replacing a busy device destroys its in-flight state.

## 3. Why replacement cannot silently erase or orphan state

Two invariants keep a worker/AutoMobile process replacement from destroying
managed CoreSimulator state:

1. **AutoMobile's on-disk state has a stable, non-ephemeral root.**
   `resolveAutoMobileBaseDir` (`src/utils/tempDir.ts`) resolves
   `~/.auto-mobile` (overridable via `AUTOMOBILE_DATA_DIR`) and _deliberately_
   does not derive the base from `TMPDIR`/`TMP`/`TEMP`, which a package runner
   such as `bunx` may point at an ephemeral extraction dir (issue #2724). A
   process replaced from a fresh extraction therefore reattaches to the same
   daemon socket and data — it does not orphan a new tree.
2. **CoreSimulator data is owned by macOS, not by AutoMobile.** Simulator state
   lives under `~/Library/Developer/CoreSimulator/Devices/<UDID>/data`, owned by
   the `CoreSimulator` service. A rollout **must not** run `simctl erase`,
   `simctl delete`, or wipe that tree as part of replacing the worker or
   AutoMobile. Erasing a device is only permitted as the _explicit_ first step of
   a declared controlled replacement of an idle device.

The validation in §4 makes a violation of either invariant observable: a changed
UDID or a changed CoreSimulator data root **without** a declared
`plannedReplacement` classifies as `orphaned-or-erased-state` and fails the gate.

## 4. Repeatable validation

The gate is `bun run validate:ios-continuity`
(`scripts/validate-ios-simulator-continuity.ts`), wrapping the pure classifier in
`src/utils/iosSimulatorContinuity.ts`. It reads a **before** and **after**
evidence snapshot for one managed simulator, classifies the outcome, prints a
redacted summary, and **exits non-zero unless continuity is proven**.

Run it from a **source checkout of the auto-mobile repo** on the managed host —
like the repo's other `validate:*` / `check:*` scripts, it is release-engineering
tooling and is not shipped in the published npm package. The deployment owner
already has the repo (they build/cut AutoMobile), so `bun install && bun run
validate:ios-continuity …` from that checkout is the intended invocation. All
timestamps must be strict ISO-8601 with a timezone (e.g. `2026-08-07T10:00:00Z`).

### Evidence to capture (before and after the deploy)

For each managed simulator selected for validation, capture a JSON snapshot with
these fields (all in the issue's required pre/post-deploy evidence list):

| Field                             | Example source                                                                                                                                                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `udid`, `runtimeDeviceType`       | `xcrun simctl list devices --json`                                                                                                                                                                                                 |
| `hostIdentity`                    | `scutil --get LocalHostName` (or your stable host id)                                                                                                                                                                              |
| `automobileVersion`               | AutoMobile package/version reported by the daemon                                                                                                                                                                                  |
| `workerIncarnation`               | worker process incarnation id (changes on replacement)                                                                                                                                                                             |
| `processSupervisor`, `processIds` | `launchctl` / `ps`. `processIds` **must** include positive-integer PIDs for the keys `daemon`, `runner`, and `coreSimulatorService` (`com.apple.CoreSimulator.CoreSimulatorService`); a missing role is `incomplete-evidence`      |
| `coreSimulatorDataRoot`           | `~/Library/Developer/CoreSimulator/Devices/<udid>/data`                                                                                                                                                                            |
| `bootedSince`                     | boot time of the current session (used to detect a boot-session change between the before and after captures) — **required for a proven verdict**: without it a reboot cannot be ruled out, so the result is `incomplete-evidence` |
| `lifecycleState`                  | `booted` / `shutdown` / … from `simctl list`                                                                                                                                                                                       |
| `responsive`                      | result of a responsiveness probe against the device                                                                                                                                                                                |
| `reportingStatus`                 | `reporting` / `delayed` / `lost` from the worker/AutoMobile status                                                                                                                                                                 |
| `activeWork`                      | whether a lease, execution, or drain was present                                                                                                                                                                                   |

Also capture a `deploy` window: `startedAt`, `completedAt`, and
`plannedReplacement` (true only for a declared controlled replacement).

### Run the gate

```bash
bun run validate:ios-continuity \
  --before before.json \
  --after after.json \
  --deploy deploy.json \
  --out redacted-evidence.json
```

`--deploy` is **required**: reboot detection is only meaningful against a real
deploy window, so there is no sound default for it. Exit codes: `0` continuity
proven, `1` not proven (verdict printed), `2` usage error or bad input (missing
file / malformed JSON, kept distinct from a not-proven result). Wire the non-zero
exit into the deploy so an unproven rollout fails.

## 5. Distinguished outcomes

The classifier never conflates "listed" with "continuous". It reports exactly
one verdict:

| Verdict                    | Meaning                                                                                                                                                                            | Proven? | Recommended state |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------- |
| `same-device-continuity`   | Same UDID + data root, booted/responsive throughout, reporting restored.                                                                                                           | yes     | available         |
| `controlled-replacement`   | Declared replacement; new device booted and responsive.                                                                                                                            | yes     | available         |
| `boot-recovery`            | Same UDID + data, but the boot session changed between the before/after captures — a reboot at any point after the pre-deploy capture (data safe, booted session did not survive). | no      | maintenance       |
| `shutdown`                 | Same device is no longer booted and did not recover.                                                                                                                               | no      | maintenance       |
| `reporting-delay`          | Device continuous but worker reporting delayed/lost.                                                                                                                               | no      | maintenance       |
| `orphaned-or-erased-state` | UDID, data root, or host identity changed with no declared replacement (also: a controlled replacement of a device that had active work).                                          | no      | maintenance       |
| `failed-probe`             | Post-deploy state or responsiveness could not be determined.                                                                                                                       | no      | maintenance       |
| `incomplete-evidence`      | Required identity/context evidence missing, `bootedSince` absent, or the pre-deploy baseline was not booted+responsive — continuity of a healthy device cannot be proven.          | no      | maintenance       |

The gate proves continuity, so it holds evidence to a high bar: the before/after
pair must be from the **same managed host** (a differing `hostIdentity` reads as
`orphaned-or-erased-state`), the **pre-deploy baseline must itself be healthy**
(booted + responsive), and `bootedSince` must be present to rule out a reboot.
Anything short of that is not proven, not silently accepted.

## 6. Failure and rollback

When the gate returns non-zero:

1. Leave the affected simulator **visibly unavailable / in maintenance** — its
   recommended state is `maintenance`. A worker process that merely restarted
   must **not** report the device as leaseable until fresh evidence proves
   continuity. A failed replacement stays unavailable, not silently re-listed.
2. Do not re-mark the device available on the strength of an inventory listing.
   Only a `same-device-continuity` or `controlled-replacement` verdict from a new
   before/after capture returns it to `available`.
3. For `orphaned-or-erased-state`, treat managed CoreSimulator data as
   potentially lost: recover from your device provisioning source and re-run the
   validation before returning the host to the pool.

## Evidence retention and redaction

The `--out` artifact is a **redacted** evidence record: host identity, UDIDs,
process ids, and home-dir paths are replaced with one-way tokens that preserve
equality **within the artifact** (so a reader can still tell "same device before
and after" or "the worker was replaced") without exposing raw values. Each artifact
uses a **fresh random salt**, so the tokens cannot be de-anonymized by
precomputing hashes for guessable inputs such as PIDs or predictable host names —
a fixed, committed salt would not protect those low-entropy fields. The trade-off
is that tokens do not correlate across separate artifacts (not needed here).
Non-sensitive fields (runtime/device type, AutoMobile version, lifecycle,
reporting, timestamps) are kept verbatim. Retain this redacted artifact with the
deployment record; it is safe to attach to a public issue.
