import { findOffenseLines, sourceFiles } from "./noLegacyAutomobilePathScan";
import { readGuardFile } from "./astGuard";
import { describe, expect, test } from "bun:test";

import path from "node:path";

const SOURCE_DIR = path.join(import.meta.dir, "..", "..", "src");

// The full src/ traversal is too slow for the 100 ms unit budget, so it lives in an integration
// guard and runs inside the timed test rather than hidden in beforeAll (#14475).
describe("shared AutoMobile directory path literals", () => {
  test("does not use the legacy .automobile path component", () => {
    const offenses = sourceFiles(SOURCE_DIR).flatMap((file) =>
      findOffenseLines(readGuardFile(file)).map(
        (line) => `${path.relative(SOURCE_DIR, file)}:${line}`,
      ),
    );
    expect(offenses).toEqual([]);
  });
});
