# Live device acceptance

The issue #7144 harness is an operator-run, destructive acceptance matrix for two explicit virtual devices: one Android AVD and one iOS simulator. It is never part of PR CI.

Use only dedicated, disposable test-owned devices. The full matrix provisions the exact runtime/device type/config and declares `observe` and `getDeviceState` capabilities through `provisionDevice`. Android acquisition uses `getAndroid` with the exact AVD name and iOS acquisition uses `getApple` with the exact simulator UUID. Before an iOS provision, the harness acquires the supplied UUID and verifies its exact display name; the UUID is then carried through `provisionDevice`, so a same-named simulator cannot be selected. Generic `startDevice` coverage then uses the exact Android AVD name or iOS simulator UUID for exact, `minOsVersion`, and `maxOsVersion` requests. Every minted session proves readiness with `observe` followed immediately by `getDeviceState`. The harness explicitly releases every minted session through the daemon before its MCP client closes. It then runs a short-lived CLI process, verifies the held session from an independent MCP client, and requires the product's unrelated-owner conflict diagnostic. Both scenarios run the host-local `auto-mobile --cli doctor --repair` contract, then reacquire and verify readiness through a new independent MCP client. The repair is host-wide. The recovery scenario keeps its held session live through the daemon restart and requires the terminal old-session diagnostic before repair. Do not use a personal emulator, a shared simulator, or any target with user data or active work.

Run it from a prepared checkout:

```bash
bun run bootstrap:worktree
AUTOMOBILE_ACCEPTANCE_LIVE=1 bash scripts/run-live-device-acceptance.sh \
  --confirm-live --test-owned-devices \
  --android-avd-name "acceptance-pixel-9" \
  --android-runtime "system-images;android-36;google_apis;x86_64" \
  --android-device-type "pixel_9" \
  --android-memory-mb "4096" \
  --android-cpu-cores "4" \
  --android-min-os-version "35" \
  --android-max-os-version "36" \
  --ios-simulator-name "Acceptance iPhone 17" \
  --ios-simulator-uuid "00000000-0000-0000-0000-000000000000" \
  --ios-runtime "com.apple.CoreSimulator.SimRuntime.iOS-26-0" \
  --ios-device-type "com.apple.CoreSimulator.SimDeviceType.iPhone-17" \
  --ios-min-os-version "25.0" \
  --ios-max-os-version "26.0"
```

The wrapper runs Android and then iOS under one total deadline, with a smaller per-platform deadline. Its two-second TERM-to-KILL grace is reserved from each driver budget, so neither wrapper escalation can exceed the declared deadline. The TypeScript driver also requires `--confirm-live`, `--test-owned-devices`, and `AUTOMOBILE_ACCEPTANCE_LIVE=1`, so invoking it directly cannot bypass the live-mutation guard. Both stable identities, names, runtimes, device types, and OS bounds are required, so an operator cannot accidentally substitute a discovered device. The iOS name is required separately from the UDID because the preflight validates their ownership mapping and provisioning requires both exact fields.

`--dry-run` deterministically validates the wrapper's explicit-target and bound guards without invoking the daemon or a device. The driver uses one monotonic per-platform deadline with reserved cleanup and evidence time; every MCP connection/call/close, daemon operation, CLI/doctor invocation, restart, release, and evidence write is bounded. The focused TypeScript and BATS tests provide deterministic proof of the exact selectors, readiness order, release-before-close failure cleanup, diagnostic contracts, timeout behavior, and redaction. A live invocation is needed to establish behavior against a real daemon and its actual device results; use `--scenario recovery` when restart/reacquisition proof is also required.

Evidence defaults to `scratch/live-device-acceptance/` and is written with restrictive permissions. It records redacted request shapes, identities, release counts, and outcomes, but never retains screen, daemon, or tool payloads.

## Identity and endpoint proof

The stable identity check is explicit: Android must remain the named AVD, and iOS must remain the requested UDID. On Android, the delivered `deviceIdentity` can expose an ADB serial and emulator console port; evidence reports each field's exposure and change separately (`androidSerialChanged`, `androidConsolePortChanged`), plus the combined serial/console endpoint result (`androidEndpointChanged`). The intentional kill/reacquire transition fails when an exposed serial or console port remains unchanged, so a passing full or recovery run proves the required Android transition rather than merely recording an inconclusive value.

The current iOS `startDevice` result exposes a simulator UDID and simulator name, but no public service endpoint or port. The harness therefore records `iosServiceEndpointExposed: false` and `iosServiceEndpointChanged: false`. It deliberately does not substitute the simulator display name for an endpoint, and a live run cannot prove an iOS service endpoint change until the product surface exposes such a field.
