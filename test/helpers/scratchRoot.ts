import { afterAll, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * One temp root per describe block, with a fresh empty directory per test.
 *
 * CI's per-test time includes `beforeEach`/`afterEach` but not `beforeAll`/`afterAll`, so a
 * `mkdtemp` in `beforeEach` plus a recursive `rm` in `afterEach` is paid inside every test's
 * 100 ms budget (and stretches 5-15x on a contended runner). Here the root is created once in
 * `beforeAll`, each test only makes its own empty directory inside it with a single `mkdir`, and
 * the one recursive cleanup runs in `afterAll`. Test/test.each isolation is unchanged: no two
 * tests ever share a directory.
 */
export function useScratchRoot(prefix: string): { next(): string } {
  let root = "";
  let count = 0;
  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), prefix));
  });
  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of an OS temp directory; Windows can hold a handle briefly.
    }
  });
  return {
    next() {
      const dir = path.join(root, `t${count++}`);
      mkdirSync(dir);
      return dir;
    },
  };
}
