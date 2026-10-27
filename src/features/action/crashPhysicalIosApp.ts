import type { CrashAppResult } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { PhysicalIosAppCrasher } from "../../utils/ios-cmdline-tools/PhysicalIosAppCrasher";
import type { Timer } from "../../utils/SystemTimer";

/** The slice of {@link PhysicalIosAppCrasher} the crash flow needs. */
export type PhysicalIosCrashControl = Pick<PhysicalIosAppCrasher, "findAppPid" | "sendAbort">;

export interface PhysicalIosCrashContext {
  deviceId: string;
  appId: string;
  crasher: PhysicalIosCrashControl;
  timer: Timer;
  signal?: AbortSignal;
  /** Called once the signal command has been attempted, so caches see the new state. */
  onDispatched: () => void;
}

const EXIT_POLL_ATTEMPTS = 10;
const EXIT_POLL_MS = 250;

/**
 * Crash reports cannot be read from a physical device yet (#14103), so a delivered SIGABRT
 * followed by the process exiting is reported as success without OS crash evidence.
 */
const NO_CRASH_REPORT_SUMMARY =
  "SIGABRT was delivered and the process exited; crash-report confirmation on physical iOS devices is not available yet (#14103).";

type Base = Pick<CrashAppResult, "platform" | "appId" | "mechanism" | "confirmed" | "supported">;

/**
 * Crash an app on a physical iOS device with `devicectl device process signal --signal SIGABRT`
 * (#14096). Never falls back to normal termination.
 */
export async function crashPhysicalIosApp(
  context: PhysicalIosCrashContext,
): Promise<CrashAppResult> {
  const { appId, crasher, deviceId, signal, timer } = context;
  const base: Base = {
    platform: "ios",
    appId,
    mechanism: "ios_device_sigabrt",
    confirmed: false,
    supported: true,
  };
  const preflight = await crasher.findAppPid(appId);
  if (preflight === undefined || preflight === null) {
    return {
      ...base,
      success: false,
      timestamp: timer.now(),
      wasRunning: false,
      error:
        preflight === undefined
          ? `${appId} is not installed on physical iOS device ${deviceId}`
          : `${appId} is not running on physical iOS device ${deviceId}`,
    };
  }

  const attempt = { ...base, timestamp: timer.now(), wasRunning: true, processId: preflight };
  try {
    const outcome = await crasher.sendAbort(preflight, { signal });
    if (outcome === "already_exited") {
      return {
        ...attempt,
        success: false,
        error: `${appId} exited before the crash signal could be delivered`,
      };
    }
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(
      `[CrashApp] physical iOS SIGABRT failed for ${appId}: ${errorMessage(error)}`,
      error,
    );
    return { ...attempt, success: false, error: errorMessage(error) };
  } finally {
    context.onDispatched();
  }

  if (!(await waitForExit(context, preflight))) {
    return {
      ...attempt,
      success: false,
      error: `SIGABRT was delivered to PID ${preflight}, but ${appId} is still running`,
    };
  }
  return {
    ...attempt,
    success: true,
    evidence: { source: "none", summary: NO_CRASH_REPORT_SUMMARY },
  };
}

async function waitForExit(context: PhysicalIosCrashContext, pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < EXIT_POLL_ATTEMPTS; attempt += 1) {
    context.signal?.throwIfAborted();
    if ((await currentPid(context, pid)) !== pid) {
      return true;
    }
    if (attempt + 1 < EXIT_POLL_ATTEMPTS) {
      await context.timer.sleep(EXIT_POLL_MS);
    }
  }
  return false;
}

async function currentPid(context: PhysicalIosCrashContext, pid: number) {
  try {
    return await context.crasher.findAppPid(context.appId);
  } catch (error) {
    context.signal?.throwIfAborted();
    logger.warn(`[CrashApp] physical iOS exit check failed for ${context.appId}`, error);
    // An unreadable process table cannot prove the exit, so keep treating the PID as live.
    return pid;
  }
}
