import type { ExecResult } from "../models";
import { wrapCommandError, type CommandErrorFormatOptions } from "./CommandError";
import { createExecResult } from "./execResult";

/**
 * Node exec option names as passed to the underlying `execFile`/`promisify`
 * seam. Shared by argv-first host-command owners so the mapping lives in one
 * place.
 */
export interface ExecSeamOptions {
  timeout?: number;
  maxBuffer?: number;
  cwd?: string;
  signal?: AbortSignal;
}

/** Raw stdout/stderr an exec seam resolves with, before Buffer coercion. */
export interface RawExecOutput {
  stdout: string | Buffer;
  stderr: string | Buffer;
}

/**
 * Public exec-request options as callers pass them, before mapping to node's
 * exec option names (`timeoutMs` → `timeout`).
 */
export interface ExecRequestOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  cwd?: string;
  signal?: AbortSignal;
}

/** Behavior toggles for {@link runExecSeam} that do not map to node exec options. */
export interface ExecSeamBehavior {
  /**
   * When true, a thrown exec error propagates unchanged instead of being run
   * through {@link wrapCommandError}. `wrapCommandError` returns a fresh `Error`
   * that copies only `.name`, dropping the raw `.code`/`.stderr`; SimCtlClient's
   * CoreSimulator-405 boot recovery (issue #3938 / #4092) reads exactly those
   * fields, so that client opts into raw-error propagation while still sharing
   * the seam's option mapping and {@link createExecResult} coercion.
   */
  preserveError?: boolean;
}

/**
 * Shared exec runner: maps request options to node exec option names, invokes
 * the executor's exec seam (shell string vs. file+argv, supplied by the
 * `invoke` closure), coerces the raw output via the canonical
 * {@link createExecResult} factory, and wraps any thrown error with actionable
 * command context. This is the single place the two executors share the option
 * mapping and the `wrapCommandError` catch path.
 */
export async function runExecSeam(
  invoke: (options: ExecSeamOptions) => Promise<RawExecOutput>,
  options: ExecRequestOptions,
  errorContext: CommandErrorFormatOptions,
  behavior: ExecSeamBehavior = {},
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await invoke({
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      cwd: options.cwd,
      signal: options.signal,
    });
    return createExecResult(stdout, stderr);
  } catch (error) {
    if (behavior.preserveError) {
      throw error;
    }
    throw wrapCommandError(error, errorContext);
  }
}
