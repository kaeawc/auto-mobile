# Android emulator host cost: what is known without a device

Research for #15367 (parent #15366). It asks what an Android emulator costs the host and whether a
minimal default configuration is safe. No emulator was run for this note: it reads the code, the
checked-in configuration and the AVD files already on one development host. Everything that needs a
running emulator is a plan (section 6), tracked in #15478 and labelled `needs-device-verify`.

**Recommendation: neither a default profile nor a guest-side preset yet.** The only host-side
numbers that exist are the files below, and none of them measures CPU or memory use. Three
configuration questions are confirmed without a device and filed as issues (section 5); each still
needs a device run before a default changes. The existing guest-side evidence (animations,
screensavers, optional apps, RSS unchanged) argues against a package-level default, as in
[Android emulator optimization](android-emulator-optimization.md).

## 1. What the product launches today

From `EmulatorLauncher.startClaimedEmulatorProcess` and the AVD hardware fields in
`src/models/AndroidAvdConfiguration.ts`:

| Setting        | Product default                                                                                            | Where                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Window         | `-no-window` on macOS, and on Linux without a display                                                      | `resolveHeadlessMode`                   |
| Audio          | on; `-no-audio` only when `AUTOMOBILE_EMULATOR_AUDIO=false`                                                | `emulatorAudioArguments`, `envMedia.ts` |
| GPU            | `hw.gpu.mode` left at the AVD value (`auto`); no `-gpu` flag                                               | no `-gpu` in the launcher               |
| Boot animation | not disabled                                                                                               | no `-no-boot-anim`                      |
| Snapshots      | quick-boot load and save; `-no-snapshot-save` only on the wipe-data relaunch of the Android snapshot reset | `androidSnapshotResetNativePort.ts`     |
| Cameras        | AVD value (back `emulated`, front `none` on every sampled AVD)                                             | `config.ini`                            |
| CPU, RAM       | AVD value; `provisionDevice` accepts `cpuCores` (1-16) and `memoryMb` (at least 2048)                      | `provisionDeviceSpecSchemas.ts`         |

