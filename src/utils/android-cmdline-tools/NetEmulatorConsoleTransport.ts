import * as net from "node:net";
import { ActionableError } from "../../models";
import { Timer, defaultTimer } from "../SystemTimer";
import type { EmulatorConsoleTransport } from "./EmulatorConsoleClient";

export class NetEmulatorConsoleTransport implements EmulatorConsoleTransport {
  constructor(
    private readonly connect: (port: number, host: string) => net.Socket = net.connect,
    private readonly timeoutMs: number = 5000,
    private readonly timer: Timer = defaultTimer,
  ) {}

  execute(
    host: string,
    port: number,
    authToken: string | null,
    commands: string[],
    signal?: AbortSignal,
    timeoutMs: number = this.timeoutMs,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      let settled = false;
      let buffer = "";

      const socket = this.connect(port, host);
      socket.setEncoding("utf-8");

      const finish = (err: Error | null, output?: string) => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        this.timer.clearTimeout(timeoutHandle);
        socket.removeAllListeners();
        socket.destroy();
        if (err) {
          reject(err);
        } else {
          resolve(output ?? buffer);
        }
      };

      const timeoutHandle = this.timer.setTimeout(
        () =>
          finish(
            new ActionableError(
              `Emulator console connection to ${host}:${port} timed out after ${timeoutMs}ms`,
            ),
          ),
        timeoutMs,
      );
      const onAbort = () => finish(new ActionableError("Emulator console command cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }

      socket.on("error", (err) => {
        this.timer.clearTimeout(timeoutHandle);
        finish(
          new ActionableError(
            `Emulator console connection to ${host}:${port} failed: ${err.message}`,
          ),
        );
      });
      socket.on("close", () => {
        this.timer.clearTimeout(timeoutHandle);
        finish(null, buffer);
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
      });
      socket.on("connect", () => {
        const lines: string[] = [];
        if (authToken !== null) {
          lines.push(`auth ${authToken}`);
        }
        lines.push(...commands);
        lines.push("quit");
        socket.write(`${lines.join("\n")}\n`);
      });
    });
  }
}
