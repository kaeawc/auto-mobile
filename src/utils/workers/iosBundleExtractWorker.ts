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
 * `assertZipEntriesContained` is intentionally NOT imported here: pulling in
 * `IOSCtrlProxyBundleDownloader.ts` (and its `Worker`/`ActionableError`
 * imports) would pull the main module into this worker's bundle graph. The
 * containment check is duplicated in this worker; keep it in sync with
 * `assertZipEntriesContained` if either changes — the containment gate MUST
 * run before any entry is written in both.
 */
import { parentPort, workerData } from "node:worker_threads";
import * as path from "node:path";
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

function assertContained(zip: AdmZip, destination: string): void {
  const resolvedRoot = path.resolve(destination);
  for (const entry of zip.getEntries()) {
    const target = path.resolve(resolvedRoot, entry.entryName);
    const relative = path.relative(resolvedRoot, target);
    const escapes =
      relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    if (escapes) {
      throw new Error(
        `Refusing to extract CtrlProxy bundle: entry "${entry.entryName}" resolves outside the ` +
          `extraction directory ${resolvedRoot} (zip-slip / path traversal).`,
      );
    }
  }
}

function run(): void {
  const { bundlePath, destination } = workerData as IosBundleExtractWorkerData;
  try {
    const zip = new AdmZip(bundlePath);
    assertContained(zip, destination);
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
