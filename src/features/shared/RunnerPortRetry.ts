import { logger } from "../../utils/logger";

/** Ports a simulator runner lifecycle allocates, releases and keeps out of the next allocations. */
export interface RunnerPorts {
  allocate(deviceId: string): number;
  release(deviceId: string, port: number): void;
  /** Keep a port another process's runner answered on out of the next allocations. */
  quarantine?(port: number): void;
}

/** Ports tried per start before reporting the runner unavailable. */
export const MAX_RUNNER_PORT_ATTEMPTS = 3;

/** The client reached a runner for another platform, so another process holds the port. */
export function isForeignRunnerError(error: unknown): boolean {
  return (
    error instanceof Error && "errorCode" in error && error.errorCode === "invalid_runner_platform"
  );
}

/**
 * Another daemon on this host can allocate a port and bind its runner only after this process's
 * bind probe found the port free, so the client then reaches that foreign runner (#18912). The
 * client refuses it by platform; quarantine the port and launch again on the next free one, up to
 * MAX_RUNNER_PORT_ATTEMPTS. The last refused port is quarantined too, so the next start does not
 * try it again; it stays allocated (via `setPort`) for the caller's cleanup to release.
 */
export async function launchOnFreeRunnerPort<T>(options: {
  deviceId: string;
  ports: RunnerPorts;
  signal: AbortSignal;
  /** Records the port in use, or undefined once released, for the caller's cleanup. */
  setPort(port: number | undefined): void;
  /** False once the start was superseded, so a refused port is not retried. */
  isCurrent(): boolean;
  launch(port: number): Promise<T>;
  /** Log prefix, e.g. `[TvosRunner]`. */
  logTag: string;
}): Promise<T> {
  const { deviceId, ports, signal } = options;
  for (let attempt = 1; ; attempt++) {
    const port = ports.allocate(deviceId);
    options.setPort(port);
    try {
      return await options.launch(port);
    } catch (error) {
      if (!isForeignRunnerError(error)) {
        throw error;
      }
      ports.quarantine?.(port);
      if (attempt >= MAX_RUNNER_PORT_ATTEMPTS || signal.aborted || !options.isCurrent()) {
        throw error;
      }
      logger.warn(
        `${options.logTag} Port ${port} for ${deviceId} is held by another runner; retrying on another port`,
        error,
      );
      ports.release(deviceId, port);
      options.setPort(undefined);
    }
  }
}
