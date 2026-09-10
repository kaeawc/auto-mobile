/**
 * Real worker_threads entrypoint for CtrlProxy bundle extraction (issue #6574).
 *
 * This file MUST be a bundled worker (referenced via
 * `new Worker(new URL("./iosBundleExtractWorker.ts", import.meta.url))`), not an
 * `eval`-sourced string. An eval-sourced worker's CJS body only sees what is
 * inlined into the string passed to `Worker`; a runtime `require("adm-zip")`
 * inside it resolves against the packaged daemon's `node_modules`, where
 * adm-zip (a devDependency) is absent, and throws
 * `Cannot find package 'adm-zip'` on the very first extraction. Bundling this
 * file as its own worker entrypoint inlines adm-zip into the built worker
 * chunk instead, the same way `src/index.ts` inlines its own dependencies.
 *
 */
import { parentPort, workerData } from "node:worker_threads";
import * as path from "node:path";
import { assertZipEntriesContained } from "./assertZipEntriesContained";
import AdmZip from "adm-zip";
import { errorMessage } from "../describeUnknownError";

export interface IosBundleExtractWorkerData {
  bundlePath: string;
  destination: string;
}

export interface IosBundleExtractWorkerMessage {
  ok: boolean;
  message?: string;
  stack?: string;
}

function run(): void {
  const { bundlePath, destination } = workerData as IosBundleExtractWorkerData;
  try {
    const zip = new AdmZip(bundlePath);
    assertZipEntriesContained(zip, destination);
    zip.extractAllTo(path.resolve(destination), true);
    const message: IosBundleExtractWorkerMessage = { ok: true };
    parentPort?.postMessage(message);
  } catch (error) {
    const message: IosBundleExtractWorkerMessage = {
      ok: false,
      message: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
    parentPort?.postMessage(message);
  }
}

run();
