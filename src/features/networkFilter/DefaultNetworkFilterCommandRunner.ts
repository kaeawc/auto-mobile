import { runExecSeam } from "../../utils/ExecSeam";
import { execFileAsync } from "../../utils/HostCommandExecutor";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import type { NetworkFilterCommandOutcome, NetworkFilterCommandRunner } from "./networkFilterHost";

/** Exit code reported when the executable itself could not be started. */
export const COMMAND_NOT_STARTED_EXIT_CODE = 127;

export class DefaultNetworkFilterCommandRunner implements NetworkFilterCommandRunner {
  async run(
    file: string,
    args: readonly string[],
    options: { timeoutMs?: number } = {},
  ): Promise<NetworkFilterCommandOutcome> {
    try {
      const result = await runExecSeam(
        (execOptions) => execFileAsync(file, [...args], execOptions),
        { timeoutMs: options.timeoutMs, maxBuffer: 16 * 1024 * 1024, killSignal: "SIGKILL" },
        { command: file, args: [...args] },
        { preserveError: true },
      );
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr, timedOut: false };
    } catch (error) {
      // Non-zero exits are structured outcomes here; callers map them to states.
      const failure = error as {
        code?: unknown;
        killed?: unknown;
        signal?: unknown;
        stdout?: unknown;
        stderr?: unknown;
      };
      logger.debug(`[NETWORK_FILTER] ${file} exited unsuccessfully: ${errorMessage(error)}`);
      return {
        exitCode: typeof failure.code === "number" ? failure.code : COMMAND_NOT_STARTED_EXIT_CODE,
        stdout: String(failure.stdout ?? ""),
        stderr: String(failure.stderr ?? (typeof failure.code === "string" ? failure.code : "")),
        timedOut: failure.killed === true && failure.signal === "SIGKILL",
      };
    }
  }
}
