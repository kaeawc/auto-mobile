import type { BootedDevice } from "../../models";
import { z } from "zod";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type {
  DeviceConditionApplyOutcome,
  DeviceConditionInjector,
} from "./DeviceConditionController";
import {
  ANDROID_PACKAGE_NAME_PATTERN,
  DEVICE_CONDITION_APPLY,
  type DeviceConditionKey,
} from "./DeviceConditionTypes";
import {
  rejectValue,
  resolveAppUserWith,
  shell,
  unsupported,
  type ResolveAppUser,
} from "./injectorSupport";

/**
 * Process faults for `deviceCondition.faults` (#14068), Android only and root-free. Both act once
 * on a running app's process and leave nothing on the device to restore, so neither registers a
 * reset and `isClean` is always true; `unset` is a no-op.
 *
 * - `killApp`: the app dies the way the system or the user would end it. `background` is
 *   `am kill`, which only ends a process the system could reclaim (never the foreground app);
 *   `forceStop` is `am force-stop`, the user's "Force stop", which also cancels its alarms and
 *   jobs and leaves it stopped until launched.
 * - `trimMemory`: `am send-trim-memory` delivers an `onTrimMemory` level to the running app, so
 *   its cache-dropping paths run without real memory pressure.
 */

/** Keys this module owns, under the `faults.` prefix of the deviceCondition surface. */
export const PROCESS_FAULT_KEYS = ["faults.killApp", "faults.trimMemory"] as const;

export const KILL_MODES = ["background", "forceStop"] as const;

/** The `ComponentCallbacks2` levels `am send-trim-memory` accepts. */
export const TRIM_MEMORY_LEVELS = [
  "HIDDEN",
  "RUNNING_MODERATE",
  "BACKGROUND",
  "RUNNING_LOW",
  "MODERATE",
  "RUNNING_CRITICAL",
  "COMPLETE",
] as const;

const killSchema = z
  .object({
    package: z.string().regex(ANDROID_PACKAGE_NAME_PATTERN),
    mode: z.enum(KILL_MODES),
  })
  .strict();

const trimSchema = z
  .object({
    package: z.string().regex(ANDROID_PACKAGE_NAME_PATTERN),
    level: z.enum(TRIM_MEMORY_LEVELS),
  })
  .strict();

/** `pidof` exits nonzero when no process matches, which the adb client rejects, so end in `; true`. */
async function isRunning(
  adb: AdbExecutor,
  packageName: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return (await shell(adb, ["pidof", packageName, "2>/dev/null;", "true"], signal)) !== "";
}

const noReset = (): Promise<boolean> => Promise.resolve(true);

/** `faults.killApp` `{ package, mode }`: end the app's process once. */
export function createKillAppInjector(
  adb: AdbExecutor,
  resolveUser: ResolveAppUser = resolveAppUserWith(adb),
): DeviceConditionInjector {
  return {
    key: "faults.killApp",
    async apply(value, signal, params): Promise<DeviceConditionApplyOutcome> {
      if (value !== DEVICE_CONDITION_APPLY) {
        rejectValue("faults.killApp", value, ["{ package, mode }"]);
      }
      const parsed = killSchema.safeParse(params);
      if (!parsed.success) {
        rejectValue("faults.killApp", JSON.stringify(params ?? null), [
          `{ package, mode: ${KILL_MODES.join(" | ")} }`,
        ]);
      }
      const { package: packageName, mode } = parsed.data;
      if (!(await isRunning(adb, packageName, signal))) {
        return { status: "unchanged", detail: `${packageName} is not running` };
      }
      const userId = String(await resolveUser(packageName, signal));
      const command = mode === "forceStop" ? "force-stop" : "kill";
      await shell(adb, ["am", command, "--user", userId, packageName], signal);
      if (await isRunning(adb, packageName, signal)) {
        return mode === "background"
          ? {
              status: "unchanged",
              detail: `${packageName} is still running: am kill only ends a process the system could reclaim, never the foreground app. Use mode forceStop to end it.`,
            }
          : unsupported(`${packageName} is still running after am force-stop`);
      }
      return {
        status: "applied",
        detail:
          mode === "forceStop"
            ? `force-stopped ${packageName}; it stays stopped until launched`
            : `killed the background process of ${packageName}`,
      };
    },
    isClean: noReset,
  };
}

/** `faults.trimMemory` `{ package, level }`: deliver one `onTrimMemory` level to the running app. */
export function createTrimMemoryInjector(
  adb: AdbExecutor,
  resolveUser: ResolveAppUser = resolveAppUserWith(adb),
): DeviceConditionInjector {
  return {
    key: "faults.trimMemory",
    async apply(value, signal, params): Promise<DeviceConditionApplyOutcome> {
      if (value !== DEVICE_CONDITION_APPLY) {
        rejectValue("faults.trimMemory", value, ["{ package, level }"]);
      }
      const parsed = trimSchema.safeParse(params);
      if (!parsed.success) {
        rejectValue("faults.trimMemory", JSON.stringify(params ?? null), [
          `{ package, level: ${TRIM_MEMORY_LEVELS.join(" | ")} }`,
        ]);
      }
      const { package: packageName, level } = parsed.data;
      if (!(await isRunning(adb, packageName, signal))) {
        unsupported(`${packageName} is not running, so there is no process to trim`);
      }
      const userId = String(await resolveUser(packageName, signal));
      const out = await shell(
        adb,
        ["am", "send-trim-memory", "--user", userId, packageName, level],
        signal,
      );
      // `am` reports a refused request on stdout with a zero exit.
      if (/\b(error|exception|unknown)\b/i.test(out)) {
        unsupported(`am send-trim-memory ${packageName} ${level} failed: ${out}`);
      }
      return { status: "applied", detail: `sent trim-memory level ${level} to ${packageName}` };
    },
    isClean: noReset,
  };
}

/** The injectable seams a test overrides; production uses the default adb factory. */
export interface ProcessFaultInjectorDeps {
  adbFactory?: AdbClientFactory;
}

/**
 * Build the injector for a process `faults.*` key on an Android device, or undefined when the key
 * is not one of them or the device is not Android. Both injectors hold no state, so there is
 * nothing to cache across the registry's per-apply resolution.
 */
export function resolveProcessFaultInjector(
  device: BootedDevice,
  key: DeviceConditionKey,
  deps: ProcessFaultInjectorDeps = {},
): DeviceConditionInjector | undefined {
  if (device.platform !== "android" || !(PROCESS_FAULT_KEYS as readonly string[]).includes(key)) {
    return undefined;
  }
  const adb = (deps.adbFactory ?? defaultAdbClientFactory).create(device);
  return key === "faults.killApp" ? createKillAppInjector(adb) : createTrimMemoryInjector(adb);
}
