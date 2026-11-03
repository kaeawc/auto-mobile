# Device-condition capability probe

The device-condition fixtures (#14047) rely on commands whose availability changes across
emulator images, API levels, and kernels. Before building on them, the spike in #14053 needs
answers from a real emulator. This page describes how to collect those answers, the matrix
they fill in, and the `capabilityProbe` helper that the fixtures will use to check a
capability before acting on it.

**Status:** tooling only. No result on this page has been checked on a device yet. Every
cell marked _pending_ needs a run of the probe script, with its output recorded on #14053.

## Open question: does `-writable-system` survive a snapshot?

The research behind #14047 found that `-writable-system` writes go to a temporary copy of
the system image that is deleted when the emulator exits. The emulator docs don't say
whether those writes survive an `avd snapshot save` followed by a cold reload. The answer
decides how Phase 2 builds durable rooted fixtures (#14065):

- **Survives:** a rooted fixture is just a named snapshot.
- **Lost:** a rooted fixture needs a committed or patched system image.

To run the check on a `google_apis` or `default` AVD:

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
fresh AVD may ask for `adb disable-verity` and a reboot before it succeeds. Record that
step on #14053 if it happens.

| Image     | API       | Marker survived? | `id`      | `su 0 id` |
| --------- | --------- | ---------------- | --------- | --------- |
| _pending_ | _pending_ | _pending_        | _pending_ | _pending_ |

## Capability matrix

`probe-device-condition-capabilities.sh matrix` (the default mode) prints one Markdown row
per command. A row is `yes` when the command's output shows the subcommand or value is
there, and `no` otherwise, with the first output line kept as a note. Probe commands are
read-only. A failing command is recorded in the matrix and never stops the script.

| Capability                                                      | Probe                            | Used by                | Observed                                                                                                                                                   |
| --------------------------------------------------------------- | -------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ro.secure`, `ro.debuggable`                                    | `getprop`                        | #14060, #14062         | _pending_                                                                                                                                                  |
| SELinux mode                                                    | `getenforce`                     | #14060, #14062         | _pending_                                                                                                                                                  |
| `am send-trim-memory`, `am crash`                               | `am help`                        | #14068                 | Verified on Android 12L emulator (API 32): foreground accepts RUNNING_*; HIDDEN/BACKGROUND/MODERATE/COMPLETE refused; background accepts all seven levels. |
| `dumpsys battery set/unplug/reset`                              | `dumpsys battery -h`             | #14063                 | _pending_                                                                                                                                                  |
| `thermalservice inject-temperature/override-status`             | `cmd thermalservice help`        | #14063                 | _pending_                                                                                                                                                  |
| `always_finish_activities`                                      | `settings get global`            | #14068                 | _pending_                                                                                                                                                  |
| `ro.boot.verifiedbootstate`, `ro.boot.flash.locked` naming      | `getprop`                        | #14062, #14074         | _pending_                                                                                                                                                  |
| Kernel release (GKI 2.0 for KernelSU)                           | `uname -r`                       | #14070                 | _pending_                                                                                                                                                  |
| Magisk                                                          | `magisk --path`                  | #14070                 | _pending_                                                                                                                                                  |
| `CONFIG_FAULT_INJECTION`, `CONFIG_NET_SCH_NETEM`                | `zcat /proc/config.gz`           | #14066                 | _pending_                                                                                                                                                  |
| debugfs `fail_*` knobs                                          | `ls -d /sys/kernel/debug/fail_*` | #14066                 | _pending_                                                                                                                                                  |
| `tc`                                                            | `which tc`                       | network shaping        | _pending_                                                                                                                                                  |
| `pm` subcommands                                                | `pm help`                        | #14069                 | _pending_                                                                                                                                                  |
| `toybox fallocate`, `toybox dd`                                 | `toybox`                         | #14066                 | _pending_                                                                                                                                                  |
| Console `rotate`, `power`, `sensor`, `network`, `finger`, `avd` | `adb emu help <verb>`            | #14057, #14063, #14065 | _pending_                                                                                                                                                  |

## `capabilityProbe` helper (proposal)

`faults.readOnlyFilesystem` requires rootable Android images and remounts the `/storage/emulated` FUSE superblock read-only device-wide, causing app writes to `/sdcard` to fail with EROFS; apply and reset verify mount options, and only mounts changed by the injector are restored to read-write on release or session close, without creating files.

`faults.memoryPressure` pushes a per-ABI NDK payload to `/data/local/tmp/automobile-lmk-pressure` and sizes anonymous memory as `floor(MemAvailable / 1024) + 128` MiB (`MemAvailable` in kB), capped at 16384 MiB. The computed payload must be at least 256 MiB; the minimum applies after adding the overshoot, not to `MemAvailable` itself. The payload deliberately exceeds `MemAvailable` within the cap to exhaust swap and trigger lmkd kills. The injector passes a 1800-second limit, so the payload exits 30 minutes after readiness even if the daemon dies. After readiness, no matching lmkd kill within 15 seconds reports unsupported with both the payload size and the measured `MemAvailable`. The payload always runs as the shell user: started by a rooted adbd (`rootState`), it drops to UID 2000 itself rather than through `su`, which `rootState` may replace with inert stubs. Clearing `rootState` (`adb unroot`) therefore never leaves a root-owned payload the shell cannot stop. The injector checks the payload's UID after READY and refuses a binary built before this drop. Reset and restart recovery verify process identity before terminating the payload and remove its binary, PID and output files; an unverified apply rolls back and retains an owed reset if cleanup fails. Binaries are built from source per ABI by `scripts/android/build-lmk-pressure.sh` and are not checked in: CLAUDE.md/jj binary rules prohibit raw binary assets, there is no prebuilt native executable precedent, and the release pipeline builds the other native artifacts in CI. `AUTOMOBILE_LMK_PRESSURE_DIR` overrides the package-root `build/lmk-pressure` directory. Prepare Release builds both ABIs once with the runner's NDK (`build-lmk-pressure.yml`), requires each to be a 64-bit ELF for its own ABI and a second build to match byte for byte, pins them as `lmkPressureArm64Sha256` and `lmkPressureX8664Sha256`, and Release attaches those same bytes as `automobile-lmk-pressure-arm64-v8a` and `automobile-lmk-pressure-x86_64`. They are release assets, not npm package contents. The injector uses a local build first, then `LmkPressureBinaryProvider`, which downloads the device ABI's asset once, checks it against the pinned SHA-256 and caches it under the data directory in one directory per ABI and pinned SHA-256, so daemons on different releases never replace each other's binary (re-downloading when the recorded size or pinned SHA-256 changes). A release without a pinned checksum is unsupported without touching the network, a checksum mismatch is an error, and a set `AUTOMOBILE_LMK_PRESSURE_DIR` that lacks the binary is unsupported rather than downloaded around.

Each injector checks its capability before changing the device. When the capability is
missing, the injector skips that condition and says why, rather than failing the whole
`setDeviceState` call or applying half of a condition.

```ts
type DeviceConditionCapability =
  | "battery.dumpsysSet"
  | "thermal.injectTemperature"
  | "process.trimMemory"
  | "storage.faultInjection"
  | "console.power"; // …one id per matrix row the injectors need

type CapabilityProbeResult =
  | { supported: true; detail?: string }
  | { supported: false; reason: string };

interface DeviceCapabilityProbe {
  probe(
    capability: DeviceConditionCapability,
    signal?: AbortSignal,
  ): Promise<CapabilityProbeResult>;
}
```

- **One catalogue.** Each capability id maps to a probe spec: the command, the channel
  (`adb shell` or emulator console), and the output match. The TypeScript catalogue becomes
  the source of truth. The shell script is the research tool that fills in the matrix above
  and can be retired or generated from the catalogue later.
- **Cached per boot.** Results are cached per device, keyed by
  `/proc/sys/kernel/random/boot_id`. A cold boot or snapshot load changes what the device
  can do, so the cache is also cleared when AutoMobile restores a snapshot.
- **Privilege-aware.** Probes run as the shell user. A capability that needs root reports
  `{ supported: false, reason: "requires adb root" }` when `id` is not uid 0, so the caller
  can tell "needs root" apart from "missing on this image".
- **Skip with a reason.** An unsupported condition does not reach the device. It shows up in
  the `setDeviceState` result as `{ condition, status: "skipped", reason }`. A skip is not
  recorded as a failure.
- **Testable.** A `FakeDeviceCapabilityProbe` takes a map of capability to result, so
  injector unit tests cover both paths without a device. The real probe runs against an
  injected `AdbExecutor` and `EmulatorConsoleClient`.
- **Where it lands:** `src/features/deviceCondition/`, together with the `deviceCondition`
  surface (#14050) or its first injector.
