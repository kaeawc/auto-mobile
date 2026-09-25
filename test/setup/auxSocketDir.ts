import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Repeated preload evaluations in one process share a short socket directory. */
export function ensureAuxSocketDir(): string {
  const auxSocketDir = path.join(os.tmpdir(), `am-sock-${process.pid}`);
  mkdirSync(auxSocketDir, { recursive: true });
  return auxSocketDir;
}
