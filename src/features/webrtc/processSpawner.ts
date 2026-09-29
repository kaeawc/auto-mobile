import type { Readable } from "node:stream";
import {
  DefaultHostCommandExecutor,
  type HostProcessExecutor,
} from "../../utils/HostCommandExecutor";

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

export type ProcessSpawner<T = SpawnedProcess> = (command: string, args: string[]) => T;

const hostProcessExecutor = new DefaultHostCommandExecutor();

export const createDefaultProcessSpawner =
  (executor: Pick<HostProcessExecutor, "spawn"> = hostProcessExecutor): ProcessSpawner =>
  (command, args) => {
    const child = executor.spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    // eslint-disable-next-line auto-mobile/no-unknown-cast -- node's ChildProcessByStdio differs from our minimal SpawnedProcess on stdin/once() variance; the members we use (stdout/stderr/kill/once) match.
    return child as unknown as SpawnedProcess;
  };

export const defaultProcessSpawner = createDefaultProcessSpawner();
