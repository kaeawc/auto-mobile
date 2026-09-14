# Live device acceptance

The issue #7144 harness is an operator-run, destructive acceptance matrix for two explicit virtual devices: one Android AVD and one iOS simulator. It is never part of PR CI.

Use only dedicated, disposable test-owned devices. Before a live run, record the exact targets and three controls in a signed ownership manifest with an operator-held 32-byte key: a distinct Android sibling AVD, a second live serial for the same Android AVD, and an iOS sibling with the same display name but a different UUID. The driver verifies all of them through the public discovery surface before mutation. The Android duplicate must return `identity_conflict` and only its explicitly signed serial is stopped; the sibling must remain discoverable. iOS selection remains UUID-based across repeated discovery passes, so the same-named sibling is never selected or mutated. Flags alone never authorize adoption.

Create an owner-only key and record ownership first. This setup records authority only; it does not create, delete, or mutate either device.

```bash
bun run bootstrap:worktree
bash scripts/run-live-device-acceptance.sh \
  --record-ownership-manifest --create-operator-key \
  --operator-key-file scratch/live-device-acceptance/operator.key \
  --ownership-manifest scratch/live-device-acceptance/ownership.json \
  # pass the same target/runtime/configuration arguments shown below
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

The wrapper runs Android and then iOS under one total deadline, with a smaller per-platform deadline. Its two-second TERM-to-KILL grace is reserved from each driver budget, so neither wrapper escalation can exceed the declared deadline. The TypeScript driver also requires `--confirm-live`, `--test-owned-devices`, and `AUTOMOBILE_ACCEPTANCE_LIVE=1`, so invoking it directly cannot bypass the live-mutation guard. Both stable identities, names, runtimes, device types, and OS bounds are required, so an operator cannot accidentally substitute a discovered device. The iOS name is required separately from the UDID because the preflight validates their ownership mapping and provisioning requires both exact fields.

The wrapper runs `bun run build` once and uses only that explicit `dist/src/index.js` artifact for every MCP subprocess, CLI call, daemon restart, and doctor repair; it never falls back to a global `auto-mobile`. Evidence records and asserts its one build identity. The driver reserves a reaping slice inside each phase: on timeout it aborts cooperative work, closes owned MCP/daemon transports, kills its detached CLI process group, and returns without waiting forever for an uncooperative promise. Doctor receives the live remaining matrix budget through `--timeout-ms`. Evidence publication is immutable: a temporary 0600 file is linked into the final path with create-if-absent semantics, so concurrent or late writers fail rather than replacing evidence. Values are represented by stable HMAC-SHA-256 digests keyed by the operator-held key, allowing correlation without exposing target, session, or diagnostic strings.

Evidence defaults to `scratch/live-device-acceptance/` and is written with restrictive permissions. It records redacted request shapes, identities, release counts, and outcomes, but never retains screen, daemon, or tool payloads.

## Identity and endpoint proof

The stable identity check is explicit: Android must remain the named AVD, and iOS must remain the requested UDID. On Android, the delivered `deviceIdentity` can expose an ADB serial and emulator console port; evidence reports each field's exposure and change separately (`androidSerialChanged`, `androidConsolePortChanged`), plus the combined serial/console endpoint result (`androidEndpointChanged`). The intentional kill/reacquire transition fails when an exposed serial or console port remains unchanged, so a passing full or recovery run proves the required Android transition rather than merely recording an inconclusive value.

The current iOS `startDevice` result exposes a simulator UDID and simulator name, but no public service endpoint or port. The harness therefore records `iosServiceEndpointExposed: false` and `iosServiceEndpointChanged: false`. It deliberately does not substitute the simulator display name for an endpoint, and a live run cannot prove an iOS service endpoint change until the product surface exposes such a field.
