import { SimctlCommandTimeoutError } from "../../../utils/ios-cmdline-tools/SimctlCommandTimeoutError";
import { errorMessage } from "../../../utils/describeUnknownError";
import type { DeviceLockState, DeviceLockUnknown } from "../../../models/DeviceLockState";
import type { ExecResult } from "../../../models";
import { SimCtlClient } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import {
  iosNotifyutilGetCommand,
  parseNotifyutilState,
} from "../../../utils/ios-cmdline-tools/notifyutil";
import { logger } from "../../../utils/logger";

const LOCK_STATE_KEY = "com.apple.springboard.lockstate";
const LOCK_STATE_TIMEOUT_MS = 2_000;

export type IosLockStateReading =
  | { kind: "known"; lock: DeviceLockState }
  | { kind: "unknown"; reason: "timeout" | "pending" | "error" | "unparseable"; message?: string };

export function lockStateOf(reading: IosLockStateReading): DeviceLockState | undefined {
  return reading.kind === "known" ? reading.lock : undefined;
}

export function applyIosLockStateReading(
  result: { deviceLock?: DeviceLockState; deviceLockUnknown?: DeviceLockUnknown },
  reading: IosLockStateReading,
): void {
  delete result.deviceLock;
  delete result.deviceLockUnknown;
  if (reading.kind === "known") {
    result.deviceLock = reading.lock;
  } else {
    result.deviceLockUnknown = {
      reason: reading.reason,
      ...(reading.message === undefined ? {} : { message: reading.message }),
    };
  }
}

/** Best-effort diagnostic: never rejects, including on caller abort. */
export interface IosLockStateProbe {
  read(deviceId: string, signal?: AbortSignal): Promise<IosLockStateReading>;
}

export interface IosLockStateExecutor {
  executeCommand(command: string, timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>;
}

export class NotifyutilIosLockStateProbe implements IosLockStateProbe {
  constructor(
    private readonly executor: IosLockStateExecutor = new SimCtlClient(),
    private readonly options: { timeoutMs?: number } = {},
  ) {}

  async read(deviceId: string, signal?: AbortSignal): Promise<IosLockStateReading> {
    try {
      const output = await this.executor.executeCommand(
        iosNotifyutilGetCommand(deviceId, LOCK_STATE_KEY),
        this.options.timeoutMs ?? LOCK_STATE_TIMEOUT_MS,
        signal,
      );
      if (output.stderr?.trim()) {
        logger.warn(`[iOS] Lock-state probe failed: ${output.stderr.trim()}`);
        return { kind: "unknown", reason: "error", message: output.stderr.trim() };
      }
      const lockLine = output.stdout
        .split("\n")
        .find((line) => line.trim().startsWith(`${LOCK_STATE_KEY} `));
      const state = parseNotifyutilState(lockLine ?? "");
      if (state === null) {
        logger.warn("[iOS] Lock-state probe returned unparseable output");
        return { kind: "unknown", reason: "unparseable" };
      }
      return { kind: "known", lock: { locked: state, keyguardShowing: state } };
    } catch (error) {
      logger.warn(`[iOS] Lock-state probe failed: ${errorMessage(error)}`, error);
      return {
        kind: "unknown",
        reason: error instanceof SimctlCommandTimeoutError ? "timeout" : "error",
        message: errorMessage(error),
      };
    }
  }
}
