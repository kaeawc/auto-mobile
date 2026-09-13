import * as fs from "fs/promises";
import * as path from "path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { type FileDownloader, DefaultFileDownloader } from "./FileDownloader";
import {
  type ChecksumCalculator,
  type Sha256Source,
  DefaultChecksumCalculator,
} from "./ChecksumCalculator";
import { ensureSecureDir } from "./filesystem/securePermissions";
import { ActionableError, toActionableError } from "../models/ActionableError";
import type {
  IosBundleExtractWorkerData,
  IosBundleExtractWorkerMessage,
} from "./workers/iosBundleExtractWorker";

export type { Sha256Source };

type ExtractBundleWorkerMessage = IosBundleExtractWorkerMessage;

/** Narrow surface of `worker_threads.Worker` this module depends on, so tests can inject a fake. */
export interface ExtractBundleWorker {
  once(event: "message", listener: (message: ExtractBundleWorkerMessage) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "exit", listener: (code: number) => void): void;
  terminate(): Promise<number>;
}

export type ExtractBundleWorkerFactory = (
  workerData: IosBundleExtractWorkerData,
) => ExtractBundleWorker;

/**
 * Real worker entrypoint (issue #6574), NOT an `eval`-sourced string: adm-zip's
 * `new AdmZip(path)` synchronously reads the whole archive via
 * `fs.readFileSync`, and `extractAllTo` synchronously inflates/writes every
 * entry with no yield point — run entirely on the daemon's main thread, this
 * monopolizes the single event loop for the whole extraction, stalling other
 * devices' WebSocket heartbeats and health-poll timers. Running it inside a
 * `worker_threads` Worker keeps that synchronous cost off the main thread.
 *
 * This MUST be a real, separately built worker file
 * (`src/utils/workers/iosBundleExtractWorker.ts`, listed as its own
 * `build.ts` entrypoint), unlike `DatabaseHealthProbe`'s eval-sourced probe
 * worker: that probe only `require()`s the built-in `bun:sqlite`, but this
 * worker needs `adm-zip`, a devDependency absent from a packaged install's
 * `node_modules`. An eval-sourced `require("adm-zip")` would resolve against
 * that missing install and throw on the very first extraction. A plain
 * `new Worker(new URL("./workers/...ts", import.meta.url))` does not fix this
 * either: Bun's `target: "bun"` build does not auto-discover/bundle workers
 * referenced that way (verified against issue #6574 — only `src/index.ts`'s
 * own graph gets bundled), so building the worker as its own entrypoint and
 * resolving its on-disk path at runtime (see `resolveWorkerScriptPath`) is
 * required to get `adm-zip` inlined into a file that actually ships.
 */
function resolveWorkerScriptPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Dev / `bun test`: this module runs straight from source
    // (src/utils/IOSCtrlProxyBundleDownloader.ts), so its sibling worker
    // source is one directory below.
    path.join(moduleDir, "workers", "iosBundleExtractWorker.ts"),
    // Packaged dist: this module is bundled into dist/src/index.js
    // (moduleDir === dist/src), while the worker is build.ts's second
    // entrypoint, built to dist/src/utils/workers/iosBundleExtractWorker.js.
    path.join(moduleDir, "utils", "workers", "iosBundleExtractWorker.js"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new ActionableError(
      "Could not locate the CtrlProxy bundle extraction worker script. Tried: " +
        candidates.join(", "),
    );
  }
  return found;
}

const defaultExtractBundleWorkerFactory: ExtractBundleWorkerFactory = (workerData) =>
  new Worker(resolveWorkerScriptPath(), { workerData });

export { assertZipEntriesContained } from "./workers/assertZipEntriesContained";

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
    const worker = this.workerFactory({ bundlePath, destination });
    return new Promise<void>((resolve, reject) => {
      let finishing = false;
      const finish = (error?: unknown): void => {
        if (finishing) {
          return;
        }
        finishing = true;
        void worker.terminate().then(
          () => (error === undefined ? resolve() : reject(error)),
          (terminationError: unknown) =>
            reject(toActionableError(terminationError, "Failed to stop extraction worker")),
        );
      };
      worker.once("message", (message) => {
        if (message.ok) {
          finish();
          return;
        }
        const error = new ActionableError(message.message ?? "Failed to extract CtrlProxy bundle");
        if (message.stack) {
          error.stack = message.stack;
        }
        finish(error);
      });
      worker.once("error", (error) => {
        finish(toActionableError(error, "Failed to extract CtrlProxy bundle"));
      });
      worker.once("exit", (code) => {
        if (!finishing) {
          finishing = true;
          reject(
            new ActionableError(
              `CtrlProxy bundle extraction worker exited with code ${code} without a result`,
            ),
          );
        }
      });
    });
  }
}
