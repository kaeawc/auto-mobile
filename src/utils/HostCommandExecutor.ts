import { execFile } from "child_process";
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

export type ExecFileAsync = (
  file: string,
  args: string[],
  options?: ExecSeamOptions
) => Promise<RawExecOutput>;

const execFileAsync: ExecFileAsync = async (
  file: string,
  args: string[],
  options?: ExecSeamOptions
): Promise<RawExecOutput> => {
  return promisify(execFile)(file, args, options);
};

export class DefaultHostCommandExecutor implements HostCommandExecutor {
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
}
