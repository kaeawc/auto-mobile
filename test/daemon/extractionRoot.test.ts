import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { resolveExtractionRootForEntryScript } from "../../src/daemon/manager";

const entryUnder = (root: string): string =>
  path.join(root, "node_modules", "@kaeawc", "auto-mobile", "dist", "src", "index.js");

describe("resolveExtractionRootForEntryScript", () => {
  const tmp = path.resolve(os.tmpdir());

  test("returns a bunx extraction root nested under the temp dir", () => {
    const root = path.join(tmp, "bunx-501-@kaeawc");
    expect(resolveExtractionRootForEntryScript(entryUnder(root))).toBe(root);
  });

  test("rejects an extraction root equal to the temp dir itself", () => {
    expect(resolveExtractionRootForEntryScript(entryUnder(tmp))).toBeNull();
  });

  test("rejects a root outside the temp dir", () => {
    expect(
      resolveExtractionRootForEntryScript(entryUnder(path.join(path.sep, "opt", "app"))),
    ).toBeNull();
  });

  test("rejects a sibling that only shares the temp dir's name prefix", () => {
    expect(resolveExtractionRootForEntryScript(entryUnder(`${tmp}-evil`))).toBeNull();
  });

  test("rejects a script that is not the auto-mobile package", () => {
    const other = path.join(tmp, "x", "node_modules", "left-pad", "index.js");
    expect(resolveExtractionRootForEntryScript(other)).toBeNull();
  });
});
