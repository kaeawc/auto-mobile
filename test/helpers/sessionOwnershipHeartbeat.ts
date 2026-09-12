import { SingleFlightInterval } from "../../src/daemon/SingleFlightInterval";
import { defaultTimer, type Timer } from "../../src/utils/SystemTimer";

const DEFAULT_STOP_TIMEOUT_MS = 5_000;

export interface SessionOwnershipHeartbeat {
  assertHealthy(): void;
  stop(): Promise<Error | null>;
}

export interface SessionOwnershipHeartbeatOptions {
  intervalMs: number;
  renew(signal: AbortSignal): Promise<void>;
  timer?: Timer;
  stopTimeoutMs?: number;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Keeps a session held by a sequence of one-shot CLI clients alive. Each CLI
 * process tears down its proxy heartbeat on exit, so long integration setup and
 * recording work must renew through the daemon's public heartbeat command.
 */
export async function startSessionOwnershipHeartbeat(
  options: SessionOwnershipHeartbeatOptions,
): Promise<SessionOwnershipHeartbeat> {
  const timer = options.timer ?? defaultTimer;
  let stopped = false;
  let failure: Error | null = null;
  let activeAbortController: AbortController | null = null;

  const heartbeat = new SingleFlightInterval(
    timer,
    options.intervalMs,
    async () => {
      if (stopped) {
        return;
      }
      const controller = new AbortController();
      activeAbortController = controller;
      try {
        await options.renew(controller.signal);
      } catch (error) {
        if (!stopped && !controller.signal.aborted) {
          failure ??= asError(error);
        }
        throw error;
      } finally {
        if (activeAbortController === controller) {
          activeAbortController = null;
        }
      }
    },
    {
      stopTimeoutMs: options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
      onError: () => {},
    },
  );

  try {
    await heartbeat.run();
  } catch (error) {
    await heartbeat.stop();
    throw asError(error);
  }
  heartbeat.start();

  return {
    assertHealthy(): void {
      if (failure) {
        throw new Error(`session ownership heartbeat failed: ${failure.message}`, {
          cause: failure,
        });
      }
    },
    async stop(): Promise<Error | null> {
      stopped = true;
      activeAbortController?.abort();
      const settled = await heartbeat.stop();
      return settled
        ? null
        : new Error("session ownership heartbeat did not settle before cleanup timeout");
    },
  };
}
