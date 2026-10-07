import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostCommandExecutor } from "../HostCommandExecutor";
import { errorMessage } from "../describeUnknownError";
import type { Logger } from "../logger";
import type { Timer } from "../SystemTimer";
import { raceWithDeadline } from "../raceWithDeadline";
import type {
  DevicectlCommandInvoker,
  DevicectlCommandResult,
  DevicectlVersionSource,
} from "./CoreDeviceCapabilityProbe";
import { classifyDevicectlInvocationError } from "./DevicectlDeviceLister";
import { asRecord, parseDevicectlFailureEnvelope } from "./devicectlFailureEnvelope";

/** Same temp-file mechanism as DeviceAppManager/lister; no shared JSON-file helper exists. */
export interface DevicectlProbeFiles {
  tmpdir(): string;
  mkdtemp(prefix: string): Promise<string>;
  readFile(path: string): Promise<string>;
  rm(path: string): Promise<void>;
}

export const defaultDevicectlProbeFiles: DevicectlProbeFiles = {
  tmpdir,
  mkdtemp: (prefix) => fs.mkdtemp(prefix),
  readFile: (path) => fs.readFile(path, "utf8"),
  rm: (path) => fs.rm(path, { recursive: true, force: true }),
};

interface InvokerOptions {
  executor: HostCommandExecutor;
  files: DevicectlProbeFiles;
  timer: Timer;
  logger: Pick<Logger, "warn" | "debug">;
  timeoutMs: number;
}

/** Used only by the boot-first capability probe, never by diagnostic reads. */
export class ProductionDevicectlCommandInvoker
  implements DevicectlCommandInvoker, DevicectlVersionSource
{
  constructor(private readonly options: InvokerOptions) {}

  private execute(args: string[]) {
    const controller = new AbortController();
    return raceWithDeadline(
      () =>
        this.options.executor.executeCommand("xcrun", args, {
          timeoutMs: this.options.timeoutMs,
          signal: controller.signal,
          killSignal: "SIGKILL",
        }),
      {
        timer: this.options.timer,
        timeoutMs: this.options.timeoutMs,
        label: "devicectl probe",
        timeoutError: () =>
          Object.assign(new Error("devicectl probe timed out"), { code: "ETIMEDOUT" }),
        onTimeout: () => controller.abort(),
      },
    );
  }

  async getDevicectlVersion(): Promise<string> {
    return (await this.execute(["devicectl", "--version"])).stdout;
  }

  async invoke(deviceId: string, command: string): Promise<DevicectlCommandResult> {
    let directory: string | undefined;
    let execFailure: unknown;
    try {
      const args = this.commandArgs(deviceId, command);
      directory = await this.options.files.mkdtemp(
        join(this.options.files.tmpdir(), "automobile-coredevice-"),
      );
      const outputPath = join(directory, "result.json");
      execFailure = await this.executeForOutput([
        "devicectl",
        "device",
        ...args,
        "--device",
        deviceId,
        "--json-output",
        outputPath,
        "--quiet",
      ]);
      const text = await this.options.files.readFile(outputPath);
      const data: unknown = JSON.parse(text);
      const result = this.classifyOutput(data, execFailure);
      return result.kind === "ok" ? { kind: "ok", output: text } : result;
    } catch (error) {
      // A missing or malformed output file must not hide the command's own failure.
      const failure = execFailure ?? error;
      const cause = asRecord(asRecord(failure)?.cause ?? failure);
      const stderr = cause?.stderr;
      const message =
        (Buffer.isBuffer(stderr)
          ? stderr.toString()
          : typeof stderr === "string"
            ? stderr
            : ""
        ).trim() || errorMessage(failure);
      this.options.logger.warn(`CoreDevice command probe failed: ${message}`, failure);
      return { kind: "failed", message };
    } finally {
      if (directory) {
        await this.cleanup(directory);
      }
    }
  }

  private commandArgs(deviceId: string, command: string): string[] {
    const args = command.trim().split(/\s+/);
    // This is argv, never shell text. Device/output ownership cannot be overridden.
    if (
      !deviceId ||
      deviceId.startsWith("-") ||
      args.some((arg) => !arg || ["--device", "--json-output"].includes(arg))
    ) {
      throw new Error("Provide a device ID and devicectl command without device/output overrides");
    }
    return args;
  }

  private async executeForOutput(args: string[]): Promise<unknown> {
    try {
      const result = await this.execute(args);
      return result.error ? new Error(result.error) : undefined;
    } catch (error) {
      if (classifyDevicectlInvocationError(error) !== "failed") {
        throw error;
      }
      // Nonzero exits are expected for 1001; the file is authoritative for classification.
      this.options.logger.debug(`devicectl probe exit: ${errorMessage(error)}`);
      return error;
    }
  }

  private classifyOutput(data: unknown, execFailure: unknown): DevicectlCommandResult {
    const failure = parseDevicectlFailureEnvelope(data);
    if (failure?.code === 1001 && failure.kind === "capability-unsupported") {
      return {
        kind: "unsupported",
        ...(failure.capabilityFeatureId
          ? { capabilityFeatureId: failure.capabilityFeatureId }
          : {}),
      };
    }
    if (execFailure) {
      throw execFailure;
    }
    if (failure) {
      throw new Error(
        `devicectl failed: ${failure.domain ?? "unknown domain"} code ${failure.code}`,
      );
    }
    if (asRecord(asRecord(data)?.info)?.outcome !== "success") {
      throw new Error("devicectl output did not report success");
    }
    return { kind: "ok" };
  }

  private async cleanup(directory: string): Promise<void> {
    try {
      await this.options.files.rm(directory);
    } catch (error) {
      this.options.logger.warn(`CoreDevice probe cleanup failed: ${errorMessage(error)}`, error);
    }
  }
}
