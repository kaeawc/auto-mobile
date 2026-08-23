import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { copyDatabaseRuntimeFiles } from "../../scripts/build/copy-db-runtime-files";

describe("copyDatabaseRuntimeFiles", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "auto-mobile-db-runtime-"));
    roots.push(root);
    mkdirSync(join(root, "src", "db", "migrations"), { recursive: true });
    writeFileSync(
      join(root, "src", "db", "migrations", "2026_07_02_000_event_composite_indexes.ts"),
      'import { EVENT_TABLES } from "../eventTables";\nexport async function up() {}\n',
    );
    writeFileSync(
      join(root, "src", "db", "eventTables.ts"),
      'export const EVENT_TABLES = ["network_events"] as const;\n',
    );
    return root;
  }

  test("copies raw migrations and their sibling runtime dependencies into dist", () => {
    const root = makeProjectRoot();
    const logs: string[] = [];

    copyDatabaseRuntimeFiles({ projectRoot: root, log: (message) => logs.push(message) });

    const migration = join(
      root,
      "dist",
      "src",
      "db",
      "migrations",
      "2026_07_02_000_event_composite_indexes.ts",
    );
    const runtimeFile = join(root, "dist", "src", "db", "eventTables.ts");

    expect(existsSync(migration)).toBe(true);
    expect(readFileSync(migration, "utf8")).toContain('../eventTables"');
    expect(readFileSync(runtimeFile, "utf8")).toContain("EVENT_TABLES");
    expect(logs).toContain("✓ Copied database migrations");
    expect(logs).toContain("✓ Copied database runtime files");
  });
});
