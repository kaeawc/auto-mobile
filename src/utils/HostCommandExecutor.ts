import { execFile, spawn, type ChildProcess, type SpawnOptions } from "child_process";
import { promisify } from "util";
import type { ExecResult } from "../models";
import { runExecSeam, type ExecRequestOptions, type ExecSeamOptions, type RawExecOutput } from "./ExecSeam";

export type HostCommandOptions = ExecRequestOptions;

export interface HostCommandExecutor {
  executeCommand(
    file: string,
    args?: string[],
    options?: HostCommandOptions
  ): Promise<ExecResult>;

}

/**
 * Host command execution plus long-lived process startup. Keep this separate
 * from the short-lived command seam so existing one-shot fakes stay minimal.
 */
export interface HostProcessExecutor extends HostCommandExecutor {
  spawn(file: string, args: string[], options?: SpawnOptions): ChildProcess;
}

export type ExecFileAsync = (
  file: string,
  args: string[],
  options?: ExecSeamOptions
) => Promise<RawExecOutput>;

/**
 * Shared `execFile` leaf for the host-command seam. Exported so argv-first
 * clients (e.g. `SimCtlClient`) can run their exec leg through {@link runExecSeam}
 * without importing `child_process` themselves (issue #5459).
 */
export const execFileAsync: ExecFileAsync = async (
  file: string,
  args: string[],
  options?: ExecSeamOptions
): Promise<RawExecOutput> => {
  return promisify(execFile)(file, args, options);
};

export class DefaultHostCommandExecutor implements HostProcessExecutor {
  private execAsync: ExecFileAsync;

  constructor(execAsyncFn: ExecFileAsync = execFileAsync) {
    this.execAsync = execAsyncFn;
  }

  async executeCommand(
    file: string,
    args: string[] = [],
    options: HostCommandOptions = {}
  ): Promise<ExecResult> {
    return runExecSeam(
      execOptions => this.execAsync(file, args, execOptions),
      options,
      { command: file, args, cwd: options.cwd }
    );
  }

  spawn(file: string, args: string[], options: SpawnOptions = {}): ChildProcess {
    return spawn(file, args, options);
  }
}
