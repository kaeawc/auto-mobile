import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { relativeImportTargets } from "../../scripts/check-utils-import-direction";

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "import-targets-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function targetsOf(source: string): string[] {
  const file = join(dir, "sample.ts");
  writeFileSync(file, source);
  return relativeImportTargets(file).map((target) =>
    relative(relative(process.cwd(), dir), target).replaceAll("\\", "/"),
  );
}

describe("relativeImportTargets", () => {
  test("sees quoted and no-substitution template dynamic imports", () => {
    expect(
      targetsOf('await import("./quoted");\nawait import(`./templated`);\nrequire(`./req`);\n'),
    ).toEqual(["quoted", "templated", "req"]);
  });

  test("ignores template literals with substitutions", () => {
    expect(targetsOf("await import(`./dyn${name}`);")).toEqual([]);
  });
});
