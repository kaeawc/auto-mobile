# Android emulator optimization

Controls remain independent. No profiles or automatic package disabling.

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
  geometry is now part of exact provisioning.
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

## Linux GPU renderer qualification

Repeated post-ready `SIGSEGV` emulator exits on Linux hosts (#12453) were seen
with `-gpu swangle -feature -Vulkan` on emulator 37.2.12.0 and a
`medium_phone` Android 15/API 35 Google APIs `x86_64` image. The cause is still
open: no native backtrace was captured, and the crash has not been reproduced.

The manual `Linux Qualification` workflow
(`.github/workflows/linux-qualification.yml`, scripts under
`scripts/ci/linux-qualification/`) runs each GPU mode under three workloads:
AutoMobile tools, a raw `adb` control, and a heartbeat-only control. Run
38902077979 (main `f1fd091b81`, two cycles per cell, emulator 37.2.12.0,
`android-35;google_apis;x86_64`, GitHub-hosted `ubuntu-latest`, no GPU) gave:

| GPU mode               | AutoMobile             | Raw adb control        | Heartbeat only         |
| ---------------------- | ---------------------- | ---------------------- | ---------------------- |
| `swiftshader_indirect` | 2/2 clean              | 2/2 clean              | 2/2 clean              |
| `swangle`              | 2/2 clean              | 2/2 clean              | 2/2 clean              |
| `angle_indirect`       | 2/2 clean              | 2/2 clean              | 2/2 clean              |
| `host`                 | fails at renderer init | fails at renderer init | fails at renderer init |

No software or indirect GPU cell crashed after readiness. `-gpu host` stops
before readiness with `Failed to get EGL display` / `Could not start renderer`
because the runner has no GPU render node. That is a startup failure, not the
post-ready signature. Two clean cycles per cell is weak evidence: it neither
clears nor implicates any software renderer.

The emulator's `-verbose` output shows what each flag actually selected on
37.2.12.0:

| Flag passed                     | Renderer the emulator used                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `-gpu swiftshader_indirect`     | mode `swiftshader`: SwiftShader GLES (`gles_swiftshader`, GLES 3.0), SwiftShader Vulkan |
| `-gpu swangle -feature -Vulkan` | ANGLE GLES (`gles_swangle`, GLES 3.1) on SwiftShader; host `Vulkan` feature off         |
| `-gpu angle_indirect`           | fell back to mode `lavapipe`: ANGLE GLES on Mesa llvmpipe Vulkan                        |

The `angle_indirect` row therefore measured ANGLE on Lavapipe, not a distinct
ANGLE-indirect path.

The emulator documentation deprecates `swiftshader_indirect`,
`swangle_indirect` and `guest` (36.4.9) and `angle_indirect` (34.2.14). The
current software modes are `software`, `swiftshader`, `lavapipe` and `swangle`.
CI (`.github/actions/android-emulator/action.yml`) passes `-gpu swiftshader`,
the mode the deprecated `swiftshader_indirect` already mapped to.

Linux configuration guidance until the cause is known:

- On headless hosts without a GPU, use a current software mode: `-gpu swangle`
  or `-gpu swiftshader`. Both were clean in this matrix. Pass it with
  `AUTOMOBILE_EMULATOR_ARGS='["-gpu","swangle"]'`.
- Use `-gpu host` only where `/dev/dri/renderD*` and a working EGL/Vulkan driver
  exist.
- `-feature -Vulkan` is the one non-default part of the crashing hosts'
  configuration. It was clean here, but it is unqualified beyond these runs;
  omit it unless a workload needs it.

When an emulator exits unexpectedly, the loss incident keeps the process exit
signal and a bounded, redacted `outputTail` of emulator output from launch
onward. `outputUnavailable: "adopted"` marks an emulator AutoMobile did not
launch, so no output was tracked. Slot recovery (`onLoss`) stays off by default
and never substitutes a different device.

The `swangle` cell matched the crashing hosts' flags, emulator build, image and
hardware profile. What still differs is the host machine, the experimental
broker build (these runs used the published 0.0.85 package), the repeated
acquire/release workload, and the cycle count. A longer soak on `swangle` and
`swiftshader` is the remaining step for #12453; no self-hosted GPU host is
available, so the `host` row stays unexercised.

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

## Initial local measurements (preliminary, not a benchmark)

On a disposable Android 15 Google APIs arm64 emulator (2 vCPU, 2048 MB, headless,
GPU auto = SwiftShader, macOS), disabling animations, screensavers, Gmail, YouTube,
Photos, Wellbeing and printing left median emulator RSS unchanged (4691.5 MiB before,
4693.1 MiB after; 52 baseline vs 60 treatment samples). No repeated A/B/A, unrelated
host work was running, and CPU percentages from the sampler are not used to claim a
reduction.

Mechanism checks on the API-35 image: 18 of 21 optional package groups disabled and
restored (Assistant, Dialer, Messages protected as active role holders); Maps'
background app-op (`ignore`/`default`), standby bucket (10/45/10), forced deep Doze,
a root-only `statsd` stop/restart, and speed-profile compilation all worked. These
prove command availability and limited reversible transitions, not performance wins,
and nothing was added to the public catalog from them. Persisted hardware fields
(720x1280, 280 dpi, two CPUs, no cameras, audio off, `gpuMode: host`) booted and
rendered correctly; resolution, renderer and boot state changed together, so this is
control validation, not a GPU comparison.
