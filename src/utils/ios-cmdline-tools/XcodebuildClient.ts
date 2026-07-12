import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ActionableError, ExecResult } from "../../models";
import { logger } from "../logger";
import { createExecResult } from "../execResult";
import { defaultTimer, Timer } from "../SystemTimer";

interface XcodebuildCommandOptions {
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface Xcodebuild {
  executeCommand(args: string[], options?: XcodebuildCommandOptions): Promise<ExecResult>;
  isAvailable(): Promise<boolean>;
}

const execAsync = async (file: string, args: string[], maxBuffer?: number): Promise<ExecResult> => {
  const options = maxBuffer ? { maxBuffer } : undefined;
  const result = await promisify(execFile)(file, args, options);
  const stdout = typeof result.stdout === "string" ? result.stdout : result.stdout.toString();
  const stderr = typeof result.stderr === "string" ? result.stderr : result.stderr.toString();
  return createExecResult(stdout, stderr);
};

export class XcodebuildClient implements Xcodebuild {
  execAsync: (file: string, args: string[], maxBuffer?: number) => Promise<ExecResult>;
  private timer: Timer;

  constructor(
    execAsyncFn: ((file: string, args: string[], maxBuffer?: number) => Promise<ExecResult>) | null = null,
    timer: Timer = defaultTimer
  ) {
    this.execAsync = execAsyncFn || execAsync;
    this.timer = timer;
  }

  async isAvailable(): Promise<boolean> {
    return this.isLocalXcodebuildAvailable();
  }

  async executeCommand(args: string[], options: XcodebuildCommandOptions = {}): Promise<ExecResult> {
    const { timeoutMs, maxBuffer } = options;
    const fullCommand = `xcodebuild ${args.join(" ")}`;
    const startTime = this.timer.now();

    logger.debug(`[iOS] Executing command: ${fullCommand}`);

    if (!(await this.isLocalXcodebuildAvailable())) {
      throw new ActionableError("xcodebuild is not available. Please install Xcode to continue.");
    }

    const runCommand = () => this.execAsync("xcodebuild", args, maxBuffer);

    if (timeoutMs) {
      let timeoutId: NodeJS.Timeout;
      const timeoutPromise = new Promise<ExecResult>((_, reject) => {
        timeoutId = this.timer.setTimeout(
          () => reject(new Error(`Command timed out after ${timeoutMs}ms: ${fullCommand}`)),
          timeoutMs
        );
      });

      try {
        const result = await Promise.race([runCommand(), timeoutPromise]);
        const duration = this.timer.now() - startTime;
        logger.debug(`[iOS] Command completed in ${duration}ms: ${fullCommand}`);
        return result;
      } catch (error) {
        const duration = this.timer.now() - startTime;
        logger.warn(`[iOS] Command failed after ${duration}ms: ${fullCommand} - ${(error as Error).message}`);
        throw error;
      } finally {
        clearTimeout(timeoutId!);
      }
    }

    try {
      const result = await runCommand();
      const duration = this.timer.now() - startTime;
      logger.debug(`[iOS] Command completed in ${duration}ms: ${fullCommand}`);
      return result;
    } catch (error) {
      const duration = this.timer.now() - startTime;
      logger.warn(`[iOS] Command failed after ${duration}ms: ${fullCommand} - ${(error as Error).message}`);
      throw error;
    }
  }

  private async isLocalXcodebuildAvailable(): Promise<boolean> {
    try {
      await this.execAsync("xcodebuild", ["-version"]);
      return true;
    } catch (error) {
      // `xcodebuild -version` fails when Xcode/command-line tools aren't installed; that just means it's unavailable.
      logger.debug(`src/utils/ios-cmdline-tools/XcodebuildClient.ts fallback failed: ${error}`, error);
      return false;
    }
  }
}
