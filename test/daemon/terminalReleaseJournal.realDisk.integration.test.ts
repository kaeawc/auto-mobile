import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDaemonTerminalReleaseJournal,
  nodeTerminalReleaseJournalFileSystem,
  terminalReleaseJournalPath,
} from "../../src/daemon/terminalReleaseJournal";

function line(sessionId: string, reason: string, at: number): string {
  return `${JSON.stringify({ sessionId, reason, at })}\n`;
}

// Real-disk durability: fsync cost makes these integration tests, not 100 ms unit tests. The
// unit suite asserts the same ordering against FakeTerminalReleaseJournalFsPrimitives.
describe("nodeTerminalReleaseJournalFileSystem on a real disk (#10959)", () => {
  test("real durable append syncs the file before every newly created directory's parent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trj-first-"));
    const openSync = fs.openSync;
    const fsyncSync = fs.fsyncSync;
    const paths = new Map<number, string>();
    const syncedPaths: string[] = [];
    const open = spyOn(fs, "openSync").mockImplementation((filePath, flags, mode) => {
      const fd = openSync(filePath, flags, mode);
      paths.set(fd, String(filePath));
      return fd;
    });
    const sync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      syncedPaths.push(paths.get(fd)!);
      fsyncSync(fd);
    });
    try {
      const journalDir = path.join(dir, "new", "nested", "journal");
      const file = path.join(journalDir, "journal.jsonl");
      nodeTerminalReleaseJournalFileSystem.appendDurable(file, "first\n");
      expect(syncedPaths).toEqual(
        process.platform === "win32"
          ? [file]
          : [file, journalDir, dir, path.join(dir, "new"), path.join(dir, "new", "nested")],
      );
      syncedPaths.length = 0;
      nodeTerminalReleaseJournalFileSystem.appendDurable(file, "second\n");
      expect(syncedPaths).toEqual(process.platform === "win32" ? [file] : [file, journalDir]);
      expect(fs.readFileSync(file, "utf8")).toBe("first\nsecond\n");

      syncedPaths.length = 0;
      const unsyncedFile = path.join(dir, "unsynced", "nested", "journal.jsonl");
      nodeTerminalReleaseJournalFileSystem.appendDurable(unsyncedFile, "third\n", false);
      expect(syncedPaths).toEqual([unsyncedFile]);
    } finally {
      sync.mockRestore();
      open.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the daemon journal round-trips through a real data directory", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-release-journal-"));
    try {
      const filePath = terminalReleaseJournalPath(path.join(dataDir, "nested"), "daemon-a");
      const open = () =>
        createDaemonTerminalReleaseJournal({
          dataDir: path.join(dataDir, "nested"),
          daemonSessionId: "daemon-a",
          liveDaemonSessionIds: new Set(["daemon-a"]),
        });
      const journal = open();
      journal.record({ sessionId: "a", reason: "explicit-release", at: 1 });
      journal.record({ sessionId: "b", reason: "heartbeat-timeout", at: 2 });
      journal.resolve("a");

      expect(fs.readFileSync(filePath, "utf-8")).toBe(line("b", "heartbeat-timeout", 2));
      expect(open().loadUnconfirmed()).toEqual([
        { sessionId: "b", reason: "heartbeat-timeout", at: 2 },
      ]);

      journal.resolve("b");
      expect(fs.existsSync(filePath)).toBe(false);
      expect(fs.readdirSync(path.dirname(filePath))).toEqual([]);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
