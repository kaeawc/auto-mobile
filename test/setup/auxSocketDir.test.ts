import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureAuxSocketDir } from "./auxSocketDir";

test("repeated setup in one process uses the same socket directory", () => {
  const expected = path.join(os.tmpdir(), `am-sock-${process.pid}`);
  expect(ensureAuxSocketDir()).toBe(expected);
  expect(ensureAuxSocketDir()).toBe(expected);
  expect(existsSync(expected)).toBe(true);
});