Since #6800, headless launches no longer imply audio off (`device-resources.md`, "Android
provisioning hardware"). The CI action passes the opposite set: `-no-window -gpu swiftshader
-noaudio -no-boot-anim -camera-back none` and `-no-snapshot-save`
(`.github/actions/android-emulator/action.yml`).

## 2. What the existing AVDs show

33 AVDs on one arm64 macOS host (128 GiB, 16 cores; installed emulator 37.1.11.0), created by the
product (`ambroker-*`, `amslot-*`, `amverify-*`) plus one prototype AVD. Values are from each
AVD's `config.ini`, `hardware-qemu.ini` (what the emulator resolved at its last launch) and
`snapshots/`.

| Field                               | Observed                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `hw.cpu.ncore`                      | 4 on 33 of 33 (config and resolved)                                                      |
| `hw.ramSize` in `config.ini`        | `2G` on 33 of 33                                                                         |
| RAM the emulator resolved           | 2048 on API 30-32 (3), 2560 on API 35-36 (26), 4096 on API 36 foldable and API 37 (4)    |
| `hw.gpu.mode` in `config.ini`       | `auto` on 33 of 33                                                                       |
| GPU mode the emulator resolved      | `lavapipe` on 32, `swiftshader` on 1                                                     |
| `hw.audioInput`, `hw.audioOutput`   | `yes` on 33 of 33                                                                        |
| `hw.camera.back`, `hw.camera.front` | `emulated`, `none` on 33 of 33                                                           |
| Quick-boot snapshot                 | `snapshots/default_boot` on 32 of 33                                                     |
| Snapshot size                       | 74.6 GiB in total; 24 `amslot-*` AVDs average 2.4 GiB; `ram.bin` equals the resolved RAM |
| AVD directories                     | 142.1 GiB in total                                                                       |

One broker AVD's timestamps: launch 09:58:12, boot completed 10:00:27, `ram.bin` and
`userdata-qemu.img.qcow2` both written at 10:07:06, which fits a snapshot saved when the emulator
exited. The launch parameters file shows `-avd <name> -no-window -port <port>` and nothing else.

Limits of this evidence: one host, one architecture, files rather than live processes, and an
emulator build that is not recorded per AVD. It says what a launch configures and leaves on disk,
not what it costs in CPU.

## 3. The capacity model, read from code

`src/devices/bootAdmission/capacityLimits.ts`:

- Memory: `0.5 * host RAM / perDevice`, with `perDevice` defaulting to 4 GiB
  (`ANDROID_EMULATOR_MEMORY_POLICY`, clamped 1.5-8 GiB) and replaced by the measured settled RSS
  average when emulators are running.
- CPU: `floor(cpuCount / 2)`, from `CORES_PER_DEVICE = 2`.
- `maxBooted` is the smaller, at least 1, unless the Android max-booted environment override is set.

On the sampled host that is `min(16, 8) = 8` emulators. With 4 vCPUs each, 8 emulators are 32
vCPUs on 16 cores. The memory side already matches the 4 GiB that API 37 resolves to; the CPU side
budgets half of what the AVDs are configured with (#15476).

## 4. Why the iOS result does not transfer

The iOS `minimal` profile saved a one-time first-boot burst by writing the launchd disabled
database before first boot. An Android AVD with a quick-boot snapshot has little first-boot work,
and package disabling needs a booted guest. The open Android costs are the host process (vCPU
threads, renderer, RAM) and the disk traffic of snapshots, so the levers worth measuring are host
side: vCPU count, RAM, renderer, audio, cameras, `-no-boot-anim` and snapshot handling.

Hypotheses to test, each with a basis and an expected direction, none measured here:

| Lever                      | Expected effect                                                                               | Basis                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `cpuCores` 4 to 2          | lower peak host CPU, slower boot and driving                                                  | the gate already budgets 2; vCPUs are host threads                             |
| Renderer                   | possibly the largest host CPU term: `auto` resolved to `lavapipe` (software) on 32 AVDs here  | `hardware-qemu.ini`; the macOS software-rendering note in the optimization doc |
| `-no-audio`                | removes audio threads; CI already uses it; audio-dependent workflows must opt in              | #6800 turned audio on for headless launches                                    |
| `-no-snapshot-save`        | removes a 2-4 GiB write at exit for AVDs that are destroyed anyway                            | section 2, #15477                                                              |
| `-no-boot-anim`            | shorter boot; the readiness checks poll `sys.boot_completed`, which this flag does not change | CI action; `AndroidSystemConfigurationAdapter`                                 |
| Cameras `none`             | small; `cameraPosterPath` needs `virtualscene`, so it cannot be a default                     | `DeviceCameraPoster.ts`                                                        |
| Guest packages, animations | none on RSS, per the earlier single-emulator result; CPU unconfirmed                          | optimization doc, "Initial local measurements"                                 |

## 5. Confirmed without a device, and filed

1. **Effective RAM differs from the configured RAM** (#15475). `config.ini` says 2G; the emulator
   gave 2.5 GiB on API 35-36 and 4 GiB on API 37. `AvdConfig.effectiveRamMb` and `effectiveCpuCores` now
   carry the launch-time values from `hardware-qemu.ini`, and the boot gate raises its per-emulator
   estimate to the AVD's effective RAM (never lowering it).
2. **The boot gate's CPU budget disagrees with the AVD vCPU count** (#15476). Two cores per device
   against four vCPUs. The gate can now budget the AVD's own vCPUs under
   `AUTOMOBILE_ANDROID_BOOT_BUDGET_VCPUS=configured`; the default stays two cores. A device run has to
   choose between that and creating AVDs with two vCPUs, which changes guest speed.
3. **Quick-boot snapshots accumulate and are written at every exit** (#15477). Broker-provisioned emulators now launch with
   `-no-snapshot-save` when the host config sets no `androidResetMode` (released emulators are destroyed);
   `snapshot` and `keep-booted` hosts, user AVDs and `startDevice` keep the default. 74.6 GiB of
   snapshots on this host, including for AVD kinds the broker destroys. Needs a device run for the
   saving and a check against `deviceSnapshot` and the keep-booted baseline (#14363).

None of these changes a default by itself. Items 2 and 3 are labelled `needs-device-verify`.

## 6. Device measurement plan (#15478, `needs-device-verify`)

Not run: manual tests are paused. The protocol extends the one in the optimization doc and
`scripts/android/benchmark-emulator-resources.sh`.

**Rules.** Dedicated research AVDs, deleted afterwards. Never `emulator-5554`, the resident daemon
or another lane's emulators. Hold image, emulator build, host load, framebuffer and snapshot state
constant; settle before sampling; repeat baseline, treatment, baseline; one change at a time.

**Gaps in the existing sampler to close first.** It records `ps` `pcpu` and RSS. Use the cumulative
CPU time delta over the window instead of `pcpu`, and a unique-memory figure: `footprint -p` or
`phys_footprint` on macOS, `smaps_rollup` PSS on Linux. RSS counts shared pages.

**Matrix.**

| Step | Measurement                                                                                                                                | Levers                                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Baseline: CPU-seconds and time-to-quiet for cold boot and quick-boot restore; 5-10 minutes idle CPU and unique memory                      | none                                                                                                                                                                   |
| 2    | Host levers                                                                                                                                | `cpuCores` 2 vs 4; `gpuMode` `auto`, `swiftshader`, `swangle`, `lavapipe`, `host` where available; `-no-audio`; cameras off; `-no-boot-anim`; display size and density |
| 3    | Snapshots: exit time and bytes written with and without `-no-snapshot-save`; quick-boot restore against cold boot                          | `-no-snapshot-save`, `-no-snapshot-load`                                                                                                                               |
| 4    | Concurrency: per-emulator settled cost at 1, 2 and 4 emulators; compare with the gate's estimate                                           | the winning levers from 2 and 3                                                                                                                                        |
| 5    | Breakage per candidate: startDevice and runner start, observe, screenshot, launch and terminate, tapOn, sendKeys, video, notification path | each candidate                                                                                                                                                         |

Run on macOS arm64 and on Linux with KVM; the existing evidence is macOS arm64 only. For the
effective-RAM question, record `hw.ramSize` from `hardware-qemu.ini` after each launch at several
configured values on API 35 and API 37.

**Decision rule.** A default changes only for a lever that moves host CPU or unique memory outside
run-to-run noise on both hosts, leaves step 5 green, and has a restore path. Otherwise the result
is an opt-in profile or nothing.

## Out of scope

Custom system images, Cuttlefish, LMKD and zRAM changes, and read-only multi-instance AVDs.
