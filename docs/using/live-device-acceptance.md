# Live device acceptance

The issue #7144 harness is an operator-run, destructive acceptance matrix for two explicit virtual devices: one Android AVD and one iOS simulator. It is never part of PR CI.

Use only dedicated, disposable test-owned devices. Before a live run, record the exact targets and three controls in a signed ownership manifest with an operator-held 32-byte key: a distinct Android sibling AVD, a second live serial for the same Android AVD, and an iOS sibling with the same display name but a different UUID. The harness starts two short-lived acceptance MCP proxies, one with forward and one with reverse discovery presentation. The proxy carries that non-mutating per-request control through the daemon, so real `listDevices`, `getAndroid`, and `getApple` logic sees the same fresh public inventory in opposite orders. A live run fails if either the inventory is not exactly reversed or selection/duplicate rejection differs by order.

The Android control set must contain exactly one intended target instance and exactly one signed duplicate, plus exactly one unrelated sibling. The duplicate request must fail with `identity_conflict` naming both serials. The driver then stops only the signed duplicate serial, requires that serial to disappear, proves the intended surviving serial is selected through the supported `avdName` plus `deviceId` selector, and keeps the sibling unchanged. The exact iOS UUID target and same-name sibling must both remain present and unchanged. Controls are rechecked before and after provisioning, target stop/reacquisition, and each persisted-recovery transition. A missing, changed, or extra unsigned control fails the run before another destructive action. Flags alone never authorize adoption.

Create an owner-only key and record ownership first. Place the evidence, ownership manifest, and operator key in a dedicated acceptance directory, not an existing shared directory such as `/tmp`. The harness creates missing dedicated directories as mode `0700`, but it never changes permissions on an existing caller-owned directory; an existing directory must already be mode `0700` or the harness fails before building or touching a device. This setup records authority only; it does not create, delete, or mutate either device.

```bash
bun run bootstrap:worktree
bash scripts/run-live-device-acceptance.sh \
  --record-ownership-manifest --create-operator-key \
  --android-avd-name "acceptance-pixel-9" \
  --android-sibling-avd-name "acceptance-pixel-9-sibling" \
  --android-duplicate-serial "emulator-5560" \
  --android-runtime "system-images;android-36;google_apis;x86_64" \
  --android-device-type "pixel_9" \
  --android-memory-mb "4096" \
  --android-cpu-cores "4" \
  --android-min-os-version "16.0" \
  --android-max-os-version "16.0" \
  --ios-simulator-name "Acceptance iPhone 17" \
  --ios-simulator-uuid "00000000-0000-0000-0000-000000000000" \
  --ios-same-name-sibling-uuid "00000000-0000-0000-0000-000000000001" \
  --ios-runtime "com.apple.CoreSimulator.SimRuntime.iOS-26-0" \
  --ios-device-type "com.apple.CoreSimulator.SimDeviceType.iPhone-17" \
  --ios-min-os-version "25.0" \
  --ios-max-os-version "26.0" \
  --operator-key-file scratch/live-device-acceptance/operator.key \
  --ownership-manifest scratch/live-device-acceptance/ownership.json
```

Then run it from the prepared checkout:

```bash
bun run bootstrap:worktree
AUTOMOBILE_ACCEPTANCE_LIVE=1 bash scripts/run-live-device-acceptance.sh \
  --confirm-live --test-owned-devices \
  --android-avd-name "acceptance-pixel-9" \
  --android-sibling-avd-name "acceptance-pixel-9-sibling" \
  --android-duplicate-serial "emulator-5560" \
  --android-runtime "system-images;android-36;google_apis;x86_64" \
  --android-device-type "pixel_9" \
  --android-memory-mb "4096" \
  --android-cpu-cores "4" \
  --android-min-os-version "16.0" \
  --android-max-os-version "16.0" \
  --ios-simulator-name "Acceptance iPhone 17" \
  --ios-simulator-uuid "00000000-0000-0000-0000-000000000000" \
  --ios-same-name-sibling-uuid "00000000-0000-0000-0000-000000000001" \
  --ios-runtime "com.apple.CoreSimulator.SimRuntime.iOS-26-0" \
  --ios-device-type "com.apple.CoreSimulator.SimDeviceType.iPhone-17" \
  --ios-min-os-version "25.0" \
  --ios-max-os-version "26.0" \
  --operator-key-file scratch/live-device-acceptance/operator.key \
  --ownership-manifest scratch/live-device-acceptance/ownership.json
```

