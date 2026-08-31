import type { ExecResult } from "../../src/models";
import type { HostCommandExecutor } from "../../src/utils/HostCommandExecutor";

/** Bounds short-lived ADB queries so an unresponsive server cannot wedge an integration run. */
export const ADB_INTEGRATION_COMMAND_TIMEOUT_MS = 15_000;

/** Narrow ADB-query interface used by device-backed integration suites. */
export interface AdbIntegrationCommandRunner {
  run(args: string[], phase: string): Promise<ExecResult>;
}

/** Poll a device observable until it reaches its expected postcondition. */
export async function waitForAdbCondition(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs: number = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const matched = await predicate();
    if (Date.now() >= deadline) {
      throw new Error(`${message} within ${timeoutMs}ms`);
    }
    if (matched) {
      return;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`${message} within ${timeoutMs}ms`);
    }
    await Bun.sleep(Math.min(100, remainingMs));
  }
}

/**
 * Creates the bounded executor for short-lived ADB queries performed by an
 * integration suite. Streaming commands intentionally use their own lifecycle.
 */
export function createAdbIntegrationCommandRunner(
  commandExecutor: Pick<HostCommandExecutor, "executeCommand">,
): AdbIntegrationCommandRunner {
  return {
    async run(args: string[], phase: string): Promise<ExecResult> {
      try {
        return await commandExecutor.executeCommand("adb", args, {
          timeoutMs: ADB_INTEGRATION_COMMAND_TIMEOUT_MS,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `ADB ${phase} failed within ${ADB_INTEGRATION_COMMAND_TIMEOUT_MS}ms: adb ${args.join(" ")}\n${detail}`,
          { cause: error },
        );
      }
    },
  };
}
