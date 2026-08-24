import { execFile, spawn, type ChildProcess, type SpawnOptions } from "child_process";
import { promisify } from "util";
import type { ExecResult } from "../models";
import { wrapCommandError } from "./CommandError";
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

  /**
   * Starts a short-lived command while exposing its child for callers that own
   * cancellation and process tracking. The result still flows through the
   * canonical exec seam.
   */
  executeCommandWithChild(
    file: string,
    args?: string[],
    options?: HostCommandOptions
  ): StartedHostCommand;
}

export interface StartedHostCommand {
  child: ChildProcess;
  result: Promise<ExecResult>;
}

export type ExecFileAsync = (
  file: string,
  args: string[],
  options?: ExecSeamOptions
) => Promise<RawExecOutput>;

export type ExecFileWithChild = (
  file: string,
  args: string[],
  options: ExecSeamOptions | undefined,
  callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void
) => ChildProcess;

/** Shared callback-style `execFile` leaf for callers that need its child handle. */
export const execFileWithChild: ExecFileWithChild = (file, args, options, callback) =>
  execFile(file, args, options, callback);

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
  private execWithChild: ExecFileWithChild;

  constructor(
    execAsyncFn: ExecFileAsync = execFileAsync,
    execWithChildFn: ExecFileWithChild = execFileWithChild
  ) {
    this.execAsync = execAsyncFn;
    this.execWithChild = execWithChildFn;
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

  executeCommandWithChild(
    file: string,
    args: string[] = [],
    options: HostCommandOptions = {}
  ): StartedHostCommand {
    let child: ChildProcess | undefined;
    let startupError: unknown;
    const result = runExecSeam(
      execOptions => new Promise<RawExecOutput>((resolve, reject) => {
        try {
          child = this.execWithChild(file, args, execOptions, (error, stdout, stderr) => {
            if (error) {
              Object.assign(error, { stdout, stderr });
              reject(error);
              return;
            }
            resolve({ stdout, stderr });
          });
        } catch (error) {
          startupError = error;
          reject(error);
        }
      }),
      options,
      { command: file, args, cwd: options.cwd }
    );

    if (!child) {
      // The callback-style exec API may throw before returning a child (for
      // example, when argv contains a NUL). The promise has already captured
      // that failure for the shared seam; consume its wrapped rejection before
      // surfacing the same actionable error synchronously to the caller.
      void result.catch(() => undefined);
      throw wrapCommandError(
        startupError ?? new Error(`Failed to start command: ${file}`),
        { command: file, args, cwd: options.cwd }
      );
    }
    return { child, result };
  }
}
