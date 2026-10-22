import type { BootedDevice } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type {
  DeviceConditionApplyOutcome,
  DeviceConditionInjector,
} from "./DeviceConditionController";
import type { DeviceConditionKey } from "./DeviceConditionTypes";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";
import { OwedResetError } from "./OwedResetError";
import { adbCommand, rejectValue, shell } from "./injectorSupport";

/**
 * `deviceCondition.rootState` (#14060): make a non-Play emulator present as rooted
 * for detection testing. This is a detectable fixture, not working privilege
 * escalation: the planted `su`/`busybox` are inert stubs that trip file-based
 * RootBeer/Talsec checks, with SELinux set permissive. Google Play images refuse
 * `adb root`, so they are refused up front with a pointer to real root (#14070).
 */
export const ROOTED_DETECTABLE = "rooted-detectable";

/** Files planted on the writable system partition; reset removes exactly these. */
export const ROOT_ARTIFACT_PATHS = [
  "/system/xbin/su",
  "/system/bin/su",
  "/system/xbin/busybox",
  "/system/bin/busybox",
  "/system/app/Superuser.apk",
] as const;

const STUB_SCRIPT = "#!/system/bin/sh\\nexit 1\\n";

/** A Play image is a production build: not debuggable, and `adb root` is refused. */
async function assertRootableImage(adb: AdbExecutor, signal?: AbortSignal): Promise<void> {
  const debuggable = await shell(adb, ["getprop", "ro.debuggable"], signal);
  const buildType = await shell(adb, ["getprop", "ro.build.type"], signal);
  if (debuggable !== "1" || buildType === "user") {
    throw new ActionableError(
      "rootState needs a non-Play image (google_apis, default or aosp): this device is a production " +
        `build (ro.debuggable=${debuggable || "?"}, ro.build.type=${buildType || "?"}) and refuses adb root. ` +
        "For real root on a Play image, use the rootAVD/Magisk fixture (#14070).",
    );
  }
}

async function remountWritable(adb: AdbExecutor, signal?: AbortSignal): Promise<void> {
  await adbCommand(adb, ["root"], signal);
  await adbCommand(adb, ["wait-for-device"], signal);
  const out = await adbCommand(adb, ["remount"], signal);
  if (
    /remount failed|verity|not permitted|read-only/i.test(out) &&
    !/remount succeeded/i.test(out)
  ) {
    throw new ActionableError(
      `adb remount did not make /system writable (${out.split("\n")[0]}). Boot the AVD with ` +
        "-writable-system, or run `adb disable-verity` and reboot first.",
    );
  }
}

async function plantArtifacts(adb: AdbExecutor, signal?: AbortSignal): Promise<void> {
  for (const path of ROOT_ARTIFACT_PATHS) {
    // adb joins these with spaces for the device shell, so the script must be one quoted word.
    await shell(adb, ["printf", shellQuote(STUB_SCRIPT), ">", path], signal);
    await shell(adb, ["chmod", path.endsWith(".apk") ? "0644" : "06755", path], signal);
  }
}

async function removeArtifacts(adb: AdbExecutor, signal?: AbortSignal): Promise<void> {
  await shell(adb, ["rm", "-f", ...ROOT_ARTIFACT_PATHS], signal);
}

const selinuxFlag = (mode: string): string => (/permissive/i.test(mode) ? "0" : "1");

export function createRootStateInjector(adb: AdbExecutor): DeviceConditionInjector {
  let baselineSelinux = "Enforcing";
  const artifactsPresent = async (signal?: AbortSignal): Promise<boolean> => {
    const listing = await shell(adb, ["ls", ...ROOT_ARTIFACT_PATHS, "2>/dev/null"], signal).catch(
      () => "",
    );
    return listing.trim() !== "";
  };
  return {
    key: "rootState",
    async apply(value, signal): Promise<DeviceConditionApplyOutcome> {
      if (value !== ROOTED_DETECTABLE) {
        rejectValue("rootState", value, [ROOTED_DETECTABLE]);
      }
      await assertRootableImage(adb, signal);
      baselineSelinux = (await shell(adb, ["getenforce"], signal)) || "Enforcing";
      let selinuxChanged = false;
      // Defined before the first mutation (`adb root`) so every later failure can undo it.
      const reset = async (resetSignal?: AbortSignal): Promise<void> => {
        await removeArtifacts(adb, resetSignal);
        if (selinuxChanged) {
          await shell(adb, ["setenforce", selinuxFlag(baselineSelinux)], resetSignal);
        }
        await adbCommand(adb, ["unroot"], resetSignal);
      };
      try {
        await remountWritable(adb, signal);
        selinuxChanged = true;
        await shell(adb, ["setenforce", "0"], signal);
        await plantArtifacts(adb, signal);
      } catch (error) {
        try {
          await reset();
        } catch (cleanupError) {
          logger.warn(`rootState rollback failed: ${errorMessage(cleanupError)}`, cleanupError);
          throw new OwedResetError(
            `${errorMessage(error)} Cleanup also failed (${errorMessage(cleanupError)}); the device may still be rooted, and release will retry.`,
            reset,
            { cause: error },
          );
        }
        throw error;
      }
      return { status: "applied", detail: "rooted-detectable fixture planted", reset };
    },
    async isClean(signal): Promise<boolean> {
      if (await artifactsPresent(signal)) {
        return false;
      }
      const mode = await shell(adb, ["getenforce"], signal);
      return /permissive/i.test(mode) === /permissive/i.test(baselineSelinux);
    },
  };
}

/** The `rootState` injector for an Android device, or undefined for any other key or platform. */
export function resolveRootStateInjector(
  device: BootedDevice,
  key: DeviceConditionKey,
  adbFactory: AdbClientFactory = defaultAdbClientFactory,
): DeviceConditionInjector | undefined {
  if (device.platform !== "android" || key !== "rootState") {
    return undefined;
  }
  return createRootStateInjector(adbFactory.create(device));
}
