import {
  isProcessRunning as isDaemonProcessRunning,
  readProcessGenerationTokenForPid,
} from "../../daemon/daemonFiles";
import type { DaemonProcessSignaler } from "../../daemon/processTable";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { VideoCaptureTeardownDescriptor } from "./VideoRecorderService";

export type HostRecorderTeardownDescriptor = Extract<
  VideoCaptureTeardownDescriptor,
  { kind: "ios-host-recorder" }
>;

export interface HostRecorderProcessControl extends DaemonProcessSignaler {
  readStartToken(pid: number): string | undefined;
  isRunning(pid: number): boolean;
  signal(pid: number, sig: "SIGINT" | "SIGKILL"): void;
}

export const defaultHostRecorderProcessControl: HostRecorderProcessControl = {
  readStartToken: readProcessGenerationTokenForPid,
  isRunning: (pid) => isDaemonProcessRunning(pid, { debugLog: logger.debug }),
  signal: (pid, sig) => {
    process.kill(pid, sig);
  },
};

export const HOST_RECORDER_INTERRUPT_TIMEOUT_MS = 10_000;
export const HOST_RECORDER_KILL_TIMEOUT_MS = 1_000;
export const HOST_RECORDER_POLL_MS = 100;

/** Never signal a bare PID or touch the raw capture; SIGINT finalizes its MOV. */
export async function forceStopHostRecorder(
  descriptor: HostRecorderTeardownDescriptor,
  deps: { control: HostRecorderProcessControl; timer: Timer } = {
    control: defaultHostRecorderProcessControl,
    timer: defaultTimer,
  },
): Promise<void> {
  const { control, timer } = deps;
  const pid = descriptor.hostPid;
  const ownsRunningProcess = (): boolean => {
    if (!control.isRunning(pid)) {
      return false;
    }
    const token = control.readStartToken(pid);
    if (token === undefined) {
      // The process can exit between the liveness probe and the token read.
      if (!control.isRunning(pid)) {
        return false;
      }
      throw new ActionableError(
        `Cannot prove orphan host recorder identity for pid ${pid}; retry teardown when its start token can be read.`,
      );
    }
    return token === descriptor.hostStartToken;
  };
  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    for (let elapsed = 0; elapsed < timeoutMs; elapsed += HOST_RECORDER_POLL_MS) {
      if (!control.isRunning(pid)) {
        return true;
      }
      await timer.sleep(HOST_RECORDER_POLL_MS);
    }
    return !control.isRunning(pid);
  };
  try {
    if (!ownsRunningProcess()) {
      return;
    }
    control.signal(pid, "SIGINT");
    if (await waitForExit(HOST_RECORDER_INTERRUPT_TIMEOUT_MS)) {
      return;
    }
    if (!ownsRunningProcess()) {
      return;
    }
    control.signal(pid, "SIGKILL");
    if (await waitForExit(HOST_RECORDER_KILL_TIMEOUT_MS)) {
      return;
    }
    // A recycled PID also proves the recorded process exited; never signal it.
    if (!ownsRunningProcess()) {
      return;
    }
    throw new ActionableError(
      `Cannot confirm orphan host recorder pid ${pid} stopped; retry teardown before starting another recording.`,
    );
  } catch (error) {
    logger.warn(`[HostRecorderTeardown] Teardown unconfirmed for pid ${pid}`, error);
    throw toActionableError(error, `Failed to stop orphan host recorder pid ${pid}`);
  }
}
