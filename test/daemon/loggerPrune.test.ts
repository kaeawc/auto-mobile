import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pruneLogFiles } from "../../src/utils/logPruner";

/**
 * Tests the REAL prune used by logger.ts (src/utils/logPruner.ts), which is
 * multi-process safe: it caps only the current process's own files and sweeps
 * other processes' files only when they are stale by mtime — never deleting
 * another live process's current file.
 */
describe("pruneLogFiles", () => {
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

  test("caps this process's own files and preserves the active server-<pid>.log", async () => {
    const logsDir = createTempLogsDir();
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(logsDir, `server-111-2026-04-01T${String(i).padStart(2, "0")}.log`), "x");
    }
    writeFileSync(join(logsDir, "server-111.log"), "active");

    await pruneLogFiles({ dir: logsDir, ownPrefix: "server-111", maxOwnFiles: 10, abandonedMaxAgeMs: 1e12 });

    const remaining = readdirSync(logsDir).filter(f => f.endsWith(".log"));
    expect(remaining.length).toBe(10);
    // "server-111.log" sorts after "server-111-..." so the active file survives.
    expect(remaining).toContain("server-111.log");
  });

  test("never deletes another live process's recent files", async () => {
    const logsDir = createTempLogsDir();
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(logsDir, `server-222-${i}.log`), "x");
    }
    const baseNow = Date.now();

    // Our own prefix has no files; the other process's files are recent.
    await pruneLogFiles({
      dir: logsDir,
      ownPrefix: "server-111",
      maxOwnFiles: 10,
      abandonedMaxAgeMs: 60_000,
      now: baseNow,
    });

    const remaining = readdirSync(logsDir).filter(f => f.startsWith("server-222"));
    expect(remaining.length).toBe(5);
  });

  test("sweeps another process's stale files (by mtime)", async () => {
    const logsDir = createTempLogsDir();
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(logsDir, `server-222-${i}.log`), "x");
    }
    const baseNow = Date.now();

    // Advance the injected clock past the abandonment age.
    await pruneLogFiles({
      dir: logsDir,
      ownPrefix: "server-111",
      maxOwnFiles: 10,
      abandonedMaxAgeMs: 1_000,
      now: baseNow + 60_000,
    });

    const remaining = readdirSync(logsDir).filter(f => f.startsWith("server-222"));
    expect(remaining.length).toBe(0);
  });

  test("no-op when own count is at or below the cap", async () => {
    const logsDir = createTempLogsDir();
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(logsDir, `server-111-${i}.log`), "x");
    }

    await pruneLogFiles({ dir: logsDir, ownPrefix: "server-111", maxOwnFiles: 10, abandonedMaxAgeMs: 1e12 });

    expect(readdirSync(logsDir).filter(f => f.endsWith(".log")).length).toBe(10);
  });

  test("no-op (no throw) when directory is empty or missing", async () => {
    const logsDir = createTempLogsDir();
    await pruneLogFiles({ dir: logsDir, ownPrefix: "server-111", maxOwnFiles: 10, abandonedMaxAgeMs: 1000 });
    expect(readdirSync(logsDir).length).toBe(0);

    await pruneLogFiles({ dir: join(logsDir, "does-not-exist"), ownPrefix: "server-111", maxOwnFiles: 10, abandonedMaxAgeMs: 1000 });
  });

  test("ignores non-log files", async () => {
    const logsDir = createTempLogsDir();
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(logsDir, `server-111-${i}.log`), "x");
    }
    writeFileSync(join(logsDir, "config.json"), "not a log");
    writeFileSync(join(logsDir, "notes.txt"), "not a log");

    await pruneLogFiles({ dir: logsDir, ownPrefix: "server-111", maxOwnFiles: 10, abandonedMaxAgeMs: 1e12 });

    const allFiles = readdirSync(logsDir);
    expect(allFiles.filter(f => f.endsWith(".log")).length).toBe(10);
    expect(allFiles).toContain("config.json");
    expect(allFiles).toContain("notes.txt");
  });
});
