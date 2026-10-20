export { DefaultNetworkFilterCommandRunner } from "./DefaultNetworkFilterCommandRunner";
export { NodeNetworkFilterFileSystem } from "./NodeNetworkFilterFileSystem";

/**
 * Host seams for the opt-in Network Extension installer (#10588). Every
 * host-mutating or process-spawning step goes through one of these narrow
 * interfaces so unit tests run against in-memory fakes and never touch
 * `/Applications`, `codesign`, `ditto` or the controller.
 */

/** Outcome of one argv-only command. Never throws for a non-zero exit. */
export interface NetworkFilterCommandOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the command was killed by the timeout. */
  timedOut: boolean;
}

export interface NetworkFilterCommandRunner {
  run(
    file: string,
    args: readonly string[],
    options?: { timeoutMs?: number },
  ): Promise<NetworkFilterCommandOutcome>;
}

/** The filesystem operations the provider and status inspector need. */
export interface NetworkFilterFileSystem {
  isDirectory(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
  /** File contents, or null when the file is missing or unreadable. */
  readText(path: string): Promise<string | null>;
  writeText(path: string, content: string): Promise<void>;
  ensureDir(path: string): Promise<void>;
  /** Recursive, forced removal; a missing path is not an error. */
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}
