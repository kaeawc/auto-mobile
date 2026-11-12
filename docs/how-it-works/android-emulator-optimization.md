# Android emulator optimization

Emulator cost controls are independent: there are no profiles and no automatic package disabling.

Host-side cost evidence and the device measurement plan: [Android emulator host cost](android-emulator-host-cost.md).

## Available controls

The resource catalog, restoration receipt, and AVD hardware fields are documented
in [Device resources](device-resources.md). They cover optional applications,
animations, screensavers, backup, CPU/RAM, GPU, display geometry and density,
camera, and audio. Test resource availability separately from performance.

Reuse the existing surfaces for other costs:

- `webrtcStream` configuration has Android FPS (1–60, default 30), output size,
  bitrate, and optional audio. Stop a stream when no observer needs it.
- Video recording has its own FPS/size settings. Record on demand.
- `displayConfig` controls font scale, density and theme. Persistent framebuffer
  geometry is part of exact provisioning.
- `deviceSnapshot` can use emulator VM snapshots. Prepared snapshots still need
  app/account identity isolation and restore validation; a faster boot is not
  proof that the resulting session is clean.
- `AUTOMOBILE_EMULATOR_ARGS` accepts tokenized startup arguments. Experimental
  `-read-only`, snapshot and boot-animation switches can be investigated through
  that existing path. Read-only clones of one AVD are not supported as distinct
  pool identities yet; do not use the escape hatch to bypass pool ownership.
- Device-pool autolock timeout releases a session; it does not promise emulator
  shutdown. Idle shutdown and warm-cap policies need explicit lifecycle
  reservations, ownership checks, pending-cleanup checks, and a bounded
  reacquisition test before integration.

## Experimental controls and required implementation work

| Surface                                        | Mechanism and next verification                                                             | Why it is not a general resource toggle yet                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Per-app background execution                   | Read/set `RUN_ANY_IN_BACKGROUND` app-op, preserve original mode, verify after resume/reboot | Changes push, jobs and uploads; requires package-specific intent and a richer policy contract                                   |
| Standby buckets                                | `am get-standby-bucket` / `am set-standby-bucket` with API-aware buckets                    | Buckets are dynamic and charging changes enforcement; a successful write is not proof of scheduling behavior                    |
| App suspension / force-stop / hibernation      | Separate package operations; observe launch, alarms, jobs and permission changes            | Semantically different from disable-user; hibernation can discard state that cannot be exactly restored                         |
| ART precompilation                             | Compile a chosen fixture app with speed-profile/speed and measure repeated launch           | Preparation consumes CPU/disk and changes cold-start measurements; cannot restore prior compiled artifacts with a binary switch |
| Account sync                                   | Privileged/instrumented ContentResolver master/per-authority APIs                           | API-35 `cmd content` has no master-sync setter; needs a permission-tested Android bridge, not guessed shell commands            |
| Widgets                                        | Inspect active widget hosts/providers, alter only explicitly selected widgets               | Framework is shared with launcher/system_server; no independent universal widget daemon                                         |
| Cached-app freezer                             | Read effective ActivityManager state, then measure eligible cached work                     | Already effective on the sampled API-35 image; enabling an existing feature is not a new saving                                 |
| Doze / saver / screen-off                      | Controlled power-state experiments with foreground and push tests                           | Conflicts with ordinary live notification delivery and interactive readiness; guest battery state is not host energy            |
| Bluetooth / NFC / location                     | Supported platform feature controls and HAL inventory                                       | Dormant emulated hardware may save little; API availability and dependent app behavior need verification                        |
| Native diagnostics / HALs                      | Root-only init-service inventory, stop/restart experiments, CPU/retry traces                | Critical/restarting services and shared framework processes cannot be treated as optional apps                                  |
| zRAM / LMKD / heap / low-RAM product flags     | Custom image and host-density benchmarks                                                    | Memory reduction can increase churn and CPU; do not disable LMKD or security controls                                           |
| ATD / AOSP / Google APIs / Play images         | Compare exact API/ABI/builds and app capability tests                                       | Image substitutions can remove push, billing or screenshot rendering; ATD is not a drop-in visual target                        |
| Read-only shared snapshots                     | Distinct instance IDs/ports, shared/private accounting, isolation tests                     | Requires multi-instance lifecycle work before pool use                                                                          |
| Linux CPU quotas / affinity / KSM / Cuttlefish | Linux/KVM worker and explicit limits with throughput tests                                  | Not available as cross-platform controls on a macOS emulator host                                                               |

Local evidence is macOS/arm64 only: it does not validate Linux KVM/Cuttlefish, Windows
hypervisors, custom images, or multi-host fleet density, and an unconfigured AVD cannot
validate push, login, attachments or huddles (those need their own app fixtures and
credentials).

## macOS software-rendering fallback

