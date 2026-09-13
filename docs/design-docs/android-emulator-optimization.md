# Android emulator optimization

Status: implementation and local experiments, September 2026. Controls remain
independent. No profiles or automatic package disabling.

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

The supplied host has macOS/arm64 emulator tooling. This does not validate Linux
KVM/Cuttlefish, Windows hypervisor behavior, custom system images, or realistic
multi-host fleet density. Google account/Slack workflows need their own
application fixtures and credentials; an unconfigured AVD cannot validate push,
login, attachments, or huddles. These are evidence requirements, not claims of
compatibility from a package list.

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

## Initial local measurements

A disposable Android 15 Google APIs arm64 emulator (emulator 36.4.5, 2 vCPU,
2048 MB guest RAM, 1080×1920 at 420 dpi, headless/audio-off, GPU auto) was sampled
on macOS. Auto selected SwiftShader. After excluding the overlap with initial
smoke validation, 52 baseline samples covered 257 seconds; 60 treatment samples
covered 297 seconds. The treatment disabled animations, screensavers, Gmail,
YouTube, Photos, Wellbeing and printing. Exact prior overrides were then restored.

Median emulator-process RSS was 4691.5 MiB before and 4693.1 MiB after. This run
showed no material host RSS saving. It is not a controlled causal benchmark:
there was no repeated A/B/A sequence, unrelated host work was running, and no
logged-in application workflow was exercised. Guest memory also changed while
background services settled. CPU percentages from this preliminary sampler are
not used to claim a reduction. Raw results remain in the task's scratch artifacts.

Native follow-up checks on that disposable API-35 image exercised all 21 optional
package groups: 18 disabled and restored, while Assistant, Dialer and Messages
were correctly protected as active role holders. Google Play services and GSF
were included in the reversible mechanism test; this does not validate app
compatibility while disabled.

More aggressive mechanism probes also succeeded: Maps' background app-op changed
to `ignore` and back to `default`; its standby bucket changed from 10 to 45 and
back to 10; forced deep Doze was entered and unforced. On the debuggable image,
root access allowed `statsd` to remain stopped for three observations and then
restart successfully. Maps speed-profile compilation returned success. These
prove command availability and limited state transitions, not performance wins
or suitability for ordinary interactive workflows. No native service control was
added to the public catalog based on this short probe.

The persisted hardware fields also booted successfully with 720×1280, 280 dpi,
two online CPUs, no exposed cameras, audio input/output off and `gpuMode: host`.
The emulator log identified Apple M3 Max rendering, whereas the earlier auto
configuration used SwiftShader. A native screenshot rendered the launcher
correctly. Because resolution, renderer and boot state changed together, this is
hardware-control validation rather than an isolated GPU performance comparison.
