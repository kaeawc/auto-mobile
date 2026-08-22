import { errorMessage } from "../describeUnknownError";
import { spawn } from "node:child_process";
import { ActionableError } from "../../models";
import { defaultTimer, type Timer } from "../SystemTimer";
import { logger } from "../logger";

export interface PlistProcessRequest {
  args: string[];
  input?: Buffer;
  signal?: AbortSignal;
  maxOutputBytes: number;
}

export interface PlistProcessResult {
  stdout: Buffer;
  stderr: Buffer;
}

/** Narrow, injectable process seam for the sole production plutil boundary. */
export type PlistProcess = (request: PlistProcessRequest) => Promise<PlistProcessResult>;

export interface PlistReader {
  readJsonFile(path: string, options?: PlistReadOptions): Promise<unknown>;
  readJsonBytes(bytes: Buffer, options?: PlistReadOptions): Promise<unknown>;
  readXmlFile(path: string, options?: PlistReadOptions): Promise<string>;
  readXmlBytes(bytes: Buffer, options?: PlistReadOptions): Promise<string>;
  extractRawFile(key: string, path: string, options?: PlistReadOptions): Promise<string>;
}

export interface PlistReadOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PlistClientOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  timer?: Timer;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const defaultProcess: PlistProcess = ({ args, input, signal, maxOutputBytes }) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(new Error("plutil execution was cancelled"));
    return;
  }
  const child = spawn("plutil", args, { stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let settled = false;

  const finish = (error?: Error): void => {
    if (settled) {return;}
    settled = true;
    signal?.removeEventListener("abort", onAbort);
    if (error) {reject(error);} else {resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });}
  };
  const onAbort = (): void => {
    child.kill("SIGTERM");
    finish(new Error("plutil execution was cancelled"));
  };
  const collect = (destination: Buffer[]) => (chunk: Buffer): void => {
    outputBytes += chunk.length;
    if (outputBytes > maxOutputBytes) {
      child.kill("SIGTERM");
      finish(new Error(`plutil output exceeded ${maxOutputBytes} bytes`));
      return;
    }
    destination.push(chunk);
  };

  signal?.addEventListener("abort", onAbort, { once: true });
  child.once("error", error => finish(error));
  child.stdout?.on("data", collect(stdout));
  child.stderr?.on("data", collect(stderr));
  child.once("close", code => {
    if (code === 0) {finish();} else {finish(new Error(`plutil exited with code ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`));}
  });
  child.stdin?.end(input);
});

/**
 * Typed owner for plist conversion and reads. All production code must use this
 * boundary instead of resolving or invoking `plutil` itself.
 */
export class PlistClient implements PlistReader {
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly timer: Timer;

  constructor(private readonly process: PlistProcess = defaultProcess, options: PlistClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.timer = options.timer ?? defaultTimer;
  }

  async readJsonFile(path: string, options?: PlistReadOptions): Promise<unknown> {
    return this.parseJson(await this.run(["-convert", "json", "-o", "-", "--", path], undefined, options));
  }

  async readJsonBytes(bytes: Buffer, options?: PlistReadOptions): Promise<unknown> {
    return this.parseJson(await this.run(["-convert", "json", "-o", "-", "--", "-"], bytes, options));
  }

  async readXmlFile(path: string, options?: PlistReadOptions): Promise<string> {
    return (await this.run(["-convert", "xml1", "-o", "-", "--", path], undefined, options)).toString("utf8");
  }

  async readXmlBytes(bytes: Buffer, options?: PlistReadOptions): Promise<string> {
    return (await this.run(["-convert", "xml1", "-o", "-", "--", "-"], bytes, options)).toString("utf8");
  }

  async extractRawFile(key: string, path: string, options?: PlistReadOptions): Promise<string> {
    return (await this.run(["-extract", key, "raw", "-o", "-", "--", path], undefined, options)).toString("utf8");
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.run(["-help"]);
      return true;
    } catch (error) {
      logger.debug(`src/utils/ios-cmdline-tools/PlistClient.ts availability check failed: ${error}`, error);
      return false;
    }
  }

  private async run(args: string[], input?: Buffer, options: PlistReadOptions = {}): Promise<Buffer> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (options.signal?.aborted) {controller.abort();} else {options.signal?.addEventListener("abort", onAbort, { once: true });}
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    let timeout: NodeJS.Timeout | undefined;
    const command = `plutil ${args.map(arg => JSON.stringify(arg)).join(" ")}`;
    const run = this.process({ args, input, signal: controller.signal, maxOutputBytes: this.maxOutputBytes });
    run.catch(() => {});
    const timeoutPromise = new Promise<PlistProcessResult>((_, reject) => {
      timeout = this.timer.setTimeout(() => {
        reject(new ActionableError(`plutil timed out after ${timeoutMs}ms: ${command}`));
        controller.abort();
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([run, timeoutPromise]);
      if (result.stdout.length > this.maxOutputBytes) {
        throw new ActionableError(`plutil output exceeded ${this.maxOutputBytes} bytes`);
      }
      return result.stdout;
    } catch (error) {
      if (error instanceof ActionableError) {throw error;}
      const detail = errorMessage(error);
      throw new ActionableError(`plutil failed (${command}): ${detail}`);
    } finally {
      if (timeout) {this.timer.clearTimeout(timeout);}
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  private parseJson(output: Buffer): unknown {
    try {
      return JSON.parse(output.toString("utf8"));
    } catch (error) {
      const detail = errorMessage(error);
      throw new ActionableError(`plutil produced malformed JSON: ${detail}`);
    }
  }
}
