import { createInterface } from "node:readline";
import { ActionableError, toActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../describeUnknownError";
import { DefaultHostCommandExecutor, type HostProcessExecutor } from "../../HostCommandExecutor";
import { logger } from "../../logger";
import { defaultTimer, type Timer } from "../../SystemTimer";
import { parseSimHidStartupLine } from "./SimHidProtocol";

/** Line-framed duplex channel to one helper process. */
export interface SimHidTransport {
  send(line: string): void;
  onLine(listener: (line: string) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export interface SimHidProcessHandle {
  readonly transport: SimHidTransport;
  kill(): void;
}

export interface SimHidProcessLauncher {
  /** Resolves once the helper printed `ready`; rejects when it failed to open the device. */
  launch(request: {
    helperPath: string;
    deviceId: string;
    env: NodeJS.ProcessEnv;
  }): Promise<SimHidProcessHandle>;
}

/** Cold start measured 0.2–1.4 s on a loaded host (#19019); allow headroom. */
export const SIM_HID_STARTUP_TIMEOUT_MS = 10_000;

/** Owns only the exact child handle it spawned, never a process-name lookup. */
export class DefaultSimHidProcessLauncher implements SimHidProcessLauncher {
  constructor(
    private readonly processes: Pick<
      HostProcessExecutor,
      "spawn"
    > = new DefaultHostCommandExecutor(),
    private readonly timer: Pick<Timer, "setTimeout" | "clearTimeout"> = defaultTimer,
    private readonly startupTimeoutMs: number = SIM_HID_STARTUP_TIMEOUT_MS,
  ) {}

  async launch({
    helperPath,
    deviceId,
    env,
  }: {
    helperPath: string;
    deviceId: string;
    env: NodeJS.ProcessEnv;
  }): Promise<SimHidProcessHandle> {
    const child = this.processes.spawn(helperPath, [deviceId], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    const kill = (): void => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    };
    try {
      if (!child.stdin || !child.stdout) {
        throw new ActionableError("sim-hid-helper did not provide stdio pipes");
      }
      const input = child.stdin;
      const lines = createInterface({ input: child.stdout });
      const lineListeners = new Set<(line: string) => void>();
      const closeListeners = new Set<() => void>();
      let closed = false;
      const notifyClose = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        lines.close();
        for (const listener of closeListeners) {
          listener();
        }
      };
      child.once("exit", notifyClose);
      child.on("error", (error) => {
        logger.warn("sim-hid-helper child process failed", error);
        notifyClose();
      });
      input.on("error", (error) => {
        logger.warn("sim-hid-helper input pipe failed", error);
        notifyClose();
      });
      // Drain diagnostics so a full stderr pipe cannot block the helper.
      child.stderr?.resume();
      await this.awaitReady(lines, closeListeners, () => closed);
      lines.on("line", (line) => {
        for (const listener of lineListeners) {
          listener(line);
        }
      });
      return {
        kill,
        transport: {
          send: (line) => {
            if (closed) {
              throw new ActionableError("sim-hid-helper has exited");
            }
            input.write(`${line}\n`);
          },
          onLine: (listener) => {
            lineListeners.add(listener);
          },
          onClose: (listener) => {
            closeListeners.add(listener);
            if (closed) {
              listener();
            }
          },
          close: () => {
            input.end();
            notifyClose();
          },
        },
      };
    } catch (error) {
      kill();
      throw toActionableError(error, `Could not start sim-hid-helper for simulator ${deviceId}`);
    }
  }

  private awaitReady(
    lines: ReturnType<typeof createInterface>,
    closeListeners: Set<() => void>,
    isClosed: () => boolean,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.timer.clearTimeout(timeout);
        lines.removeListener("line", onLine);
        closeListeners.delete(onClose);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const onLine = (line: string): void => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          // Only the protocol's JSON lines decide startup; stray output is diagnostics.
          logger.debug(`sim-hid-helper ignored a non-JSON startup line: ${errorMessage(error)}`);
          return;
        }
        const startup = parseSimHidStartupLine(parsed);
        if (startup?.event === "ready") {
          finish();
        } else if (startup?.event === "error") {
          finish(
            new ActionableError(`sim-hid-helper ${startup.error.code}: ${startup.error.message}`),
          );
        }
      };
      const onClose = (): void =>
        finish(new ActionableError("sim-hid-helper exited before it was ready"));
      const timeout = this.timer.setTimeout(
        () =>
          finish(
            new ActionableError(`sim-hid-helper was not ready within ${this.startupTimeoutMs} ms`),
          ),
        this.startupTimeoutMs,
      );
      lines.on("line", onLine);
      closeListeners.add(onClose);
      if (isClosed()) {
        onClose();
      }
    });
  }
}
