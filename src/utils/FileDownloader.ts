import { errorMessage } from "./describeUnknownError";
import { execFile } from "child_process";
import { createWriteStream } from "fs";
import * as fs from "fs/promises";
import http from "http";
import https from "https";
import * as path from "path";
import type { Readable } from "stream";
import { pipeline } from "stream/promises";
import { promisify } from "util";
import { logger } from "./logger";
import { getAbortSignal } from "./AbortContext";
import { toActionableError } from "../models/ActionableError";
import { type IdGenerator, defaultIdGenerator } from "./IdGenerator";

const execFileAsync = promisify(execFile);

export interface FileDownloader {
  download(url: string, destination: string, signal?: AbortSignal): Promise<void>;
}

export class DefaultFileDownloader implements FileDownloader {
  constructor(private readonly idGenerator: IdGenerator = defaultIdGenerator) {}

  public async download(url: string, destination: string, signal?: AbortSignal): Promise<void> {
    signal ??= getAbortSignal();
    if (signal?.aborted) {
      throw new Error(`Download aborted before starting: ${url}`);
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });

    try {
      await this.downloadWithCurl(url, destination, signal);
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
      await this.downloadWithWget(url, destination, signal);
      return;
    } catch (error) {
      if (!this.isCommandUnavailable(error, "wget")) {
        throw error;
      }
      logger.warn("[FileDownloader] wget unavailable, falling back to Node HTTP", {
        error: errorMessage(error),
      });
    }

    await this.downloadWithNodeHttp(url, destination, 0, signal);
  }

  private async downloadWithCurl(
    url: string,
    destination: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await execFileAsync(
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
    await execFileAsync("wget", ["--tries=3", "--timeout=30", "-O", destination, url], {
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

          void this.pipeResponseToFile(response, destination, url).then(resolve).catch(reject);
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
   * Streams a response body to `destination`, writing to an attempt-unique
   * temp path and renaming it onto `destination` only on success. Failure
   * cleanup only ever removes that temp path, so a slow-to-settle failed
   * attempt can never delete a concurrent or retried download's completed
   * file at the same destination (issue #6131).
   *
   * Uses `stream.pipeline` (not `response.pipe`) so a mid-body close — the
   * peer ending the connection before all bytes arrive — surfaces as a
   * rejection instead of stalling forever: `pipe()` only reacts to
   * `'end'`/`'error'`, neither of which fires when the source stream is
   * merely destroyed without ending.
   */
  private async pipeResponseToFile(
    response: Readable,
    destination: string,
    url: string,
  ): Promise<void> {
    const tempDestination = `${destination}.download-${this.idGenerator.next()}.tmp`;
    const fileStream = createWriteStream(tempDestination);
    try {
      await pipeline(response, fileStream);
      await fs.rename(tempDestination, destination);
    } catch (error) {
      await fs.rm(tempDestination, { force: true }).catch((rmError: unknown) => {
        // Best-effort cleanup of the partial file; failing to remove it
        // must not mask the original download error.
        logger.debug(
          `[FileDownloader] failed to remove partial download at ${tempDestination}: ${errorMessage(rmError)}`,
        );
      });
      throw toActionableError(error, `Download failed for ${url}`);
    }
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
