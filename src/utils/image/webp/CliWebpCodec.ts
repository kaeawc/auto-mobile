import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { ActionableError } from "../../../models/ActionableError";
import { DefaultHostCommandExecutor, type HostProcessExecutor } from "../../HostCommandExecutor";
import { WebpBinaryResolver, type WebpBinaryProvider } from "./WebpBinaryResolver";

export interface CliWebpEncodeOptions {
  quality?: number;
  lossless?: boolean;
  nearLossless?: boolean;
}

export function isWebpBuffer(buffer: Buffer): boolean {
  return buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP";
}

export class CliWebpCodec {
  constructor(
    private readonly binaryResolver: WebpBinaryProvider = new WebpBinaryResolver(),
    private readonly processExecutor: HostProcessExecutor = new DefaultHostCommandExecutor()
  ) {}

  async encode(pngBuffer: Buffer, options: CliWebpEncodeOptions = {}): Promise<Buffer> {
    const cwebp = await this.binaryResolver.resolveCwebp();
    const args = [...buildCwebpOptionArgs(options), "-o", "-", "--", "-"];
    const output = await this.runCodecProcess("cwebp", cwebp, args, pngBuffer, "AUTOMOBILE_CWEBP_PATH");
    if (!isWebpBuffer(output)) {
      throw new ActionableError("cwebp did not produce a WebP RIFF buffer. Set AUTOMOBILE_CWEBP_PATH to a working cwebp binary.");
    }
    return output;
  }

  async decode(webpBuffer: Buffer): Promise<Buffer> {
    if (!isWebpBuffer(webpBuffer)) {
      throw new ActionableError("CliWebpCodec.decode expected a WebP RIFF buffer.");
    }

    const dwebp = await this.binaryResolver.resolveDwebp();
    return this.runCodecProcess("dwebp", dwebp, ["-o", "-", "--", "-"], webpBuffer, "AUTOMOBILE_DWEBP_PATH");
  }

  private async runCodecProcess(
    toolName: "cwebp" | "dwebp",
    command: string,
    args: string[],
    input: Buffer,
    envVar: string
  ): Promise<Buffer> {
    const child = this.processExecutor.spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new ActionableError(`${toolName} was spawned without piped stdio. Set ${envVar} to a working ${toolName} binary.`);
    }

    child.stdout.on("data", data => stdout.push(Buffer.isBuffer(data) ? data : Buffer.from(data)));
    child.stderr.on("data", data => stderr.push(Buffer.isBuffer(data) ? data : Buffer.from(data)));
    const completion = waitForCompletion(child, child.stdin, toolName, envVar, stderr);
    try {
      child.stdin.end(input);
    } catch (error) {
      throw actionableProcessError(toolName, envVar, `stdin write failed: ${errorMessage(error)}`);
    }

    await completion;
    return Buffer.concat(stdout);
  }
}

function buildCwebpOptionArgs(options: CliWebpEncodeOptions): string[] {
  const quality = options.quality ?? 75;
  if (options.nearLossless) {
    return ["-near_lossless", String(quality)];
  }
  if (options.lossless) {
    return ["-lossless", "-q", String(quality)];
  }
  if (options.quality !== undefined) {
    return ["-q", String(quality)];
  }
  return [];
}

async function waitForCompletion(
  child: ChildProcess,
  stdin: Writable,
  toolName: "cwebp" | "dwebp",
  envVar: string,
  stderr: Buffer[]
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("error", error => {
      reject(actionableProcessError(toolName, envVar, error.message));
    });
    stdin.once("error", error => {
      reject(actionableProcessError(toolName, envVar, `stdin write failed: ${errorMessage(error)}`));
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      const suffix = detail ? `: ${detail}` : "";
      reject(actionableProcessError(toolName, envVar, `exited with code ${code ?? "null"} signal ${signal ?? "null"}${suffix}`));
    });
  });
}

function actionableProcessError(toolName: "cwebp" | "dwebp", envVar: string, detail: string): ActionableError {
  return new ActionableError(`${toolName} failed (${detail}). Set ${envVar} to a working ${toolName} binary.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
