# Android power fixtures (`setDeviceState.power`, #14084)

**Hand-reconstructed, not captured from a device.** No emulator was available when these
were written. Each file reproduces what the named command prints, reconstructed from AOSP
`BatteryService.dumpInternal`, `DeviceIdleController`'s shell command, `ThermalManagerService`
`dumpInternal`, `NetworkPolicyManagerShellCommand` and `ActivityManagerShellCommand`
(Android 14). Voltages, temperatures and listener counts are plausible, not real. Replace them
with verbatim captures when a device is available, and record the device, API level and
capture command here.

| File                                           | Command                                            | Format point it pins                                     |
| ---------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| `dumpsys-battery-real.txt`                     | `dumpsys battery` (untouched emulator)             | `AC powered: true`, `status: 2`, no fake                 |
| `dumpsys-battery-faked-unplugged-level-15.txt` | `dumpsys battery` after `unplug`/`set level`       | `(UPDATES STOPPED ...)` marks a fake; all chargers false |
| `dumpsys-thermalservice-normal.txt`            | `dumpsys thermalservice`                           | `IsStatusOverride: false`, `Thermal Status: 0`           |
| `dumpsys-thermalservice-override-3.txt`        | `dumpsys thermalservice` after `override-status 3` | `IsStatusOverride: true`, `Thermal Status: 3`            |
| `netpolicy-restrict-background-*.txt`          | `cmd netpolicy get restrict-background`            | `Restrict background status: enabled\|disabled`          |
| `deviceidle-force-idle-deep.txt`               | `dumpsys deviceidle force-idle deep`               | Success line `Now forced in to deep idle mode`           |
| `deviceidle-force-idle-not-enabled.txt`        | `dumpsys deviceidle force-idle`                    | Refusal `Unable to go idle; not enabled`                 |

Single-token outputs are asserted inline in the tests instead of fixture files:
`dumpsys deviceidle get deep|light` prints one state name (`ACTIVE`, `IDLE`, ...),
`dumpsys deviceidle enabled deep` prints `1` or `0`, `settings get global low_power` prints `0`,
`1` or `null`, `am get-standby-bucket <pkg>` prints the numeric bucket (10 active, 20 working
set, 30 frequent, 40 rare, 45 restricted) and `am get-inactive <pkg>` prints `Idle=true|false`.
