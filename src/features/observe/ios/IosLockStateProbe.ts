import type { DeviceLockState } from "../../../models/DeviceLockState";
import type { ExecResult } from "../../../models";
import { SimCtlClient } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import {
  iosNotifyutilGetCommand,
  parseNotifyutilState,
} from "../../../utils/ios-cmdline-tools/notifyutil";
import { logger } from "../../../utils/logger";

const LOCK_STATE_KEY = "com.apple.springboard.lockstate";
const LOCK_STATE_TIMEOUT_MS = 2_000;

export interface IosLockStateProbe {
  read(deviceId: string, signal?: AbortSignal): Promise<DeviceLockState | undefined>;
}

export interface IosLockStateExecutor {
  executeCommand(command: string, timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>;
}

export class NotifyutilIosLockStateProbe implements IosLockStateProbe {
  constructor(private readonly executor: IosLockStateExecutor = new SimCtlClient()) {}

  async read(deviceId: string, signal?: AbortSignal): Promise<DeviceLockState | undefined> {
    try {
      const output = await this.executor.executeCommand(
        iosNotifyutilGetCommand(deviceId, LOCK_STATE_KEY),
        LOCK_STATE_TIMEOUT_MS,
        signal,
      );
      if (output.stderr?.trim()) {
        logger.warn(`[iOS] Lock-state probe failed: ${output.stderr.trim()}`);
        return undefined;
      }
      const lockLine = output.stdout
        .split("\n")
        .find((line) => line.trim().startsWith(`${LOCK_STATE_KEY} `));
      const state = parseNotifyutilState(lockLine ?? "");
      if (state === null) {
        logger.warn("[iOS] Lock-state probe returned unparseable output");
        return undefined;
      }
      return { locked: state, keyguardShowing: state };
    } catch (error) {
      logger.warn(`[iOS] Lock-state probe failed: ${error}`);
      return undefined;
    }
  }
}
