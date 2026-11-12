# Android emulator host cost

What an Android emulator launch configures on the host, how boot admission budgets it, and how to
measure its host cost (#15367).

## What the product launches

From `EmulatorLauncher.startClaimedEmulatorProcess` and the AVD hardware fields in
`src/models/AndroidAvdConfiguration.ts`:

| Setting        | Product default                                                                                               | Where                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Window         | `-no-window` on macOS, and on Linux without a display                                                         | `resolveHeadlessMode`                   |
| Audio          | on; `-no-audio` only when `AUTOMOBILE_EMULATOR_AUDIO=false`                                                   | `emulatorAudioArguments`, `envMedia.ts` |
| GPU            | `hw.gpu.mode` left at the AVD value (`auto`); no `-gpu` flag                                                  | no `-gpu` in the launcher               |
| Boot animation | not disabled                                                                                                  | no `-no-boot-anim`                      |
| Snapshots      | quick-boot load and save; `-no-snapshot-save` on snapshot-reset wipe-data relaunches, broker launches (below) | `androidSnapshotResetNativePort.ts`     |
| Cameras        | AVD value (back `emulated`, front `none` on every sampled AVD)                                                | `config.ini`                            |
| CPU, RAM       | AVD value; `provisionDevice` accepts `cpuCores` (1-16) and `memoryMb` (at least 2048)                         | `provisionDeviceSpecSchemas.ts`         |

With `AUTOMOBILE_EMULATOR_NETSIM_ISOLATION=true`, each newly spawned emulator owns a private netsimd started after boot admission and connected through `-packet-streamer-endpoint`, isolating BLE peripherals across sessions; explicit endpoints take precedence, and emulator exit or launch failure stops only its owned daemon. An `O_EXCL` claim lock beside `netsim_N.ini` (in netsimd's discovery directory: `TMPDIR`, then `XDG_RUNTIME_DIR` on Linux) reserves instance N across daemons until that netsimd's exit is observed, and `--no-shutdown` is stripped from `NETSIM_ARGS` so a daemon orphaned by an AutoMobile restart still exits once its emulator disconnects.

Headless launches do not imply audio off ([Android provisioning hardware](device-resources.md#android-provisioning-hardware)).
The CI action passes the opposite set: `-no-window -gpu swiftshader
-noaudio -no-boot-anim -camera-back none` and `-no-snapshot-save`
(`.github/actions/android-emulator/action.yml`).

## Boot capacity model

`src/devices/bootAdmission/capacityLimits.ts`:

- Memory: `0.5 * host RAM / perDevice`, with `perDevice` defaulting to 4 GiB
  (`ANDROID_EMULATOR_MEMORY_POLICY`, clamped 1.5-8 GiB) and replaced by the measured settled RSS
  average when emulators are running.
- CPU: `floor(cpuCount / 2)`, from `CORES_PER_DEVICE = 2`.
- `maxBooted` is the smaller, at least 1, unless the Android max-booted environment override is set.

The CPU side budgets two cores per emulator, while product AVDs are created with four vCPUs (#15476).

## Configuration that differs from the AVD

1. **Effective RAM differs from the configured RAM** (#15475). `config.ini` says 2G, but the emulator
   resolves more on newer images. `AvdConfig.effectiveRamMb` and `effectiveCpuCores` carry the
   launch-time values from `hardware-qemu.ini`, and the boot gate raises its per-emulator estimate to
   the AVD's effective RAM (never lowering it).
2. **CPU budget vs AVD vCPUs** (#15476). The gate budgets the AVD's own vCPUs under
   `AUTOMOBILE_ANDROID_BOOT_BUDGET_VCPUS=configured`; the default stays two cores. Labelled
   `needs-device-verify`.
3. **Quick-boot snapshot writes at exit** (#15477). Broker-provisioned emulators launch with
   `-no-snapshot-save` when no snapshot reset can use the exit state: no `androidResetMode` (released
   emulators are destroyed), or `keep-booted` without `androidKeepBootedFallback: "snapshot"` (a
   non-clean release deletes the AVD; a clean one stays booted). `snapshot` hosts, `keep-booted` with
   the snapshot fallback, user AVDs and `startDevice` keep the default. The broker baseline is saved
   and loaded explicitly with `avd snapshot save|load`, which the flag does not disable. Labelled
   `needs-device-verify` (#14363).

No guest-side preset or minimal default profile exists; see
[Android emulator optimization](android-emulator-optimization.md).

## Measuring host cost (#15478)

`scripts/android/emulator-host-cost-sample.sh` samples one emulator process read-only;
`scripts/android/benchmark-emulator-resources.sh` stays the guest-side snapshot collector. The
protocol extends the one in [Android emulator optimization](android-emulator-optimization.md).

### Rules

Dedicated research AVDs named `am-cost-<api>-<n>`, deleted afterwards. Never `emulator-5554`, the
resident daemon, another lane's emulator or the owner's protected emulator. Hold system image,
emulator build, host load, framebuffer and snapshot state constant; one change at a time; baseline,
treatment, baseline; at least three repeats of each arm. Use only emulator ports 5700-5720 (even
numbers), so a stray `adb` serial can never be another lane's device.

### Metrics (what the sampler writes)

| Metric                | Definition                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `cpu_seconds_delta`   | Cumulative CPU time of the `qemu-system-*` process at the last sample minus the first       |
| `cpu_percent_of_core` | `cpu_seconds_delta / window_seconds`, in percent of one core (not the decaying `ps` figure) |
| `unique_kib_avg/peak` | macOS `footprint` physical footprint; Linux `smaps_rollup` `Pss`. Never RSS (shared pages)  |
| time-to-boot          | seconds from process start to `sys.boot_completed=1`                                        |
| time-to-quiet         | seconds from process start until three consecutive 30 s windows each burn at most 1.0 CPU-s |
| exit seconds, bytes   | wall time from `adb emu kill` to process exit; bytes added under the AVD directory          |

### Preflight

1. `uname -sm`, `sysctl -n hw.ncpu hw.memsize` (macOS) or `nproc; free -m` (Linux),
   `emulator -version`, `avdmanager list target`; record them in `host.txt`.
2. Host quiet: `uptime` load below 1.0 and no other emulator or Gradle process of this user
   (`pgrep -fl 'qemu-system|gradle'` empty). If not quiet, wait; do not measure on a busy host.
3. `adb devices` lists nothing in 5700-5720. Free disk at least 20 GiB (snapshots are 2-4 GiB each).
4. Create the AVDs (one per image level you measure; API 35 and API 37 for the RAM question):
   `avdmanager create avd -n am-cost-37-1 -k "system-images;android-37;google_apis;arm64-v8a" -d pixel_8`
   (use `x86_64` images on Linux).

### Run template

One run is one launch with the arm's flags, a fixed observation window and a clean exit. Evidence
goes under `scratch/emulator-host-cost/<host>/<date>/<step>-<arm>-<repeat>/`.

```bash
run=scratch/emulator-host-cost/$HOST/$(date +%F)/s2-cpu2-r1; mkdir -p "$run"
port=5700; serial=emulator-$port
emulator -avd am-cost-37-1 -port $port -no-window -no-boot-anim -no-snapshot-save \
  <arm flags> > "$run/emulator.log" 2>&1 &
pid=$!
start=$(date +%s)
adb -s $serial wait-for-device
adb -s $serial shell 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 1; done'
echo "time_to_boot=$(( $(date +%s) - start ))" > "$run/timings.txt"
# fixed window, started right after boot completes; 5 minutes unless the step says otherwise
scripts/android/emulator-host-cost-sample.sh $pid "$run" 60 5
adb -s $serial shell dumpsys meminfo > "$run/guest-meminfo.txt"
exit_start=$(date +%s); adb -s $serial emu kill; wait $pid
echo "exit_seconds=$(( $(date +%s) - exit_start ))" >> "$run/timings.txt"
du -sk ~/.android/avd/am-cost-37-1.avd > "$run/avd-kib-after.txt"
```

Take `avd-kib-before.txt` the same way before each launch; the bytes written are the difference.
Time-to-quiet is computed offline from the CPU-seconds column of `cost-samples.csv` (keep the
sample interval at 5 s so 30 s is six rows). Never use a PID or serial you did not start.

### Stop conditions and cleanup

Abort a run, record why, and do not retry blindly when the host load average rises above 4 during
the window, another process starts an emulator, free disk falls under 10 GiB, or the emulator
exits on its own. Cleanup after every session: `kill <pid>` of the emulators you started only (by
the PIDs you recorded), `avdmanager delete avd -n am-cost-37-1`, and remove any restored
`config.ini` edits.

## Out of scope

Custom system images, Cuttlefish, LMKD and zRAM changes, and read-only multi-instance AVDs.

## Background

- [Android emulator host cost research](../devlog/2026-10-26-android-emulator-host-cost-research.md)
