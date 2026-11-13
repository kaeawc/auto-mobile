# Android emulator host cost research

- Kind: concept
- Date: 2026-10-26
- Source: moved from `how-it-works/android-emulator-host-cost.md`; #6800, #14363, #15366, #15367, #15475, #15476, #15477, #15478, #15482
- Shaped: [Android emulator host cost](../how-it-works/android-emulator-host-cost.md)

## Scope

Research for #15367 (parent #15366): what an Android emulator costs the host and whether a minimal
default configuration is safe. No emulator was run: it reads the code, the checked-in configuration and
the AVD files on one development host. Everything that needs a running emulator is the plan below,
tracked in #15478 and labelled `needs-device-verify`.

## Recommendation

Neither a default profile nor a guest-side preset yet. The only host-side numbers are the AVD files,
and none measures CPU or memory use. Three configuration questions were confirmed without a device and
filed (#15475, #15476, #15477); each still needs a device run before a default changes. The existing
guest-side evidence (animations, screensavers, optional apps, RSS unchanged) argues against a
package-level default. Since #6800, headless launches no longer imply audio off.

### What the existing AVDs show

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

On the sampled host the capacity model gives `min(16, 8) = 8` emulators. With 4 vCPUs each, 8
emulators are 32 vCPUs on 16 cores. The memory side matches the 4 GiB that API 37 resolves to; the CPU
side budgets half of what the AVDs are configured with (#15476).

### Why the iOS result does not transfer

The iOS `minimal` profile saved a one-time first-boot burst by writing the launchd disabled
database before first boot. An Android AVD with a quick-boot snapshot has little first-boot work,
and package disabling needs a booted guest. The open Android costs are the host process (vCPU
threads, renderer, RAM) and the disk traffic of snapshots. The levers worth measuring are therefore host
side: vCPU count, RAM, renderer, audio, cameras, `-no-boot-anim` and snapshot handling.

Hypotheses to test, each with a basis and an expected direction, none measured here:

| Lever                      | Expected effect                                                                               | Basis                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `cpuCores` 4 to 2          | lower peak host CPU, slower boot and driving                                                  | the gate already budgets 2; vCPUs are host threads                                    |
| Renderer                   | possibly the largest host CPU term: `auto` resolved to `lavapipe` (software) on 32 AVDs here  | `hardware-qemu.ini`; the macOS software-rendering note in the optimization doc        |
| `-no-audio`                | removes audio threads; CI already uses it; audio-dependent workflows must opt in              | #6800 turned audio on for headless launches                                           |
| `-no-snapshot-save`        | removes a 2-4 GiB write at exit for AVDs that are destroyed anyway                            | AVD files, #15477                                                                     |
| `-no-boot-anim`            | shorter boot; the readiness checks poll `sys.boot_completed`, which this flag does not change | CI action; `AndroidSystemConfigurationAdapter`                                        |
| Cameras `none`             | small; `cameraPosterPath` needs `virtualscene`, so it cannot be a default                     | `DeviceCameraPoster.ts`                                                               |
| Guest packages, animations | none on RSS, per the earlier single-emulator result; CPU unconfirmed                          | [optimization measurements](2026-09-13-android-emulator-optimization-measurements.md) |

### Findings filed

1. **Effective RAM differs from the configured RAM** (#15475). The `config.ini` file says 2G; the emulator
   gave 2.5 GiB on API 35-36 and 4 GiB on API 37. Now `AvdConfig.effectiveRamMb` and `effectiveCpuCores`
   carry the launch-time values from `hardware-qemu.ini`. The boot gate raises its per-emulator
   estimate to the AVD's effective RAM (never lowering it).
2. **The boot gate's CPU budget disagrees with the AVD vCPU count** (#15476). Two cores per device
   against four vCPUs. The gate can budget the AVD's own vCPUs under
   `AUTOMOBILE_ANDROID_BOOT_BUDGET_VCPUS=configured`; the default stays two cores. A device run has to
   choose between that and creating AVDs with two vCPUs, which changes guest speed.
3. **Quick-boot snapshots accumulate and are written at every exit** (#15477). Broker-provisioned emulators launch with
   `-no-snapshot-save` when no snapshot reset can use the exit state. That covers no `androidResetMode`
   (the broker destroys released emulators). It also covers `keep-booted` without
   `androidKeepBootedFallback: "snapshot"` (a non-clean release deletes the AVD; a clean one stays
   booted). `snapshot` hosts, `keep-booted` with the snapshot fallback, user AVDs and `startDevice`
   keep the default. The broker saves and loads its baseline explicitly with `avd snapshot save|load`,
   which the flag does not disable. 74.6 GiB of
   snapshots on this host, including for AVD kinds the broker destroys. Needs a device run for the
   saving and a check against `deviceSnapshot` and the keep-booted baseline (#14363).

None of these changes a default by itself. Items 2 and 3 are labelled `needs-device-verify`.

### Device measurement plan (#15478)

Not run: manual tests were paused. The rules, metrics, preflight, run template and cleanup are on the
page; the matrix, results format and decision rule follow.

#### Matrix

| Step | Measurement                                                                                                                                   | Arm flags (added to the template)                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1    | Baseline: cold boot (`-no-snapshot-load`) and quick-boot restore; 10 min idle CPU and unique memory                                           | none                                                                                                              |
| 2a   | vCPUs: `hw.cpu.ncore` 2 vs 4 (edit `config.ini`, then restore it)                                                                             | none                                                                                                              |
| 2b   | Renderer                                                                                                                                      | `-gpu auto`, `-gpu swiftshader_indirect`, `-gpu host` (macOS and Linux with a GPU); on Linux also `-gpu lavapipe` |
| 2c   | Audio, cameras, boot animation                                                                                                                | `-no-audio`; `-camera-back none -camera-front none`; remove `-no-boot-anim` for the control                       |
| 2d   | Display: size and density (`hw.lcd.width`, `hw.lcd.height`, `hw.lcd.density`)                                                                 | none                                                                                                              |
| 3    | Snapshots: exit seconds and bytes written with and without `-no-snapshot-save`; quick-boot restore vs cold boot                               | `-no-snapshot-save` vs omit it; `-no-snapshot-load`                                                               |
| 4    | Concurrency: per-emulator settled cost at 1, 2 and 4 emulators started 30 s apart (ports 5700, 5702, 5704, 5706); compare with the gate model | the winners of steps 2 and 3                                                                                      |
| 5    | Breakage per candidate (below)                                                                                                                | each candidate                                                                                                    |

For the effective-RAM question (#15475), on API 35 and API 37 set `hw.ramSize` to 1536, 2048, 3072
and 4096 and launch once each. Record `hw.ramSize` from `hardware-qemu.ini` in the AVD directory
and `MemTotal` from `adb shell cat /proc/meminfo`.

**Step 5, breakage check.** Each candidate must pass these through a private daemon bound to the
research serial, with every call naming its `deviceId`:

- `startDevice` and runner start
- `observe` with a screenshot
- `launchApp` and `terminateApp` on the Settings app
- `tapOn`
- `sendKeys` into a text field
- `videoRecording` start and stop
- a posted notification appearing in the tray

A candidate
that fails or is flaky once in three is rejected, and the failing call goes in the results.

#### Results

One row per run in `results.csv` (columns: `host, step, arm, repeat, api, time_to_boot_s,
time_to_quiet_s, cpu_seconds_delta, cpu_percent_of_core, unique_kib_avg, unique_kib_peak, exit_s,
bytes_written_kib, step5_pass`), and a summary table per step in the page: arm means, the spread
(max minus min) of the baseline repeats, and the difference.

#### Decision rule

A default changes only for a lever whose host CPU or unique-memory difference exceeds twice the
baseline spread on both hosts, that leaves step 5 green, and that has a restore path. Otherwise the
result is an opt-in profile or nothing. Run on macOS arm64 and on Linux with KVM; the existing
evidence is macOS arm64 only.