Emulator 37.2 and later resolve `-gpu auto` to a software renderer on macOS, because the
deprecated host OpenGL drivers cannot provide the GLES 3.1 features newer system images
require. Nothing fails; the emulator runs at about 10 FPS. The `doctor` check
`Emulator Rendering` warns when the host is macOS, `emulator -version` reports 37.2 or
later, and an AVD's effective GPU mode is still `auto`. An explicit `hw.gpu.mode` in the
AVD, `-gpu` in `AUTOMOBILE_EMULATOR_ARGS`, or `-feature GuestAngle` clears it. AutoMobile
does not change the GPU mode itself: `-gpu host` can break Google sign-in and limits
snapshots. The version threshold lives in `EmulatorSoftwareRendering.ts`; raise its upper
bound once a fixed emulator ships.

## Linux GPU renderer guidance

Repeated post-ready `SIGSEGV` emulator exits on Linux hosts (#12453) were seen with
`-gpu swangle -feature -Vulkan` on emulator 37.2.12.0 and a `medium_phone` Android 15/API 35 Google
APIs `x86_64` image; the cause is open. The manual `Linux Qualification` workflow
(`.github/workflows/linux-qualification.yml`, scripts under `scripts/ci/linux-qualification/`) runs
each GPU mode under three workloads: AutoMobile tools, a raw `adb` control, and a heartbeat-only
control.

The emulator deprecates `swiftshader_indirect`, `swangle_indirect` and `guest` (36.4.9) and
`angle_indirect` (34.2.14); `angle_indirect` falls back to `lavapipe` on 37.2.12.0. The current
software modes are `software`, `swiftshader`, `lavapipe` and `swangle`. CI
(`.github/actions/android-emulator/action.yml`) passes `-gpu swiftshader`.

Until the cause is known:

- On headless hosts without a GPU, use `-gpu swangle` or `-gpu swiftshader`, for example
  `AUTOMOBILE_EMULATOR_ARGS='["-gpu","swangle"]'`.
- Use `-gpu host` only where `/dev/dri/renderD*` and a working EGL/Vulkan driver exist; without them
  it fails at renderer init (`Failed to get EGL display` / `Could not start renderer`).
- Omit `-feature -Vulkan` unless a workload needs it; it is unqualified beyond the qualification runs.

When an emulator exits unexpectedly, the loss incident keeps the process exit signal and a bounded,
redacted `outputTail` of emulator output from launch onward. `outputUnavailable: "adopted"` marks an
emulator AutoMobile did not launch, so no output was tracked. Slot recovery (`onLoss`) stays off by
default and never substitutes a different device.

## Measurement protocol

`scripts/android/benchmark-emulator-resources.sh` accepts an explicit serial,
matching emulator PID, output directory, sample count and interval. It records
host process RSS/CPU readings and guest properties/memory/process state without
changing the device. Match the PID to its explicit emulator port before sampling.
RSS includes shared pages and is not unique physical memory. Host percent CPU
semantics vary by OS; do not derive a savings claim from one ps sample.

For comparative runs, hold exact image/build, emulator version, host load,
framebuffer, charging, app data and boot/snapshot state constant. Let boot and
package changes settle before sampling. Compare one change at a time before
combinations. Repeat baseline/treatment/baseline; measure 1/2/4 concurrent
instances only on a host with sufficient memory headroom. Existing unrelated
emulators are not controlled experimental participants.

Measure 5–10 minute idle periods plus launch, scroll/type, attachment, background
resume, notification and audio/video workflows. Record errors as well as latency.
Use Perfetto and platform private/shared memory accounting for a density claim.
Preserve raw evidence. A one-device smoke measurement cannot prove fleet savings.

## Primary references

- [Emulator acceleration](https://developer.android.com/studio/run/emulator-acceleration)
- [AVD hardware configuration](https://developer.android.com/studio/run/managing-avds)
- [Emulator startup flags](https://developer.android.com/studio/run/emulator-commandline)
- [Snapshots](https://developer.android.com/studio/run/emulator-snapshots)
- [Managed devices and ATD restrictions](https://developer.android.com/studio/test/managed-devices)
- [Cached-app freezer](https://source.android.com/docs/core/perf/cached-apps-freezer)
- [App standby](https://developer.android.com/topic/performance/appstandby)
- [Doze](https://developer.android.com/training/monitoring-device-state/doze-standby)
- [ART configuration](https://source.android.com/docs/core/runtime/configure/art-service)
- [ContentResolver sync](<https://developer.android.com/reference/android/content/ContentResolver#setMasterSyncAutomatically(boolean)>)
- [Init service lifecycle](https://android.googlesource.com/platform/system/core/+/refs/heads/main/init/README.md)
- [Cuttlefish](https://source.android.com/docs/devices/cuttlefish/get-started)

## Background

- [Android emulator optimization measurements](../devlog/2026-09-13-android-emulator-optimization-measurements.md)
- [Linux GPU renderer qualification](../devlog/2026-10-21-android-emulator-optimization-linux-gpu.md)