The wrapper rejects overlapping control identities before building or invoking the live driver. The TypeScript driver repeats that validation and requires the Android and iOS entries in the signed manifest to bind the identical control set. The wrapper runs Android and then iOS under one total deadline, with a smaller per-platform deadline. Its two-second TERM-to-KILL grace is reserved from each driver budget, so neither wrapper escalation can exceed the declared deadline. The added control observations run inside the existing work budget; they do not extend either deadline. The TypeScript driver also requires `--confirm-live`, `--test-owned-devices`, and `AUTOMOBILE_ACCEPTANCE_LIVE=1`, so invoking it directly cannot bypass the live-mutation guard. Both stable identities, names, runtimes, device types, and OS bounds are required, so an operator cannot accidentally substitute a discovered device. The iOS name is required separately from the UDID because the preflight validates their ownership mapping and provisioning requires both exact fields.

The wrapper runs `bun run build` once and uses only that explicit `dist/src/index.js` artifact for every MCP subprocess, CLI call, and daemon restart; it never falls back to a global `auto-mobile`. Each platform's matrix has a real short-lived CLI process acquire the exact target, captures its returned `sessionUuid`, waits for that process to exit, and then requires an independently-created MCP client to run `observe` and `getDeviceState` with that UUID. The reverse MCP-to-CLI direction is not acceptance evidence. The persisted-session restart is acceptance-only: a daemon-generation HMAC binds its expiry, one session UUID, platform, stable target identity, and the signed Android/iOS control set. It proves a busy exact target fences the old UUID, then permanently deletes only the exact signed target and requires complete platform-inventory absence while retaining its signed sibling. The old UUID must fail with the exact `target-busy` or `target-absent` recovery reason, become durably terminal, and never operate the sibling; only an explicit fresh UUID may acquire the sibling after deletion. The deletion is deliberately last: it is deterministic cleanup, and a subsequent live run requires a newly provisioned and signed disposable target. Android same-serial/different-AVD replacement is covered by the real pool recovery regression; iOS cannot express that transition because a simulator UDID is both its immutable stable identity and daemon transport key, so deletion is accurately reported as `target-absent` and the inapplicable replacement case is recorded explicitly. The daemon rejects active operations, an unrelated session, a changed generation, or an ordinary process without the startup secret; it then crash-restarts only that daemon generation, never a device.

Before lifecycle mutation, the signed matrix session runs the coordinate acceptance gate while both controlled devices are booted. Bare and platform-only `tapAt` calls must refuse ambiguity; every successful targeted tap must report the exact device and platform. Android performs at least 20 `observe` → no-op `tapAt` iterations in portrait and landscape and rejects any screen change. Both platforms compare rotated `observe.screenSize` with PNG dimensions: Android raster dimensions must follow rotation, while iOS must preserve its portrait framebuffer with a uniform point-to-pixel scale, including non-integer scales. A labeled landscape skeleton target is tapped at the center of its bounds and must transition from an actionable row into changed/removed diff evidence or a destination heading. Each rotation check requires a restorable initial rotation (`0` or `1`) and restores that exact orientation plus the prior Android lock state.

Evidence schema 10 records and asserts its one build identity, deterministic forward/reverse proof, coordinate contract gate, every post-mutation control snapshot, duplicate removal, and exact surviving Android or iOS selection, all redacted with the operator key. Verification rejects an authentic artifact whose recorded outcome failed.

The driver reserves a reaping slice inside each phase: on timeout it aborts cooperative work, closes owned MCP/daemon transports, kills its detached CLI process group, and returns without waiting forever for an uncooperative promise. Evidence publication is immutable: a temporary 0600 file is linked into the final path with create-if-absent semantics, so concurrent or late writers fail rather than replacing evidence. Values are represented by stable HMAC-SHA-256 digests keyed by the operator-held key, allowing correlation without exposing target, session, or diagnostic strings.

Evidence defaults to `scratch/live-device-acceptance/` and is written with restrictive permissions. It records redacted request shapes, identities, release counts, and outcomes, but never retains screen, daemon, or tool payloads.

## Identity and endpoint proof

The stable identity check is explicit: Android must remain the named AVD, and iOS must remain the requested UDID. On Android, the delivered `deviceIdentity` can expose an ADB serial and emulator console port; evidence reports each field's exposure and change separately (`androidSerialChanged`, `androidConsolePortChanged`), plus the combined serial/console endpoint result (`androidEndpointChanged`). The intentional kill/reacquire transition fails when an exposed serial or console port remains unchanged, so a passing full run proves the required Android transition rather than merely recording an inconclusive value.

The iOS `startDevice` result exposes the simulator UDID, the daemon-owned CtrlProxy service port, and a monotonic successful-restart generation. The harness restarts only the signed simulator through the daemon's targeted service-update interface, reacquires the exact UDID, and immediately runs `observe` plus `getDeviceState`. Evidence requires both fields to be exposed and changed: a generation increment alone cannot certify a restart that retained a stale or occupied CtrlProxy port. It never substitutes the simulator display name for runner identity.
