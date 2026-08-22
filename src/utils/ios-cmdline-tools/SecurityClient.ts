import { errorMessage } from "../describeUnknownError";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ActionableError, type ExecResult } from "../../models";
import { createExecResult } from "../execResult";
import { logger } from "../logger";
import { defaultTimer, type Timer } from "../SystemTimer";

const SECURITY_COMMAND = "security";
const DEFAULT_TIMEOUT_MS = 5_000;

export interface SecurityIdentity {
  fingerprint: string;
  name: string;
}

export interface SecurityDiagnostics {
  available: boolean;
  /** macOS security does not provide a standalone version command. */
  version: null;
}

export interface SecurityCommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface SecurityExecutionOptions {
  signal?: AbortSignal;
  killSignal?: NodeJS.Signals;
}

export interface SecurityClientDependencies {
  platform: () => NodeJS.Platform;
  execute: (file: string, args: string[], options?: SecurityExecutionOptions) => Promise<ExecResult>;
  timer?: Timer;
}

export interface SecurityClientApi {
  getDiagnostics(options?: SecurityCommandOptions): Promise<SecurityDiagnostics>;
  listCodeSigningIdentities(options?: SecurityCommandOptions): Promise<SecurityIdentity[]>;
  decodeCms(path: string, options?: SecurityCommandOptions): Promise<string>;
}

const defaultExecute = async (
  file: string,
  args: string[],
  options: SecurityExecutionOptions = {}
): Promise<ExecResult> => {
  const result = await promisify(execFile)(file, args, { signal: options.signal, killSignal: options.killSignal ?? "SIGKILL" });
  const stdout = String(result.stdout);
  const stderr = String(result.stderr);
  return createExecResult(stdout, stderr);
};

const parseIdentities = (output: string): SecurityIdentity[] => output
  .split("\n")
  .flatMap(line => {
    const match = line.match(/^\s*\d+\)\s+([0-9A-F]{40,64})\s+"([^\"]+)"/i);
    return match ? [{ fingerprint: match[1].toUpperCase(), name: match[2] }] : [];
  });

const isKeychainError = (error: unknown): boolean => {
  const message = errorMessage(error);
  return /user interaction is not allowed|keychain|errsec/i.test(message);
};

/**
 * Sole production boundary for the macOS `security` executable.
 *
 * The API intentionally exposes only structured operations so callers cannot
 * interpolate profile paths into a shell command or accidentally log CMS data.
 */
export class SecurityClient implements SecurityClientApi {
  private readonly timer: Timer;

  constructor(private readonly dependencies: SecurityClientDependencies = {
    platform: () => process.platform,
    execute: defaultExecute
  }) {
    this.timer = dependencies.timer ?? defaultTimer;
  }

  public async getDiagnostics(options: SecurityCommandOptions = {}): Promise<SecurityDiagnostics> {
    if (this.dependencies.platform() !== "darwin") {
      return { available: false, version: null };
    }

    try {
      await this.run("availability probe", ["help"], options);
      return { available: true, version: null };
    } catch (error) {
      logger.debug(`[SecurityClient] Availability probe failed: ${error instanceof Error ? error.name : "unknown error"}`);
      return { available: false, version: null };
    }
  }

  public async listCodeSigningIdentities(options: SecurityCommandOptions = {}): Promise<SecurityIdentity[]> {
    this.requireDarwin();
    try {
      const result = await this.run("identity lookup", ["find-identity", "-v", "-p", "codesigning"], options);
      return parseIdentities(result.stdout);
    } catch (error) {
      throw this.toActionableError(error, "find code signing identities");
    }
  }

  public async decodeCms(path: string, options: SecurityCommandOptions = {}): Promise<string> {
    this.requireDarwin();
    try {
      const result = await this.run("CMS decoding", ["cms", "-D", "-i", path], options);
      return result.stdout;
    } catch (error) {
      throw this.toActionableError(error, "decode the provisioning profile");
    }
  }

  private requireDarwin(): void {
    if (this.dependencies.platform() !== "darwin") {
      throw new ActionableError("macOS security is only available on macOS.");
    }
  }

  private async run(
    operation: string,
    args: string[],
    options: SecurityCommandOptions = {}
  ): Promise<ExecResult> {
    if (options.signal?.aborted) {
      throw new ActionableError(`Security ${operation} was cancelled.`);
    }

    const controller = new AbortController();
    let rejectCancellation: ((error: ActionableError) => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const abort = () => {
      controller.abort();
      rejectCancellation?.(new ActionableError(`Security ${operation} was cancelled.`));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timeoutId: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = this.timer.setTimeout(() => {
        controller.abort();
        reject(new Error(`Security ${operation} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    });
    const execution = this.dependencies.execute(SECURITY_COMMAND, args, { signal: controller.signal, killSignal: "SIGKILL" });
    execution.catch(() => { /* handled by the race when aborting a child */ });

    try {
      return await Promise.race([execution, timeout, cancellation]);
    } finally {
      if (timeoutId) {
        this.timer.clearTimeout(timeoutId);
      }
      options.signal?.removeEventListener("abort", abort);
    }
  }

  private toActionableError(error: unknown, operation: string): ActionableError {
    if (error instanceof ActionableError) {
      return error;
    }
    if (error instanceof Error && error.message.startsWith("Security ")) {
      return new ActionableError(error.message);
    }
    if (isKeychainError(error)) {
      return new ActionableError(
        `Could not ${operation}: macOS keychain access was denied. Unlock the login keychain and retry.`
      );
    }
    return new ActionableError(
      `Could not ${operation}. Verify that the macOS security tool is available and the provisioning data is valid.`
    );
  }
}
