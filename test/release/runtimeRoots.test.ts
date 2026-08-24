import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveRootsFromDist, runtimeRootsInSource } from "../../scripts/release/lib/runtime-roots";

describe("runtimeRootsInSource", () => {
  test("includes runtime imports but not type imports or comments", () => {
    const source = `
      // import ignored from "comment-only";
      import type { Config } from "types-only";
      import { sql } from "kysely";
      export { helper } from "exported-runtime";
      const legacy = require("legacy-runtime");
      const loaded = import("dynamic-runtime");
    `;

    expect(runtimeRootsInSource("migration.ts", source)).toEqual([
      "dynamic-runtime",
      "exported-runtime",
      "kysely",
      "legacy-runtime",
    ]);
  });
});

describe("deriveRootsFromDist", () => {
  test("uses only bundle dynamic imports and all copied-source runtime imports", () => {
    const dist = mkdtempSync(path.join(os.tmpdir(), "automobile-runtime-roots-"));
    try {
      mkdirSync(path.join(dist, "src"), { recursive: true });
      mkdirSync(path.join(dist, "db", "migrations"), { recursive: true });
      writeFileSync(
        path.join(dist, "src/index.js"),
        `const image = import("jimp"); const text = "import('ignored')";`,
      );
      writeFileSync(
        path.join(dist, "db/migrations/runtime.ts"),
        `import type { Kysely } from "kysely"; import { sql } from "kysely";`,
      );
      writeFileSync(
        path.join(dist, "db/migrations/ignored.ts"),
        `// import { x } from "comment-only"; import "@img/sharp-linux-x64"; import "node:fs";`,
      );

      expect(deriveRootsFromDist(dist)).toEqual(["jimp", "kysely"]);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
