import type { BootedDevice } from "../../models";
import { logger } from "../logger";
import type { Timer } from "../SystemTimer";
import type { AdbClientFactory } from "./AdbClientFactory";
import type { ReadinessDiagnostic } from "./AndroidDeviceInventoryScanner";
import type { EmulatorConsoleBusyRegistry } from "./EmulatorConsoleBusyRegistry";
import { readinessDiagnostic, throwIfReadinessAborted } from "./emulatorReadinessEvaluation";

export interface RunningAvdNameResult {
  name: string;
  diagnostic?: ReadinessDiagnostic;
  consoleBusyDuringProbe?: boolean;
  /**
   * Point-in-time: the AVD-name probe exhausted its budget without an answer.
   * Host load or a stalled daemon event loop supplies no AVD identity evidence (#14333).
   */
  nameProbeTimedOut?: boolean;
}

export interface RunningAvdNameDeps {
  consoleBusyRegistry: EmulatorConsoleBusyRegistry;
  adbFactory: AdbClientFactory;
  timer: Timer;
}

/**
 * `infoTimeoutMs` is the TOTAL budget for naming this runtime, not a per-command
 * allowance. The console probe and the `getprop` fallback run sequentially, so
 * giving each its own full budget would let two stalled commands take twice the
 * timeout the caller asked for -- and this resolver runs inside a destructive
 * action that is already holding a lifecycle lease against a deadline (#6863
 * review). They share one deadline; the fallback gets only what is left of it,
 * and is skipped when nothing is.
 */
export async function resolveRunningAvdNameOnce(
  deps: RunningAvdNameDeps,
  device: BootedDevice,
  infoTimeoutMs: number,
  { signal, consoleExclusiveOwner }: { signal?: AbortSignal; consoleExclusiveOwner?: boolean } = {},
): Promise<RunningAvdNameResult> {
  const { consoleBusyRegistry, adbFactory, timer } = deps;
  const deviceId = device.deviceId;
  const busyBeforeDispatch = consoleBusyRegistry.isBusy(deviceId);
  if (busyBeforeDispatch && !consoleExclusiveOwner) {
    // `adb devices` has already established that the serial exists. During a
    // daemon-owned snapshot operation, both identity probes can transiently
    // lose the ADB transport; leave identity unresolved instead of creating
    // the false missing-device evidence that reaches the disconnect monitor.
    logger.debug(
      `Skipping AVD-name resolution for ${deviceId}: a console-exclusive operation is in flight`,
    );
    return { name: "", consoleBusyDuringProbe: true };
  }

  const adbWithDevice = adbFactory.create(device);
  const deadlineMs = timer.now() + infoTimeoutMs;
  let diagnostic: ReadinessDiagnostic | undefined;
  const generationBeforeDispatch = consoleBusyRegistry.getGeneration(deviceId);
  try {
    const result = await adbWithDevice.executeCommand("emu avd name", {
      timeoutMs: infoTimeoutMs,
      noRetry: true,
      signal,
    });
    const avdName = result.stdout.trim().replace(/\r?\n.*$/, "");
    logger.debug(
      `AVD name detection for ${deviceId}: raw="${result.stdout}" (${result.stdout.length} chars), cleaned="${avdName}"`,
    );
    if (avdName) {
      return { name: avdName };
    }
  } catch (error) {
    throwIfReadinessAborted(signal);
    diagnostic = readinessDiagnostic("avd-name-resolution", error, deviceId);
    logger.debug(`Failed to get AVD name for ${deviceId}: ${error}`);
  }

  const consoleBusyDuringProbe =
    busyBeforeDispatch ||
    consoleBusyRegistry.isBusy(deviceId) ||
    generationBeforeDispatch !== consoleBusyRegistry.getGeneration(deviceId);

  const remainingMs = deadlineMs - timer.now();
  if (remainingMs <= 0) {
    logger.debug(
      `AVD name resolution for ${deviceId} spent its ${infoTimeoutMs}ms budget on the console probe; skipping the property fallback`,
    );
    return { name: "", diagnostic, consoleBusyDuringProbe, nameProbeTimedOut: true };
  }

  try {
    const result = await adbWithDevice.executeCommand("shell getprop ro.boot.qemu.avd_name", {
      timeoutMs: remainingMs,
      noRetry: true,
      signal,
    });
    const avdName = result.stdout.trim().replace(/\r?\n.*$/, "");
    logger.debug(
      `AVD name property fallback for ${deviceId}: raw="${result.stdout}" (${result.stdout.length} chars), cleaned="${avdName}"`,
    );
    return avdName
      ? { name: avdName }
      : {
          name: "",
          diagnostic,
          consoleBusyDuringProbe,
          ...(timer.now() >= deadlineMs && { nameProbeTimedOut: true }),
        };
  } catch (error) {
    throwIfReadinessAborted(signal);
    logger.debug(`Failed to get AVD name property for ${deviceId}: ${error}`);
    return {
      name: "",
      diagnostic: readinessDiagnostic("avd-name-resolution", error, deviceId),
      consoleBusyDuringProbe,
      nameProbeTimedOut: timer.now() >= deadlineMs,
    };
  }
}
