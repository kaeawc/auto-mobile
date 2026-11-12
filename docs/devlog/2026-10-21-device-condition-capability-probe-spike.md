# Device-condition capability probe: spike and helper proposal

- Kind: idea
- Date: 2026-10-21
- Source: moved from `how-it-works/plat/android/device-condition-capability-probe.md`; #14047, #14053, #14065, #14050, #14155, #16401
- Shaped: [Device-condition capability probe](../how-it-works/plat/android/device-condition-capability-probe.md)

## Spike

The #14053 spike needs answers from a real emulator before the device-condition fixtures build on
these commands. Results are recorded on #14053, including whether the first `adb remount` asked for
`adb disable-verity` and a reboot.

## Open question: does `-writable-system` survive a snapshot?

The research behind #14047 found that `-writable-system` writes go to a temporary copy of
the system image that is deleted when the emulator exits. The emulator docs don't say
whether those writes survive an `avd snapshot save` followed by a cold reload. The answer
decides how Phase 2 builds durable rooted fixtures (#14065):

- **Survives:** a rooted fixture is just a named snapshot.
- **Lost:** a rooted fixture needs a committed or patched system image.

| Image     | API       | Marker survived? | `id`      | `su 0 id` |
| --------- | --------- | ---------------- | --------- | --------- |
| _pending_ | _pending_ | _pending_        | _pending_ | _pending_ |

## Observed matrix results

- `am send-trim-memory`, `am crash` (`am help`, #14068): verified on an Android 12L emulator
  (API 32). Foreground accepts `RUNNING_*`; `HIDDEN`/`BACKGROUND`/`MODERATE`/`COMPLETE` are refused;
  background accepts all seven levels.
- Every other row is pending a run of the probe script.

## `capabilityProbe` helper proposal

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

## Why the lmk-pressure payload is not checked in (#16401)

Binaries are built from source rather than committed: CLAUDE.md/jj binary rules prohibit raw binary
assets, there is no prebuilt native executable precedent, and the release pipeline builds the other
native artifacts in CI.
