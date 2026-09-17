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
  killSignal?: NodeJS.Signals;
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
  killSignal?: NodeJS.Signals;
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
    // Only forward options the caller actually set. A property present with an
    // `undefined` value is NOT the same as an absent one at the exec leaf: node
    // and bun read `options.maxBuffer` directly, so `maxBuffer: undefined`
    // OVERWRITES the built-in 1 MiB stdout/stderr bound with "unbounded" rather
    // than falling back to the default. Callers that omit `maxBuffer` (e.g.
    // availability probes, emulator commands) must keep that default bound, so
    // undefined keys are dropped here in the one shared place.
    const execOptions: ExecSeamOptions = {};
    if (options.timeoutMs !== undefined) {
      execOptions.timeout = options.timeoutMs;
    }
    if (options.maxBuffer !== undefined) {
      execOptions.maxBuffer = options.maxBuffer;
    }
    if (options.cwd !== undefined) {
      execOptions.cwd = options.cwd;
    }
    if (options.signal !== undefined) {
      execOptions.signal = options.signal;
    }
    if (options.killSignal !== undefined) {
      execOptions.killSignal = options.killSignal;
    }
    const { stdout, stderr } = await invoke(execOptions);
    return createExecResult(stdout, stderr);
  } catch (error) {
    if (behavior.preserveError) {
      throw error;
    }
    throw wrapCommandError(error, errorContext);
  }
}
