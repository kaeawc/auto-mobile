# Live device acceptance

The issue #7144 harness is an operator-run, destructive acceptance matrix for two explicit virtual devices: one Android AVD and one iOS simulator. It is never part of PR CI. Use only dedicated, disposable, test-owned devices.

## Ownership and controls

Before a live run, record the exact targets and three controls in a signed ownership manifest with an operator-held 32-byte key:

- a distinct Android sibling AVD;
- a second live serial for the same Android AVD (the signed duplicate);
- an iOS sibling with the same display name but a different UUID.

The Android control set must contain exactly one intended target instance, exactly one signed duplicate and exactly one unrelated sibling. A duplicate request must fail with `identity_conflict` naming both serials. The driver then stops only the signed duplicate serial, requires it to disappear, proves the surviving serial is selected through `avdName` plus `deviceId`, and keeps the sibling unchanged. The iOS target UUID and same-name sibling must both remain present and unchanged. Controls are rechecked before and after provisioning, target stop/reacquisition and each persisted-recovery transition; a missing, changed or extra unsigned control fails the run before another destructive action. Flags alone never authorize adoption.

The harness starts two short-lived acceptance MCP proxies, one with forward and one with reverse discovery presentation. The proxy carries that non-mutating per-request control through the daemon, so real `listDevices`, `getAndroid` and `getApple` logic sees the same fresh inventory in opposite orders. The run fails if the inventory is not exactly reversed or selection/duplicate rejection differs by order.

## Running

Put evidence, manifest and key in a dedicated acceptance directory, not a shared one such as `/tmp`. The harness creates missing directories as `0700` but never changes an existing directory's permissions; an existing directory must already be `0700` or the harness fails before building or touching a device. Recording ownership records authority only; it creates, deletes and mutates no device. The two commands share one argument set:

```bash
bun run bootstrap:worktree
ARGS=(
  --android-avd-name "acceptance-pixel-9"
  --android-sibling-avd-name "acceptance-pixel-9-sibling"
  --android-duplicate-serial "emulator-5560"
  --android-runtime "system-images;android-36;google_apis;x86_64"
  --android-device-type "pixel_9"
  --android-memory-mb "4096" --android-cpu-cores "4"
  --android-min-os-version "16.0" --android-max-os-version "16.0"
  --ios-simulator-name "Acceptance iPhone 17"
  --ios-simulator-uuid "00000000-0000-0000-0000-000000000000"
  --ios-same-name-sibling-uuid "00000000-0000-0000-0000-000000000001"
  --ios-runtime "com.apple.CoreSimulator.SimRuntime.iOS-26-0"
  --ios-device-type "com.apple.CoreSimulator.SimDeviceType.iPhone-17"
  --ios-min-os-version "25.0" --ios-max-os-version "26.0"
  --operator-key-file scratch/live-device-acceptance/operator.key
  --ownership-manifest scratch/live-device-acceptance/ownership.json
)

# 1. Record ownership (no device mutation)
bash scripts/run-live-device-acceptance.sh --record-ownership-manifest --create-operator-key "${ARGS[@]}"

# 2. Live run
AUTOMOBILE_ACCEPTANCE_LIVE=1 bash scripts/run-live-device-acceptance.sh \
  --confirm-live --test-owned-devices "${ARGS[@]}"
```

- The wrapper rejects overlapping control identities before building or invoking the driver; the TypeScript driver repeats that validation and requires the signed manifest's Android and iOS entries to bind the identical control set.
- The driver itself requires `--confirm-live`, `--test-owned-devices` and `AUTOMOBILE_ACCEPTANCE_LIVE=1`, so invoking it directly cannot bypass the live-mutation guard.
- Stable identities, names, runtimes, device types and OS bounds are all required so a discovered device can never be substituted. The iOS name is required separately from the UDID because preflight validates their ownership mapping and provisioning needs both.
- Android then iOS run under one total deadline with a smaller per-platform deadline; the 2 s TERM-to-KILL grace is reserved from each driver budget. Control observations run inside the existing work budget.
- The wrapper runs `bun run build` once and uses only `dist/src/index.js` for every MCP subprocess, CLI call and daemon restart; it never falls back to a global `auto-mobile`.

