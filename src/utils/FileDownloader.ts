import { errorMessage } from "./describeUnknownError";
import { createWriteStream } from "fs";
import * as fs from "fs/promises";
import http from "http";
import https from "https";
import * as path from "path";
import type { Readable } from "stream";
import { pipeline } from "stream/promises";
import { runExecSeam, type ExecSeamOptions } from "./ExecSeam";
import { execFileAsync as sharedExecFileAsync } from "./HostCommandExecutor";
import { logger } from "./logger";
import { getAbortSignal } from "./AbortContext";
import { toActionableError } from "../models/ActionableError";
import { type IdGenerator, defaultIdGenerator } from "./IdGenerator";

type DownloadExec = (file: string, args: string[], options: ExecSeamOptions) => Promise<void>;
type DownloadFileSystem = Pick<typeof fs, "mkdir" | "rename" | "rm">;

const defaultDownloadExec: DownloadExec = async (file, args, options) => {
  await runExecSeam(
    (execOptions) => sharedExecFileAsync(file, args, execOptions),
    { timeoutMs: options.timeout, maxBuffer: options.maxBuffer, signal: options.signal },
    { command: file, args },
    { preserveError: true },
  );
};

export interface FileDownloader {
  download(url: string, destination: string, signal?: AbortSignal): Promise<void>;
}

export class DefaultFileDownloader implements FileDownloader {
  private onFirstResponseByte?: () => void;

  constructor(
    private readonly idGenerator: IdGenerator = defaultIdGenerator,
    private readonly execute: DownloadExec = defaultDownloadExec,
    private readonly fileSystem: DownloadFileSystem = fs,
  ) {}

  public async download(url: string, destination: string, signal?: AbortSignal): Promise<void> {
    signal ??= getAbortSignal();
    if (signal?.aborted) {
      throw new Error(`Download aborted before starting: ${url}`);
    }
    await this.fileSystem.mkdir(path.dirname(destination), { recursive: true });
    const tempDestination = `${destination}.download-${this.idGenerator.next()}.tmp`;
    try {
      await this.downloadToTemp(url, tempDestination, signal);
      await this.fileSystem.rename(tempDestination, destination);
    } catch (error) {
      await this.fileSystem.rm(tempDestination, { force: true }).catch((rmError: unknown) => {
        logger.warn(
          `[FileDownloader] failed to remove partial download at ${tempDestination}: ${errorMessage(rmError)}`,
        );
      });
      throw toActionableError(error, `Download failed for ${url}`);
    }
  }

  private async downloadToTemp(
    url: string,
    tempDestination: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.downloadWithCurl(url, tempDestination, signal);
      return;
    } catch (error) {
      if (!this.isCommandUnavailable(error, "curl")) {
        throw error;
      }
      logger.warn("[FileDownloader] curl unavailable, falling back to wget", {
        error: errorMessage(error),
      });
    }

    try {
      await this.downloadWithWget(url, tempDestination, signal);
      return;
    } catch (error) {
      if (!this.isCommandUnavailable(error, "wget")) {
        throw error;
      }
      logger.warn("[FileDownloader] wget unavailable, falling back to Node HTTP", {
        error: errorMessage(error),
      });
    }

    await this.downloadWithNodeHttp(url, tempDestination, 0, signal);
  }

  private async downloadWithCurl(
    url: string,
    destination: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.execute(
      "curl",
      [
        "--fail",
        "--location",
        "--retry",
        "3",
        "--retry-delay",
        "1",
        "--silent",
        "--show-error",
        "-o",
        destination,
        url,
      ],
      { timeout: 120000, maxBuffer: 10 * 1024 * 1024, signal },
    );
  }

  private async downloadWithWget(
    url: string,
    destination: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.execute("wget", ["--tries=3", "--timeout=30", "-O", destination, url], {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      signal,
    });
  }

  private async downloadWithNodeHttp(
    url: string,
    destination: string,
    redirectCount: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (redirectCount > 5) {
      throw new Error(`Too many redirects while downloading ${url}`);
    }

    await new Promise<void>((resolve, reject) => {
      const transport = url.startsWith("https:") ? https : http;
      const abort = (): void => {
        request.destroy(new Error(`Download aborted: ${url}`));
      };
      const request = transport.get(
        url,
        { headers: { "User-Agent": "auto-mobile" } },
        (response) => {
          const statusCode = response.statusCode ?? 0;
          if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
            response.resume();
            const redirectedUrl = new URL(response.headers.location, url).toString();
            void this.downloadWithNodeHttp(redirectedUrl, destination, redirectCount + 1, signal)
              .then(resolve)
              .catch(reject);
            return;
          }

          if (statusCode < 200 || statusCode >= 300) {
            response.resume();
            reject(new Error(`Download failed with status ${statusCode} from ${url}`));
            return;
          }

          void this.pipeResponseToFile(response, destination).then(resolve).catch(reject);
        },
      );

      request.setTimeout(30000, () => {
        request.destroy(new Error(`Download request timed out for ${url}`));
      });
      request.on("error", reject);
      request.once("close", () => signal?.removeEventListener("abort", abort));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
      }
    });
  }

  /**
   * Streams a response body to the caller-provided attempt-unique temp path.
   * The public download method owns cleanup and publication for every
   * transport, so failure can never remove another attempt's completed file.
   *
   * Uses `stream.pipeline` (not `response.pipe`) so a mid-body close — the
   * peer ending the connection before all bytes arrive — surfaces as a
   * rejection instead of stalling forever: `pipe()` only reacts to
   * `'end'`/`'error'`, neither of which fires when the source stream is
   * merely destroyed without ending.
   */
  private async pipeResponseToFile(response: Readable, tempDestination: string): Promise<void> {
    const fileStream = createWriteStream(tempDestination);
    response.once("readable", () => this.onFirstResponseByte?.());
    await pipeline(response, fileStream);
  }

  private isCommandUnavailable(error: unknown, command: string): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }

    const err = error as NodeJS.ErrnoException & { stderr?: string };
    const numericCode = typeof err.code === "number" ? err.code : Number(err.code);
    if (err.code === "ENOENT" || (!Number.isNaN(numericCode) && numericCode === 127)) {
      return true;
    }

    return this.isCommandUnavailableMessage(err, command);
  }

  private isCommandUnavailableMessage(
    err: NodeJS.ErrnoException & { stderr?: string },
    command: string,
  ): boolean {
    const combinedMessage = `${err.message ?? ""} ${err.stderr ?? ""}`.toLowerCase();
    if (
      combinedMessage.includes("command not found") ||
      combinedMessage.includes("not recognized as an internal or external command") ||
      combinedMessage.includes(`${command}: not found`) ||
      combinedMessage.includes(`not found: ${command}`)
    ) {
      return true;
    }

    return false;
  }
}
