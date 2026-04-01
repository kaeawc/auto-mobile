import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readdirAsync, unlinkAsync } from "../../src/utils/io";

/**
 * Replicate the pruning algorithm from logger.ts to test it directly.
 * The actual function is module-scoped, so we mirror its logic here.
 */
async function pruneOldLogFiles(logsDir: string, maxLogFiles: number): Promise<void> {
  const entries = await readdirAsync(logsDir);
  const logFiles = entries.filter(f => f.endsWith(".log")).sort();
  if (logFiles.length <= maxLogFiles) { return; }
  const toDelete = logFiles.slice(0, logFiles.length - maxLogFiles);
  for (const file of toDelete) {
    await unlinkAsync(join(logsDir, file));
  }
}

describe("Log file pruning", () => {
  const tempDirs: string[] = [];

  function createTempLogsDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "logger-prune-test-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        const { rmSync } = require("node:fs");
        rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  test("deletes all excess log files in a single pass (no cap)", async () => {
    const logsDir = createTempLogsDir();

    for (let i = 0; i < 25; i++) {
      const name = `server-2026-04-01T${String(i).padStart(2, "0")}-00-00.000Z.log`;
      writeFileSync(join(logsDir, name), "log content");
    }

    await pruneOldLogFiles(logsDir, 10);

    const remaining = readdirSync(logsDir).filter(f => f.endsWith(".log"));
    expect(remaining.length).toBe(10);
  });

  test("no-op when file count is at or below limit", async () => {
    const logsDir = createTempLogsDir();

    for (let i = 0; i < 10; i++) {
      writeFileSync(join(logsDir, `server-${i}.log`), "content");
    }

    await pruneOldLogFiles(logsDir, 10);

    const remaining = readdirSync(logsDir).filter(f => f.endsWith(".log"));
    expect(remaining.length).toBe(10);
  });

  test("no-op when directory is empty", async () => {
    const logsDir = createTempLogsDir();
    await pruneOldLogFiles(logsDir, 10);
    const remaining = readdirSync(logsDir);
    expect(remaining.length).toBe(0);
  });

  test("handles large excess (simulates crash-loop scenario)", async () => {
    const logsDir = createTempLogsDir();

    // Simulate 100 rotated files from a crash loop
    for (let i = 0; i < 100; i++) {
      const ts = String(i).padStart(3, "0");
      writeFileSync(join(logsDir, `server-2026-04-01T17-20-${ts}.log`), "x");
    }

    await pruneOldLogFiles(logsDir, 10);

    const remaining = readdirSync(logsDir).filter(f => f.endsWith(".log"));
    expect(remaining.length).toBe(10);
  });

  test("preserves server.log (sorts last alphabetically)", async () => {
    const logsDir = createTempLogsDir();

    // Create timestamped files + active server.log
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(logsDir, `server-2026-04-01T${String(i).padStart(2, "0")}.log`), "x");
    }
    writeFileSync(join(logsDir, "server.log"), "active log");

    await pruneOldLogFiles(logsDir, 10);

    const remaining = readdirSync(logsDir).filter(f => f.endsWith(".log")).sort();
    expect(remaining.length).toBe(10);
    // server.log sorts last and should be preserved
    expect(remaining).toContain("server.log");
  });

  test("ignores non-log files", async () => {
    const logsDir = createTempLogsDir();

    for (let i = 0; i < 15; i++) {
      writeFileSync(join(logsDir, `server-${i}.log`), "x");
    }
    writeFileSync(join(logsDir, "config.json"), "not a log");
    writeFileSync(join(logsDir, "notes.txt"), "not a log");

    await pruneOldLogFiles(logsDir, 10);

    const allFiles = readdirSync(logsDir);
    const logFiles = allFiles.filter(f => f.endsWith(".log"));
    expect(logFiles.length).toBe(10);
    // Non-log files should be untouched
    expect(allFiles).toContain("config.json");
    expect(allFiles).toContain("notes.txt");
  });
});
