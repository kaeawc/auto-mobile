import { createInterface } from "node:readline";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { DefaultHostCommandExecutor, type HostProcessExecutor } from "../HostCommandExecutor";
import { logger } from "../logger";
import type { AXBridgeTransport } from "./AXBridgeClient";

export interface AXBridgeProcessHandle {
  readonly pid: number;
  readonly transport: AXBridgeTransport;
  kill(): void;
}

export interface AXBridgeProcessLauncher {
  launch(deviceId: string): Promise<AXBridgeProcessHandle>;
}

/** Owns only the exact child handle returned by the host executor, never a process-name lookup. */
export class DefaultAXBridgeProcessLauncher implements AXBridgeProcessLauncher {
  constructor(
    private readonly executable: string = "AXBridge",
    private readonly processes: Pick<
      HostProcessExecutor,
      "spawn"
    > = new DefaultHostCommandExecutor(),
  ) {}

  async launch(deviceId: string): Promise<AXBridgeProcessHandle> {
    try {
      const child = this.processes.spawn(this.executable, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, SIMULATOR_UDID: deviceId },
      });
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("spawn", resolve);
      });
      const pid = child.pid;
      if (pid === undefined || !child.stdin || !child.stdout) {
        child.kill("SIGKILL");
        throw new ActionableError(
          "AXBridge did not provide a PID and stdio pipes. Install AXBridge and retry.",
        );
      }
      const input = child.stdin;
      const lines = createInterface({ input: child.stdout });
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
        logger.warn("AXBridge child process failed", error);
        notifyClose();
      });
      input.on("error", (error) => {
        logger.warn("AXBridge input pipe failed", error);
        notifyClose();
      });
      // Drain diagnostics so a full stderr pipe cannot block the companion.
      child.stderr?.resume();
      return {
        pid,
        kill: () => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        },
        transport: {
          send: (line) => {
            if (closed) {
              throw new ActionableError(
                "AXBridge process has exited. Release and reacquire the session.",
              );
            }
            input.write(`${line}\n`);
          },
          onLine: (listener) => {
            lines.on("line", listener);
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
      throw toActionableError(
        error,
        `Could not launch ${this.executable}; install AXBridge on PATH or configure its executable path`,
      );
    }
  }
}
