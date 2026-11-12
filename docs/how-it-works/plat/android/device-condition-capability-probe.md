# Device-condition capability probe

The device-condition fixtures (#14047) rely on commands whose availability changes across emulator
images, API levels and kernels. `scripts/local-dev/probe-device-condition-capabilities.sh` collects
that availability from a real emulator. The `capabilityProbe` helper the fixtures would use to check
a capability before acting is a proposal, not built.

## Snapshot persistence check

Checks whether `-writable-system` writes survive an `avd snapshot save` followed by a cold reload, on
a `google_apis` or `default` AVD:

```bash
emulator -avd <avd> -writable-system &
scripts/local-dev/probe-device-condition-capabilities.sh persistence-prepare
# stop the emulator, then cold-start from the snapshot without saving over it
emulator -avd <avd> -writable-system -snapshot root-fixture -no-snapshot-save &
scripts/local-dev/probe-device-condition-capabilities.sh persistence-verify
```

`persistence-prepare` runs `adb root` and `adb remount`, writes a marker under `/system`,
reads it back, and saves the `root-fixture` snapshot. `persistence-verify` reads the marker
back and prints `id` and `su 0 id`. On API 29 and newer, the first `adb remount` on a
fresh AVD may ask for `adb disable-verity` and a reboot before it succeeds.

## Capability matrix

`probe-device-condition-capabilities.sh matrix` (the default mode) prints one Markdown row per
command. A row is `yes` when the command's output shows the subcommand or value is there, and `no`
otherwise, with the first output line kept as a note. Probe commands are read-only. A failing command
is recorded in the matrix and never stops the script.

| Capability                                                      | Probe                            | Used by                |
| --------------------------------------------------------------- | -------------------------------- | ---------------------- |
| `ro.secure`, `ro.debuggable`                                    | `getprop`                        | #14060, #14062         |
| SELinux mode                                                    | `getenforce`                     | #14060, #14062         |
| `am send-trim-memory`, `am crash`                               | `am help`                        | #14068                 |
| `dumpsys battery set/unplug/reset`                              | `dumpsys battery -h`             | #14063                 |
| `thermalservice inject-temperature/override-status`             | `cmd thermalservice help`        | #14063                 |
| `always_finish_activities`                                      | `settings get global`            | #14068                 |
| `ro.boot.verifiedbootstate`, `ro.boot.flash.locked` naming      | `getprop`                        | #14062, #14074         |
| Kernel release (GKI 2.0 for KernelSU)                           | `uname -r`                       | #14070                 |
| Magisk                                                          | `magisk --path`                  | #14070                 |
| `CONFIG_FAULT_INJECTION`, `CONFIG_NET_SCH_NETEM`                | `zcat /proc/config.gz`           | #14066                 |
| debugfs `fail_*` knobs                                          | `ls -d /sys/kernel/debug/fail_*` | #14066                 |
| `tc`                                                            | `which tc`                       | network shaping        |
| `pm` subcommands                                                | `pm help`                        | #14069                 |
| `toybox fallocate`, `toybox dd`                                 | `toybox`                         | #14066                 |
| Console `rotate`, `power`, `sensor`, `network`, `finger`, `avd` | `adb emu help <verb>`            | #14057, #14063, #14065 |

## Injectors with device-capability contracts

`faults.readOnlyFilesystem` requires rootable Android images and remounts the `/storage/emulated` FUSE superblock read-only device-wide, causing app writes to `/sdcard` to fail with EROFS; apply and reset verify mount options, and only mounts changed by the injector are restored to read-write on release or session close, without creating files.

`faults.memoryPressure`:

- Pushes a per-ABI NDK payload to `/data/local/tmp/automobile-lmk-pressure` and sizes anonymous
  memory as `floor(MemAvailable / 1024) + 128` MiB (`MemAvailable` in kB), capped at 16384 MiB. The
  computed payload must be at least 256 MiB; the minimum applies after adding the overshoot, not to
  `MemAvailable` itself. The payload deliberately exceeds `MemAvailable` within the cap to exhaust
  swap and trigger lmkd kills.
- Passes a 1800-second limit, so the payload exits 30 minutes after readiness even if the daemon
  dies. After readiness, no matching lmkd kill within 15 seconds reports unsupported with both the
  payload size and the measured `MemAvailable`.
- The payload always runs as the shell user: started by a rooted adbd (`rootState`), it drops to
  UID 2000 itself rather than through `su`, which `rootState` may replace with inert stubs. Clearing
  `rootState` (`adb unroot`) therefore never leaves a root-owned payload the shell cannot stop. The
  injector checks the payload's UID after READY and refuses a binary built before this drop.
- Reset and restart recovery verify process identity before terminating the payload and remove its
  binary, PID and output files; an unverified apply rolls back and retains an owed reset if cleanup
  fails.
- Binaries are built from source per ABI by `scripts/android/build-lmk-pressure.sh` and are not
  checked in. `AUTOMOBILE_LMK_PRESSURE_DIR` overrides the package-root `build/lmk-pressure`
  directory.
- Prepare Release builds both ABIs once with the runner's NDK (`build-lmk-pressure.yml`), requires
  each to be a 64-bit ELF for its own ABI and a second build to match byte for byte, and pins them as
  `lmkPressureArm64Sha256` and `lmkPressureX8664Sha256`. Release attaches those same bytes as
  `automobile-lmk-pressure-arm64-v8a` and `automobile-lmk-pressure-x86_64`: release assets, not npm
  package contents.
- The injector uses a local build first, then `LmkPressureBinaryProvider`, which downloads the device
  ABI's asset once, checks it against the pinned SHA-256 and caches it under the data directory in
  one directory per ABI and pinned SHA-256, so daemons on different releases never replace each
  other's binary (re-downloading when the recorded size or pinned SHA-256 changes). A release without
  a pinned checksum is unsupported without touching the network, a checksum mismatch is an error, and
  a set `AUTOMOBILE_LMK_PRESSURE_DIR` that lacks the binary is unsupported rather than downloaded
  around.
- Pull requests that change the payload, its build or its injector run the x86_64 binary on an
  x86_64 CI emulator (`lmk-pressure-emulator-smoke.sh`): it must report READY, run as the shell user
  and stop; lmkd kills are not part of that smoke.

## Background

- [Device-condition capability probe: spike and helper proposal](../../../devlog/2026-10-21-device-condition-capability-probe-spike.md)
