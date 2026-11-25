import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";
import type { SimCtl } from "./SimCtlClient";

/** Upper bound for the `simctl launch` that brings a running app back to the front. */
export const IOS_FOREGROUND_RESTORE_MAX_MS = 5_000;

/** Brings a running app back to the front of an iOS simulator. */
export interface IosForegroundRestorer {
  /** Resolves to a warning when the app could not be brought back; throws only on abort. */
  restore(
    appId: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<string | undefined>;
}

/**
 * `simctl launch` of a running app activates its existing process (no relaunch and no state
 * loss), the same way tapping its icon does.
 */
export class SimctlIosForegroundRestorer implements IosForegroundRestorer {
  constructor(
    private readonly deviceId: string,
    private readonly simctl: Pick<SimCtl, "executeCommandArgs">,
  ) {}

  async restore(
    appId: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<string | undefined> {
    if (options.timeoutMs <= 0) {
      const warning = `${appId} was left in the background: no time remained to bring it back to the front; call launchApp to return to it`;
      logger.warn(`[IosForegroundRestore] ${warning}`);
      return warning;
    }
    try {
      await this.simctl.executeCommandArgs(
        ["launch", this.deviceId, appId],
        options.timeoutMs,
        options.signal,
      );
      logger.info(`[IosForegroundRestore] brought ${appId} back to the front`);
      return undefined;
    } catch (error) {
      options.signal?.throwIfAborted();
      logger.warn(
        `[IosForegroundRestore] could not bring ${appId} back: ${errorMessage(error)}`,
        error,
      );
      return `${appId} was left in the background: bringing it back to the front failed (${errorMessage(error)}); call launchApp to return to it`;
    }
  }
}
