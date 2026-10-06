import type { HostChildProcess } from "../utils/HostCommandExecutor";
import { ActionableError } from "./ActionableError";

/**
 * An Android emulator launch was cancelled (request abort, deadline, teardown
 * pre-emption). `process` is the emulator child when the cancel arrived after
 * the spawn: the one SIGTERM the client sends is only a request, so the owner
 * must take the handle to confirm the exit (SIGTERM -> bounded wait -> SIGKILL)
 * before releasing the AVD's lifecycle lease (#10075). `null` when nothing had
 * been spawned yet.
 */
export class EmulatorLaunchCancelledError extends ActionableError {
  constructor(
    readonly avdName: string,
    readonly process: HostChildProcess | null,
  ) {
    super(`Android emulator launch for '${avdName}' was cancelled`);
    this.name = "EmulatorLaunchCancelledError";
  }
}

export function isEmulatorLaunchCancelledError(
  error: unknown,
): error is EmulatorLaunchCancelledError {
  return error instanceof EmulatorLaunchCancelledError;
}
