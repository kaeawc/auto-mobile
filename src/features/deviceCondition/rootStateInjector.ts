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

async function plantArtifacts(
  adb: AdbExecutor,
  paths: readonly string[],
  planted: Set<string>,
  signal?: AbortSignal,
): Promise<void> {
  for (const path of paths) {
    // Recorded before the write so a half-planted file is still removed by the rollback.
    planted.add(path);
    // adb joins these with spaces for the device shell, so the script must be one quoted word.
    await shell(adb, ["printf", shellQuote(STUB_SCRIPT), ">", path], signal);
    await shell(adb, ["chmod", path.endsWith(".apk") ? "0644" : "06755", path], signal);
  }
}

/**
 * Which of `paths` exist. `ls` exits nonzero when ANY operand is missing even though it still
 * lists the ones that exist, and the adb client rejects a nonzero exit, so `; true` keeps the
 * partial listing. A read that genuinely fails (transport error) throws instead of reading as
 * "none exist".
 */
async function listExisting(
  adb: AdbExecutor,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  if (paths.length === 0) {
    return new Set();
  }
  // A failed listing throws: reading it as "none exist" would let apply overwrite a real file.
  const out = await shell(adb, ["ls", ...paths, "2>/dev/null;", "true"], signal);
  return new Set(
    out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );
}

const selinuxFlag = (mode: string): string => (/permissive/i.test(mode) ? "0" : "1");

export function createRootStateInjector(adb: AdbExecutor): DeviceConditionInjector {
  let baselineSelinux = "Enforcing";
  // The baseline is captured once and kept until a reset fully succeeds: recapturing it while
  // anything is still owed would record the fixture's own Permissive as "the original".
  let baselineCaptured = false;
  let selinuxChanged = false;
  // True while this fixture is applied and its reset is owed; a repeat apply is then coalesced.
  let active = false;
  // Only artifacts WE planted. A userdebug image ships a real su; it is never overwritten here
  // and never deleted by reset.
  const planted = new Set<string>();
  // One reset serves every apply, so repeat applies never stack separate cleanups. It is
  // defined here, before any mutation, so every later failure can undo it.
  const reset = async (resetSignal?: AbortSignal): Promise<void> => {
    // Re-acquire the privileges the cleanup needs: an earlier reset (or a reboot) may
    // have un-rooted adbd. `adb root` is a no-op when it is already running as root.
    await adbCommand(adb, ["root"], resetSignal);
    await adbCommand(adb, ["wait-for-device"], resetSignal);
    let remaining = new Set<string>();
    if (planted.size > 0) {
      await shell(adb, ["rm", "-f", ...planted], resetSignal);
      // Confirm the removal; `planted` is only cleared once the files are really gone.
      remaining = await listExisting(adb, [...planted], resetSignal);
    }
    if (selinuxChanged) {
      await shell(adb, ["setenforce", selinuxFlag(baselineSelinux)], resetSignal);
    }
    await adbCommand(adb, ["unroot"], resetSignal);
    if (remaining.size > 0) {
      // Everything else is restored, but the reset stays owed so release retries and reports it.
      throw new ActionableError(
        `rootState reset left artifacts on the device: ${[...remaining].join(", ")}`,
      );
    }
    planted.clear();
    selinuxChanged = false;
    baselineCaptured = false;
    active = false;
  };
  const plantedStillThere = async (signal?: AbortSignal): Promise<boolean> => {
    const existing = await listExisting(adb, [...planted], signal);
    return [...planted].every((path) => existing.has(path));
  };
  // After a reboot that keeps the modified system image the files survive but SELinux is back
  // to Enforcing, so "already applied" has to check the mode as well as the files.
  const selinuxStillPermissive = async (signal?: AbortSignal): Promise<boolean> =>
    !selinuxChanged || /permissive/i.test(await shell(adb, ["getenforce"], signal));
  return {
    key: "rootState",
    async apply(value, signal): Promise<DeviceConditionApplyOutcome> {
      if (value !== ROOTED_DETECTABLE) {
        rejectValue("rootState", value, [ROOTED_DETECTABLE]);
      }
      await assertRootableImage(adb, signal);
      const wasActive = active;
      if (
        wasActive &&
        (await plantedStillThere(signal)) &&
        (await selinuxStillPermissive(signal))
      ) {
        return { status: "unchanged", detail: "rooted-detectable fixture is already applied" };
      }
      // Both reads happen before the first mutation, so a failed probe changes nothing.
      const existing = await listExisting(adb, ROOT_ARTIFACT_PATHS, signal);
      if (!baselineCaptured) {
        baselineSelinux = (await shell(adb, ["getenforce"], signal)) || "Enforcing";
        baselineCaptured = true;
      }
      const toPlant = ROOT_ARTIFACT_PATHS.filter((path) => !existing.has(path));
      try {
        await remountWritable(adb, signal);
        selinuxChanged = true;
        await shell(adb, ["setenforce", "0"], signal);
        await plantArtifacts(adb, toPlant, planted, signal);
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
      active = true;
      if (wasActive) {
        // The reset registered by the original apply still covers this fixture.
        return { status: "applied", detail: "rooted-detectable fixture re-applied after drift" };
      }
      const kept = ROOT_ARTIFACT_PATHS.length - toPlant.length;
      return {
        status: "applied",
        detail:
          kept > 0
            ? `rooted-detectable fixture planted (${kept} artifact(s) already present on the image were left as-is)`
            : "rooted-detectable fixture planted",
        reset,
      };
    },
    async isClean(signal): Promise<boolean> {
      if (planted.size > 0) {
        try {
          if ((await listExisting(adb, [...planted], signal)).size > 0) {
            return false;
          }
        } catch (error) {
          if (signal?.aborted) {
            throw error;
          }
          // A read that cannot run cannot show the device is clean, so report it as not clean.
          logger.warn(
            `rootState clean check could not list artifacts: ${errorMessage(error)}`,
            error,
          );
          return false;
        }
      }
      const mode = await shell(adb, ["getenforce"], signal);
      return /permissive/i.test(mode) === /permissive/i.test(baselineSelinux);
    },
  };
}

/** One injector per device, so repeat applies share the baseline and the applied flag. */
const injectorsByDevice = new Map<string, DeviceConditionInjector>();

/**
 * The `rootState` injector for an Android device, or undefined for any other key or
 * platform. The same instance serves every apply on a device; tests pass their own cache.
 */
export function resolveRootStateInjector(
  device: BootedDevice,
  key: DeviceConditionKey,
  adbFactory: AdbClientFactory = defaultAdbClientFactory,
  cache: Map<string, DeviceConditionInjector> = injectorsByDevice,
): DeviceConditionInjector | undefined {
  if (device.platform !== "android" || key !== "rootState") {
    return undefined;
  }
  let injector = cache.get(device.deviceId);
  if (!injector) {
    injector = createRootStateInjector(adbFactory.create(device));
    cache.set(device.deviceId, injector);
  }
  return injector;
}
