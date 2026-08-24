import { spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";

/** Minimal child-process surface the capture sources need, for injectable testing. */
export interface SpawnedProcess {
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  removeListener(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  removeListener(event: "error", listener: (error: Error) => void): void;
}

export type ProcessSpawner = (command: string, args: string[]) => SpawnedProcess;

export const defaultProcessSpawner: ProcessSpawner = (command, args) => {
  const child = nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  // eslint-disable-next-line auto-mobile/no-unknown-cast -- node's ChildProcessByStdio differs from our minimal SpawnedProcess on stdin/once() variance; the members we use (stdout/stderr/kill/once) match.
  return child as unknown as SpawnedProcess;
};
