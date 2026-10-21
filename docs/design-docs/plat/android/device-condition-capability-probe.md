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

| Capability                                                      | Probe                            | Used by                | Observed  |
| --------------------------------------------------------------- | -------------------------------- | ---------------------- | --------- |
| `ro.secure`, `ro.debuggable`                                    | `getprop`                        | #14060, #14062         | _pending_ |
| SELinux mode                                                    | `getenforce`                     | #14060, #14062         | _pending_ |
| `am send-trim-memory`, `am crash`                               | `am help`                        | #14068                 | _pending_ |
| `dumpsys battery set/unplug/reset`                              | `dumpsys battery -h`             | #14063                 | _pending_ |
| `thermalservice inject-temperature/override-status`             | `cmd thermalservice help`        | #14063                 | _pending_ |
| `always_finish_activities`                                      | `settings get global`            | #14068                 | _pending_ |
| `ro.boot.verifiedbootstate`, `ro.boot.flash.locked` naming      | `getprop`                        | #14062, #14074         | _pending_ |
| Kernel release (GKI 2.0 for KernelSU)                           | `uname -r`                       | #14070                 | _pending_ |
| Magisk                                                          | `magisk --path`                  | #14070                 | _pending_ |
| `CONFIG_FAULT_INJECTION`, `CONFIG_NET_SCH_NETEM`                | `zcat /proc/config.gz`           | #14066                 | _pending_ |
| debugfs `fail_*` knobs                                          | `ls -d /sys/kernel/debug/fail_*` | #14066                 | _pending_ |
| `tc`                                                            | `which tc`                       | network shaping        | _pending_ |
| `pm` subcommands                                                | `pm help`                        | #14069                 | _pending_ |
| `toybox fallocate`, `toybox dd`                                 | `toybox`                         | #14066                 | _pending_ |
| Console `rotate`, `power`, `sensor`, `network`, `finger`, `avd` | `adb emu help <verb>`            | #14057, #14063, #14065 | _pending_ |

## `capabilityProbe` helper (proposal)

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
