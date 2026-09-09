import * as fs from "fs/promises";
import * as path from "path";
import { Worker } from "node:worker_threads";
import AdmZip from "adm-zip";
import { type FileDownloader, DefaultFileDownloader } from "./FileDownloader";
import {
  type ChecksumCalculator,
  type Sha256Source,
  DefaultChecksumCalculator,
} from "./ChecksumCalculator";
import { ensureSecureDir } from "./filesystem/securePermissions";
import { ActionableError, toActionableError } from "../models/ActionableError";

export type { Sha256Source };

/**
 * Self-contained CJS source for the extraction worker (issue #6574). adm-zip's
 * `new AdmZip(path)` synchronously reads the whole archive via
 * `fs.readFileSync`, and `extractAllTo` synchronously inflates/writes every
 * entry with no yield point — run entirely on the daemon's main thread, this
 * monopolizes the single event loop for the whole extraction, stalling other
 * devices' WebSocket heartbeats and health-poll timers. Running it inside a
 * `worker_threads` Worker (the same eval-source pattern as
 * `DatabaseHealthProbe`'s SQLITE_PROBE_WORKER_SOURCE) keeps that synchronous
 * cost off the main thread entirely.
 *
 * The zip-slip containment check is duplicated here (rather than reused from
 * `assertZipEntriesContained` below) because an `eval`-sourced worker has no
 * access to this module's TypeScript — it only sees the string passed to
 * `Worker`. Keep the traversal-rejection logic here in sync with
 * `assertZipEntriesContained` if either changes; the containment gate MUST
 * run before any entry is written in both.
 */
const EXTRACT_BUNDLE_WORKER_SOURCE = `
  const { parentPort, workerData } = require("node:worker_threads");
  const AdmZip = require("adm-zip");
  const path = require("node:path");
  try {
    const zip = new AdmZip(workerData.bundlePath);
    const resolvedRoot = path.resolve(workerData.destination);
    for (const entry of zip.getEntries()) {
      const target = path.resolve(resolvedRoot, entry.entryName);
      const relative = path.relative(resolvedRoot, target);
      const escapes =
        relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative);
      if (escapes) {
        throw new Error(
          'Refusing to extract CtrlProxy bundle: entry "' + entry.entryName +
            '" resolves outside the extraction directory ' + resolvedRoot +
            ' (zip-slip / path traversal).'
        );
      }
    }
    zip.extractAllTo(resolvedRoot, true);
    parentPort.postMessage({ ok: true });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
`;

interface ExtractBundleWorkerMessage {
  ok: boolean;
  message?: string;
  stack?: string;
}

/** Narrow surface of `worker_threads.Worker` this module depends on, so tests can inject a fake. */
export interface ExtractBundleWorker {
  once(event: "message", listener: (message: ExtractBundleWorkerMessage) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "exit", listener: (code: number) => void): void;
  terminate(): Promise<number>;
}

export type ExtractBundleWorkerFactory = (
  source: string,
  workerData: { bundlePath: string; destination: string },
) => ExtractBundleWorker;

const defaultExtractBundleWorkerFactory: ExtractBundleWorkerFactory = (source, workerData) =>
  new Worker(source, { eval: true, workerData });

/**
 * Defensive zip-slip containment check (issue #4761). adm-zip >= 0.5.10 already
 * sanitizes entry names in `extractAllTo` (`canonical` + `sanitize`), but this
 * bundle only reaches extraction on the unverified fallback/override paths, so a
 * malicious archive is worth a second, explicit gate: reject any entry that
 * resolves outside the destination BEFORE writing a single file. Belt-and-braces
 * on top of the library guard, independent of the installed adm-zip version.
 */
export function assertZipEntriesContained(zip: AdmZip, destination: string): void {
  const resolvedRoot = path.resolve(destination);
  for (const entry of zip.getEntries()) {
    const target = path.resolve(resolvedRoot, entry.entryName);
    const relative = path.relative(resolvedRoot, target);
    const escapes =
      relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    if (escapes) {
      throw new ActionableError(
        `Refusing to extract CtrlProxy bundle: entry "${entry.entryName}" resolves outside the ` +
          `extraction directory ${resolvedRoot} (zip-slip / path traversal).`,
      );
    }
  }
}

export interface CtrlProxyIosBundleDownloader {
  download(url: string, destination: string): Promise<void>;
  computeFileSha256(filePath: string): Promise<{ checksum: string; source: Sha256Source }>;
  extractBundle(bundlePath: string, destination: string): Promise<void>;
}

export class DefaultIOSCtrlProxyBundleDownloader implements CtrlProxyIosBundleDownloader {
  private readonly fileDownloader: FileDownloader;
  private readonly checksumCalculator: ChecksumCalculator;
  private readonly workerFactory: ExtractBundleWorkerFactory;

  constructor(
    fileDownloader: FileDownloader = new DefaultFileDownloader(),
    checksumCalculator: ChecksumCalculator = new DefaultChecksumCalculator(),
    workerFactory: ExtractBundleWorkerFactory = defaultExtractBundleWorkerFactory,
  ) {
    this.fileDownloader = fileDownloader;
    this.checksumCalculator = checksumCalculator;
    this.workerFactory = workerFactory;
  }

  public async download(url: string, destination: string): Promise<void> {
    return this.fileDownloader.download(url, destination);
  }

  public async computeFileSha256(
    filePath: string,
  ): Promise<{ checksum: string; source: Sha256Source }> {
    return this.checksumCalculator.computeFileSha256(filePath);
  }

  public async extractBundle(bundlePath: string, destination: string): Promise<void> {
    await fs.rm(destination, { recursive: true, force: true });
    // Owner-only (0o700) instead of the umask default: the extracted runner is
    // launched from here, so other uids must not be able to swap its binaries
    // between verification and launch (TOCTOU, issue #4759).
    await ensureSecureDir(destination);

    // Decompression + writes run on a worker_threads worker, not this thread
    // (issue #6574): adm-zip's read/extract calls are synchronous with no
    // yield point, and running them here would stall the daemon's single
    // event loop — health polls, WebSocket heartbeats, session lease checks —
    // for the whole extraction window.
    await this.extractInWorker(bundlePath, destination);
  }

  private extractInWorker(bundlePath: string, destination: string): Promise<void> {
    const worker = this.workerFactory(EXTRACT_BUNDLE_WORKER_SOURCE, { bundlePath, destination });
    return new Promise<void>((resolve, reject) => {
      worker.once("message", (message) => {
        void worker.terminate();
        if (message.ok) {
          resolve();
          return;
        }
        const error = new ActionableError(message.message ?? "Failed to extract CtrlProxy bundle");
        if (message.stack) {
          error.stack = message.stack;
        }
        reject(error);
      });
      worker.once("error", (error) => {
        void worker.terminate();
        reject(toActionableError(error, "Failed to extract CtrlProxy bundle"));
      });
      worker.once("exit", (code) => {
        if (code !== 0) {
          reject(
            new ActionableError(`CtrlProxy bundle extraction worker exited with code ${code}`),
          );
        }
      });
    });
  }
}
