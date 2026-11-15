# Session broker experiment: Android keep-booted and snapshot reset

Part of [the session-only provider experiment](session-broker-experiment.md).

## Android keep-booted

Selected by `androidResetMode: "keep-booted"` only with `reuseAndroidCleanDevices`
and Android defaults (ignored reset keys are rejected by config validation).
`androidKeepBootedMaxUses` (positive int, default 20) retires to the baseline
strategy or destruction at that count. Counts are resource-local. Restart loses
the in-memory reset receipt; a persisted baseline without it marks the incarnation
retired (next release must destroy; no counter reset or fallback re-entry to idle).
The journal incarnation is the broker resource ID plus stable native device
identity and kernel boot UUID (not the per-release binding generation), so a
recycled serial or reboot cannot transfer a baseline. Binding generations still
fence reset ownership.

Keep-booted is operational cleanup (#14358, #14364): no baseline diff or post-clean
certification is required, and certification metadata never blocks it.

**Baseline** (persists across sessions of the incarnation): package membership for
all packages and users; identities and runtime grants for third-party apps only
(avoids a per-system-package `dumpsys` sweep); global (once) and system/secure
(per user) settings dumps; display overrides; locale; timezone; SHA-256 digest of
the account inventory (never raw names); file inventories under `/sdcard/Download`,
`DCIM`, `Pictures`, `Movies`, `Documents`.

**Every release**: journal reverts in reverse order, then unconditional baseline
cleaning (so journal ops cannot reintroduce drift):

- `pm list users`; `pm uninstall --user` every third-party package absent from that
  user's baseline.
- Keep baseline app data and fixtures; never `pm clear` by default. Revoke runtime
  grants not in the baseline for retained third-party apps per user; never run
  device-wide `pm reset-permissions`.
- Restore changed/missing global/system/secure keys. Delete an added key only when
  the session journal proves the session created it (a raw `ns:key` row with an
  absent prior, or a key owned by a journaled rotation, screen-reader or keep-awake
  tool). Keys absent from the baseline without that evidence, such as
  system-maintained ringtone, alarm and `opa_enabled` settings, are preserved
  (settings commands target the captured user, including 0). Non-critical failures warn and
  continue; connectivity, adb/developer, or accessibility restoration failure is
  hard.
- Remove added regular files under the inventoried roots with canonical-path and
  symlink guards; preserve baseline paths even if contents changed.
- Clear the clipboard when supported (unsupported warns and skips; a failed
  supported clear is hard).

Unplannable journal entries warn and skip rather than veto reuse; journal replay
never removes baseline packages. Every command is ownership-fenced, cancellable,
bounded, non-retrying: 2 s each, 10 s for uninstall, up to 30 s for baseline file
hashing, all within the enclosing 30 s cleaning/capture cap. Afterward boot
completion, package-manager responsiveness and a single CtrlProxy probe (2 s) are
checked. Timeout/cancel aborts cleaning and waits up to 2 s for settlement; an
exhausted drain never starts snapshot fallback. Success reports `mode:
"keep-booted"`, `outcome: "clean"` with `journal`, `clean`, `health` phases.

**Failure/fallback**: hard failure or failed health uses the injected snapshot
fallback if configured, otherwise journaled destruction; ownership loss never
publishes idle or runs fallback under a stale fence. `maxUses` retires the same
way. Fallback health must pass before idle; the report uses the completed
fallback's mode (`snapshot`/`wipe-data`) and keeps both the cleaning/retirement
reason and the snapshot's fallback reason. `androidKeepBootedFallback:
"snapshot"` injects it (omitted/`"destroy"` keeps destruction); it and
`androidKeepBootedMaxUses` are valid only in keep-booted mode. Snapshot support
needs the daemon readiness and identity ports; missing ports reject startup.

Snapshot fallback uses an exclusive binding fence, not the old boot UUID (restore
can change it). After successful restore (or wipe-data replacement) exact
target/boot checks rebind the incarnation, prune prior mutation journals and
recapture a keep-booted baseline under the new boot identity; recapture or final
health failure requires destruction. Fallback native phases carry a `snapshot:`
prefix alongside the keep-booted phases.

**Limits**: does not remove accounts/secrets, reset retained app databases/data,
undo system package updates, rebuild overwritten/deleted baseline files,
comprehensively restore AppOps/permission flags, remove users, or clean
secondary-user shared storage/media-provider state. Residual state is accepted when
commands and health checks succeed; it is not equivalent to snapshot/wipe-data
isolation.

**Journal prior-value shapes** for supported targeted reverts:

| Kind                     | Key / prior                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `installed-app`          | package key, absent prior (force-stop then uninstall); needs explicit `user:<id>:<package>` key, never every user   |
| `permission`             | `runtime:<user>:<pkg>:<perm>` boolean, or `appops:<user>:<pkg>:<op>` mode (absent = default)                        |
| settings                 | `global\|secure\|system:<key>` string or absent, `settings put`/`delete`; connectivity/DND use the platform service |
| display / clock          | `display:density\|size\|night-mode`; `timezone` via alarm service                                                   |
| `shared-file`            | absent-prior `/sdcard` file; path guards, media-scan request; existing contents cannot be rebuilt                   |
| `preference`             | app-data clearing skipped (preserves fixtures)                                                                      |
| `location` / `clipboard` | absent-prior `provider:gps\|network\|fused` / empty prior                                                           |

Not qualified as revert adapters: system locale, system package update rollback,
account removal, notification cancellation, existing app/file data, network
shaping. No tool instrumentation is silently enabled (the journal's
pending-adapter ledger applies). The strategy retains journal entries through
health checks and settlement; fenced retirement pruning deletes incarnation
baselines and their session entries. Capture is capped at the cleaning budget
(30 s) within the remaining preparation budget. The snapshot fallback uses
`androidResetTimeoutMs`, limited to the time remaining, with 2001 ms reserved for
the command-settlement drain; it receives `signal`, `timeoutMs`, `deadlineMs` in
the shared reset context.

## Android snapshot reset and fallback

`androidResetMode: "snapshot"` selects the full-baseline strategy directly (also
requires Android defaults and `reuseAndroidCleanDevices: true`).

```json
{
  "reuseAndroidCleanDevices": true,
  "androidResetMode": "keep-booted",
  "androidKeepBootedFallback": "snapshot",
  "androidKeepBootedMaxUses": 20,
  "androidResetTimeoutMs": 600000
}
```

`androidResetTimeoutMs` is a positive integer ms (max 2147483647), accepted only
for snapshot mode or keep-booted with snapshot fallback (ignored keys rejected).
Default 600000 covers the whole release reset: cleaning, fallback, rebinding,
final health. Keep-booted keeps its 30 s cap; the fallback gets a fresh
cancellable budget bounded by the remaining deadline minus the settlement reserve;
individual snapshot commands keep a 30 s cap; clock root and transport reconnection
keep their own bounded timeouts.

Snapshot mode captures the reserved, hidden broker baseline only on a freshly
created or replaced emulator (keep-booted snapshot fallback captures it during
initial preparation, not after cleaning fails). AVD, image revision/hardware,
emulator and CtrlProxy identity must match before load. Restore goes through
incarnation preparation, host-state invalidation, exact-serial readiness and
settlement before health is accepted. A failed/incompatible load attempts a
capacity-reserved same-AVD, same-serial wipe-data replacement. Shutdown must prove
the emulator process exited (not merely vanished from adb) and remove dirty
`default_boot` state; relaunch preserves `AUTOMOBILE_EMULATOR_ARGS`, appends
wipe/no-snapshot flags and releases the launch cancellation handle before
readiness. Failed snapshot plus wipe-data requires journaled destruction.

Snapshot clean-reuse isolation is unqualified: no native two-session contamination check
has passed (fake-backed tests qualify composition and fencing only). Zero pooling stays the
throughput baseline; native results are in
[Session broker native qualification](../devlog/2026-10-23-session-broker-experiment-native-qualification.md).
