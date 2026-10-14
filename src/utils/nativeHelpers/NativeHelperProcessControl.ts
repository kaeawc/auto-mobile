import { readProcessGenerationTokenForPid } from "../../daemon/daemonFiles";
import { logger } from "../logger";
import { isProcessRunning } from "../processLiveness";

export interface NativeHelperProcessControl {
  isRunning(pid: number): boolean;
  readStartIdentity(pid: number): string | undefined;
  signal(pid: number, signal: NodeJS.Signals, options: { group: boolean }): void;
}

export class DefaultNativeHelperProcessControl implements NativeHelperProcessControl {
  isRunning(pid: number): boolean {
    return isProcessRunning(pid);
  }
  readStartIdentity(pid: number): string | undefined {
    return readProcessGenerationTokenForPid(pid);
  }
  signal(pid: number, signal: NodeJS.Signals, options: { group: boolean }): void {
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
      return;
    }
    try {
      process.kill(options.group ? -pid : pid, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
        throw error;
      }
      // A helper can exit between its identity check and the signal; disappearance is success.
      logger.debug(`[NATIVE_HELPERS] Helper ${pid} exited before ${signal}`);
    }
  }
}
