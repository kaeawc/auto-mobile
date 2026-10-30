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
| Snapshots      | quick-boot load and save; `-no-snapshot-save` on snapshot-reset wipe-data relaunches, broker launches (§5) | `androidSnapshotResetNativePort.ts`     |
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
   `-no-snapshot-save` when no snapshot reset can use the exit state: no `androidResetMode` (released
   emulators are destroyed), or `keep-booted` without `androidKeepBootedFallback: "snapshot"` (a
   non-clean release deletes the AVD; a clean one stays booted). `snapshot` hosts, `keep-booted` with
   the snapshot fallback, user AVDs and `startDevice` keep the default. The broker baseline is saved
   and loaded explicitly with `avd snapshot save|load`, which the flag does not disable. 74.6 GiB of
   snapshots on this host, including for AVD kinds the broker destroys. Needs a device run for the
   saving and a check against `deviceSnapshot` and the keep-booted baseline (#14363).

None of these changes a default by itself. Items 2 and 3 are labelled `needs-device-verify`.

## 6. Device measurement plan (#15478, `needs-device-verify`)

Not run: manual tests are paused. This section is a run sheet for a lane that holds a clean device
slot. It extends the protocol in the optimization doc. Read-only host sampling is
`scripts/android/emulator-host-cost-sample.sh`; `scripts/android/benchmark-emulator-resources.sh`
stays the guest-side snapshot collector.

### 6.1 Rules

Dedicated research AVDs named `am-cost-<api>-<n>`, deleted afterwards. Never `emulator-5554`, the
resident daemon, another lane's emulator or the owner's protected emulator. Hold system image,
emulator build, host load, framebuffer and snapshot state constant; one change at a time; baseline,
treatment, baseline; at least three repeats of each arm. Use only emulator ports 5700-5720 (even
numbers), so a stray `adb` serial can never be another lane's device.

### 6.2 Metrics (what the sampler writes)

| Metric                | Definition                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `cpu_seconds_delta`   | Cumulative CPU time of the `qemu-system-*` process at the last sample minus the first       |
| `cpu_percent_of_core` | `cpu_seconds_delta / window_seconds`, in percent of one core (not the decaying `ps` figure) |
| `unique_kib_avg/peak` | macOS `footprint` physical footprint; Linux `smaps_rollup` `Pss`. Never RSS (shared pages)  |
| time-to-boot          | seconds from process start to `sys.boot_completed=1`                                        |
| time-to-quiet         | seconds from process start until three consecutive 30 s windows each burn at most 1.0 CPU-s |
| exit seconds, bytes   | wall time from `adb emu kill` to process exit; bytes added under the AVD directory          |

### 6.3 Preflight

1. `uname -sm`, `sysctl -n hw.ncpu hw.memsize` (macOS) or `nproc; free -m` (Linux),
   `emulator -version`, `avdmanager list target`; record them in `host.txt`.
2. Host quiet: `uptime` load below 1.0 and no other emulator or Gradle process of this user
   (`pgrep -fl 'qemu-system|gradle'` empty). If not quiet, wait; do not measure on a busy host.
3. `adb devices` lists nothing in 5700-5720. Free disk at least 20 GiB (snapshots are 2-4 GiB each).
4. Create the AVDs (one per image level you measure; API 35 and API 37 for the RAM question):
   `avdmanager create avd -n am-cost-37-1 -k "system-images;android-37;google_apis;arm64-v8a" -d pixel_8`
   (use `x86_64` images on Linux).

### 6.4 Run template

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

### 6.5 Matrix

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
and 4096, launch once each, and record `hw.ramSize` from `hardware-qemu.ini` in the AVD directory
and `MemTotal` from `adb shell cat /proc/meminfo`.

**Step 5, breakage check.** Each candidate must pass these through a private daemon bound to the
research serial, with every call naming its `deviceId`: `startDevice` and runner start; `observe`
with a screenshot; `launchApp` and `terminateApp` on the Settings app; `tapOn`; `sendKeys` into a
text field; `videoRecording` start and stop; a posted notification appearing in the tray. A candidate
that fails or is flaky once in three is rejected, and the failing call goes in the results.

### 6.6 Results

One row per run in `results.csv` (columns: `host, step, arm, repeat, api, time_to_boot_s,
time_to_quiet_s, cpu_seconds_delta, cpu_percent_of_core, unique_kib_avg, unique_kib_peak, exit_s,
bytes_written_kib, step5_pass`), and a summary table per step in this note: arm means, the spread
(max minus min) of the baseline repeats, and the difference.

### 6.7 Stop conditions and cleanup

Abort a run, record why, and do not retry blindly when the host load average rises above 4 during
the window, another process starts an emulator, free disk falls under 10 GiB, or the emulator
exits on its own. Cleanup after every session: `kill <pid>` of the emulators you started only (by
the PIDs you recorded), `avdmanager delete avd -n am-cost-37-1`, and remove any restored
`config.ini` edits.

### 6.8 Decision rule

A default changes only for a lever whose host CPU or unique-memory difference exceeds twice the
baseline spread on both hosts, that leaves step 5 green, and that has a restore path. Otherwise the
result is an opt-in profile or nothing. Run on macOS arm64 and on Linux with KVM; the existing
evidence is macOS arm64 only.

## Out of scope

Custom system images, Cuttlefish, LMKD and zRAM changes, and read-only multi-instance AVDs.