## Matrix

- **CLI to MCP session handoff.** A real short-lived CLI process acquires the exact target and its `sessionUuid` is captured; after that process exits, an independently created MCP client must run `observe` and `getDeviceState` with that UUID. The reverse direction is not acceptance evidence.
- **Persisted-session restart (acceptance-only).** A daemon-generation HMAC binds expiry, one session UUID, platform, stable target identity and the signed control set. It proves a busy exact target fences the old UUID, then permanently deletes only the exact signed target and requires complete platform-inventory absence while the signed sibling remains. The old UUID must fail with the exact `target-busy` or `target-absent` recovery reason, become durably terminal and never operate the sibling; only an explicit fresh UUID may acquire the sibling. The daemon rejects active operations, an unrelated session, a changed generation, or a process without the startup secret, and crash-restarts only that daemon generation, never a device. Deletion is deliberately last (deterministic cleanup); a later live run needs a newly provisioned, signed target.
  - Android same-serial/different-AVD replacement is covered by the real pool recovery regression. iOS cannot express it because a simulator UDID is both stable identity and daemon transport key, so deletion reports `target-absent` and the inapplicable case is recorded explicitly.
- **Coordinate acceptance gate** (before lifecycle mutation, both devices booted). Bare and platform-only `tapAt` must refuse ambiguity; every targeted tap must report the exact device and platform. Android runs at least 20 `observe` then no-op `tapAt` iterations in portrait and landscape and rejects any screen change. Both platforms compare rotated `observe.screenSize` with PNG dimensions: Android raster follows rotation; iOS keeps its portrait framebuffer with a uniform point-to-pixel scale, including non-integer scales. A labeled landscape skeleton target is tapped at its bounds center and must transition from an actionable row to changed/removed diff evidence or a destination heading. Each rotation check needs a restorable initial rotation (`0` or `1`) and restores that orientation plus the prior Android lock state.

## Evidence

Evidence schema 10 records and asserts the single build identity, forward/reverse proof, coordinate gate, every post-mutation control snapshot, duplicate removal and the exact surviving selection, all redacted with the operator key. Verification rejects an authentic artifact whose recorded outcome failed.

- Defaults to `scratch/live-device-acceptance/`, restrictive permissions; records redacted request shapes, identities, release counts and outcomes, never screen, daemon or tool payloads.
- Publication is immutable: a temporary 0600 file is linked into place with create-if-absent semantics, so concurrent or late writers fail rather than replace evidence.
- Values are stable HMAC-SHA-256 digests keyed by the operator key, allowing correlation without exposing target, session or diagnostic strings.
- Each phase reserves a reaping slice: on timeout the driver aborts cooperative work, closes owned MCP/daemon transports, kills its detached CLI process group, and returns without waiting on an uncooperative promise.

## Identity and endpoint proof

Android must remain the named AVD and iOS the requested UDID. On Android, `deviceIdentity` can expose an ADB serial and emulator console port; evidence reports each field's exposure and change separately (`androidSerialChanged`, `androidConsolePortChanged`) plus the combined `androidEndpointChanged`. The intentional kill/reacquire fails when an exposed serial or console port is unchanged, so a passing run proves the transition rather than recording an inconclusive value.

The iOS `startDevice` result exposes the simulator UDID, the daemon-owned CtrlProxy service port and a monotonic successful-restart generation. The harness restarts only the signed simulator through the daemon's targeted service-update interface, reacquires the exact UDID and immediately runs `observe` plus `getDeviceState`. Evidence requires both port and generation to be exposed and changed: a generation increment alone cannot certify a restart that kept a stale or occupied CtrlProxy port. The simulator display name is never substituted for runner identity.
