import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FileTerminalReleaseJournal,
  nodeTerminalReleaseJournalFileSystem,
  createDaemonTerminalReleaseJournal,
  TERMINAL_RELEASE_JOURNAL_FILE_NAME,
  terminalReleaseJournalPath,
} from "../../src/daemon/terminalReleaseJournal";
import { logger } from "../../src/utils/logger";
import { FakeTerminalReleaseJournalFileSystem } from "../fakes/FakeTerminalReleaseJournalFileSystem";

const FILE = "/data/terminal-release-intents.jsonl";

/** A read-only view of the shared fake that ignores its read failure (a later daemon). */
class FakeReadable extends FakeTerminalReleaseJournalFileSystem {
  constructor(private readonly backing: FakeTerminalReleaseJournalFileSystem) {
    super();
  }

  override readText(filePath: string): string | undefined {
    return this.backing.files.get(filePath);
  }
}

function line(sessionId: string, reason: string, at: number): string {
  return `${JSON.stringify({ sessionId, reason, at })}\n`;
}

describe("FileTerminalReleaseJournal (#10959)", () => {
  test("an intent is appended durably before anything else and survives a new journal", () => {
    const fs = new FakeTerminalReleaseJournalFileSystem();
    new FileTerminalReleaseJournal(FILE, fs).record({
      sessionId: "old",
      reason: "heartbeat-timeout",
      at: 1000,
    });

    expect(fs.appends).toEqual([line("old", "heartbeat-timeout", 1000)]);
    expect(new FileTerminalReleaseJournal(FILE, fs).loadUnconfirmed()).toEqual([
      { sessionId: "old", reason: "heartbeat-timeout", at: 1000 },
    ]);
  });

  test("resolving the last intent removes the file; resolving one of two rewrites the rest", () => {
    const fs = new FakeTerminalReleaseJournalFileSystem();
    const journal = new FileTerminalReleaseJournal(FILE, fs);
    journal.record({ sessionId: "a", reason: "explicit-release", at: 1 });
    journal.record({ sessionId: "b", reason: "heartbeat-timeout", at: 2 });

    journal.resolve("a", "explicit-release");
    expect(fs.files.get(FILE)).toBe(line("b", "heartbeat-timeout", 2));

    journal.resolve("b");
    expect(fs.files.has(FILE)).toBe(false);
  });

  test("a lifted fence stays lifted across restart even when compaction fails (#11077)", () => {
    const fs = new FakeTerminalReleaseJournalFileSystem();
    const journal = new FileTerminalReleaseJournal(FILE, fs);
    journal.record({ sessionId: "live", reason: "heartbeat-timeout", at: 1 });
    journal.record({ sessionId: "other", reason: "explicit-release", at: 2 });
    fs.failCompaction = Object.assign(new Error("EPERM"), { code: "EPERM" });

    journal.resolve("live");

    expect(new FileTerminalReleaseJournal(FILE, fs).loadUnconfirmed()).toEqual([
      { sessionId: "other", reason: "explicit-release", at: 2 },
    ]);
    // A later release of the same session after the lift is honoured again.
    journal.record({ sessionId: "live", reason: "device-killed", at: 3 });
    expect(new FileTerminalReleaseJournal(FILE, fs).loadUnconfirmed()).toEqual([
      { sessionId: "other", reason: "explicit-release", at: 2 },
      { sessionId: "live", reason: "device-killed", at: 3 },
    ]);
  });

  test("a failed compaction rename is not retried or slept on; the lifted marker is appended at once (#11102)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trj-"));
    const file = path.join(dir, TERMINAL_RELEASE_JOURNAL_FILE_NAME);
    const rename = spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("held by AV"), { code: "EPERM" });
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const wait = spyOn(Atomics, "wait");
    try {
      const journal = new FileTerminalReleaseJournal(file, nodeTerminalReleaseJournalFileSystem);
      journal.record({ sessionId: "live", reason: "heartbeat-timeout", at: 1 });
      journal.record({ sessionId: "other", reason: "explicit-release", at: 2 });

      journal.resolve("live");

      expect(rename).toHaveBeenCalledTimes(1);
      expect(wait).not.toHaveBeenCalled();
      expect(fs.readdirSync(dir)).toEqual([TERMINAL_RELEASE_JOURNAL_FILE_NAME]);
      rename.mockRestore();
      expect(
        new FileTerminalReleaseJournal(file, nodeTerminalReleaseJournalFileSystem)
          .loadUnconfirmed()
          .map(({ sessionId }) => sessionId),
      ).toEqual(["other"]);
    } finally {
      wait.mockRestore();
      warn.mockRestore();
      rename.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a confirmation for another reason keeps a later upgraded intent", () => {
    const fs = new FakeTerminalReleaseJournalFileSystem();
    const journal = new FileTerminalReleaseJournal(FILE, fs);
    journal.record({ sessionId: "a", reason: "heartbeat-timeout", at: 1 });
    journal.record({ sessionId: "a", reason: "device-killed", at: 1 });

    journal.resolve("a", "heartbeat-timeout");

    expect(new FileTerminalReleaseJournal(FILE, fs).loadUnconfirmed()).toEqual([
      { sessionId: "a", reason: "device-killed", at: 1 },
    ]);
  });

  test("a torn last line and corrupt lines are ignored and compacted away", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const fs = new FakeTerminalReleaseJournalFileSystem();
      fs.files.set(
        FILE,
        line("a", "explicit-release", 1) +
          "not json\n" +
          `${JSON.stringify({ sessionId: "", reason: "x", at: 1 })}\n` +
          line("b", "heartbeat-timeout", 2) +
          '{"sessionId":"c","reas',
      );
      const journal = new FileTerminalReleaseJournal(FILE, fs);

      expect(journal.loadUnconfirmed().map(({ sessionId }) => sessionId)).toEqual(["a", "b"]);
      expect(fs.files.get(FILE)).toBe(
        line("a", "explicit-release", 1) + line("b", "heartbeat-timeout", 2),
      );

      // The next append starts on a clean line.
      journal.record({ sessionId: "d", reason: "explicit-release", at: 3 });
      expect(new FileTerminalReleaseJournal(FILE, fs).loadUnconfirmed()).toHaveLength(3);
    } finally {
      warn.mockRestore();
    }
  });

  test("an unreadable journal is never compacted; it appends and retries the read (#11114)", () => {
    const fs = new FakeTerminalReleaseJournalFileSystem();
    fs.files.set(FILE, line("predecessor", "heartbeat-timeout", 1));
    fs.failReads = Object.assign(new Error("EIO"), { code: "EIO" });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const journal = new FileTerminalReleaseJournal(FILE, fs);
      expect(journal.loadUnconfirmed()).toEqual([]);
      journal.record({ sessionId: "mine", reason: "explicit-release", at: 2 });
      journal.resolve("mine", "explicit-release");

      // Nothing was rewritten or removed from the empty cache: the predecessor intent survives.
      expect(fs.replaces).toBe(0);
      expect(new FileTerminalReleaseJournal(FILE, new FakeReadable(fs)).loadUnconfirmed()).toEqual([
        { sessionId: "predecessor", reason: "heartbeat-timeout", at: 1 },
      ]);

      // Once the file reads again, the same journal recovers the predecessor intent.
      fs.failReads = undefined;
      expect(journal.loadUnconfirmed()).toEqual([
        { sessionId: "predecessor", reason: "heartbeat-timeout", at: 1 },
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a failed append is logged and still tracked in memory", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const fs = new FakeTerminalReleaseJournalFileSystem();
      fs.failNextAppend = new Error("ENOSPC");
      const journal = new FileTerminalReleaseJournal(FILE, fs);

      journal.record({ sessionId: "a", reason: "explicit-release", at: 1 });

      expect(journal.loadUnconfirmed()).toHaveLength(1);
      expect(warn.mock.calls.some((call) => String(call[0]).includes("ENOSPC"))).toBe(true);
    } finally {
      warn.mockRestore();
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

describe("per-daemon terminal release journals (#11158)", () => {
  const DATA = "/data";
  const legacy = path.join(DATA, TERMINAL_RELEASE_JOURNAL_FILE_NAME);
  const own = terminalReleaseJournalPath(DATA, "self");
  const peer = terminalReleaseJournalPath(DATA, "live-peer");
  const dead = terminalReleaseJournalPath(DATA, "dead-daemon");

  function open(fs: FakeTerminalReleaseJournalFileSystem, live: string[] = ["self", "live-peer"]) {
    return createDaemonTerminalReleaseJournal({
      dataDir: DATA,
      daemonSessionId: "self",
      liveDaemonSessionIds: new Set(live),
      fileSystem: fs,
    });
  }

  test("adopts a dead daemon's intents and never reads or touches a live peer's", () => {
    const fs = new FakeTerminalReleaseJournalFileSystem();
    fs.files.set(peer, line("peer-session", "heartbeat-timeout", 1));
    fs.files.set(dead, line("dead-session", "explicit-release", 2) + '{"torn');

    const journal = open(fs);

    expect(journal.loadUnconfirmed()).toEqual([
      { sessionId: "dead-session", reason: "explicit-release", at: 2 },
    ]);
    expect(fs.files.get(own)).toBe(line("dead-session", "explicit-release", 2));
    expect(fs.files.has(dead)).toBe(false);
    expect(fs.files.get(peer)).toBe(line("peer-session", "heartbeat-timeout", 1));
  });

  test("compaction rewrites only this daemon's file", () => {
    const fs = new FakeTerminalReleaseJournalFileSystem();
    const peerText = line("peer-a", "heartbeat-timeout", 1) + line("peer-b", "device-killed", 2);
    fs.files.set(peer, peerText);
    const journal = open(fs);
    journal.record({ sessionId: "mine", reason: "explicit-release", at: 3 });
    journal.record({ sessionId: "mine-2", reason: "explicit-release", at: 4 });

    journal.resolve("mine");
    journal.resolve("mine-2");

    expect(fs.files.has(own)).toBe(false);
    expect(fs.files.get(peer)).toBe(peerText);
  });

  test("the legacy shared file is adopted only when no peer daemon is live", () => {
    const withPeer = new FakeTerminalReleaseJournalFileSystem();
    withPeer.files.set(legacy, line("legacy-session", "explicit-release", 1));
    expect(open(withPeer).loadUnconfirmed()).toEqual([]);
    expect(withPeer.files.has(legacy)).toBe(true);

    const alone = new FakeTerminalReleaseJournalFileSystem();
    alone.files.set(legacy, line("legacy-session", "explicit-release", 1));
    expect(open(alone, ["self"]).loadUnconfirmed()).toEqual([
      { sessionId: "legacy-session", reason: "explicit-release", at: 1 },
    ]);
    expect(alone.files.has(legacy)).toBe(false);
  });

  test("a dead daemon's file is kept when its intents cannot be adopted durably", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const fs = new FakeTerminalReleaseJournalFileSystem();
      fs.files.set(dead, line("dead-session", "explicit-release", 2));
      fs.failNextAppend = new Error("ENOSPC");

      expect(open(fs).loadUnconfirmed()).toEqual([]);
      expect(fs.files.get(dead)).toBe(line("dead-session", "explicit-release", 2));
      // The next startup adopts it.
      expect(open(fs).loadUnconfirmed()).toEqual([
        { sessionId: "dead-session", reason: "explicit-release", at: 2 },
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  // #11355: a peer that was live at startup is skipped there, so it is adopted once it is dead.
  test("a peer that died after startup is adopted on demand, durably, exactly once", () => {
    const fs = new FakeTerminalReleaseJournalFileSystem();
    fs.files.set(peer, line("peer-session", "heartbeat-timeout", 1) + '{"torn');
    const journal = open(fs);
    journal.record({ sessionId: "mine", reason: "explicit-release", at: 5 });
    expect(journal.loadUnconfirmed().map((intent) => intent.sessionId)).toEqual(["mine"]);

    expect(journal.adoptDeadDaemon("live-peer")).toEqual([
      { sessionId: "peer-session", reason: "heartbeat-timeout", at: 1 },
    ]);

    expect(fs.files.has(peer)).toBe(false);
    expect(fs.files.get(own)).toBe(
      line("mine", "explicit-release", 5) + line("peer-session", "heartbeat-timeout", 1),
    );
    expect(journal.loadUnconfirmed().map((intent) => intent.sessionId)).toEqual([
      "mine",
      "peer-session",
    ]);
    // A restart of this daemon still finds the adopted intent, and a second adoption finds none.
    expect(
      open(fs, ["self"])
        .loadUnconfirmed()
        .map((intent) => intent.sessionId),
    ).toEqual(["mine", "peer-session"]);
    expect(journal.adoptDeadDaemon("live-peer")).toEqual([]);
    // Resolving the adopted intent compacts it out of this daemon's file.
    journal.resolve("peer-session", "heartbeat-timeout");
    expect(fs.files.get(own)).toBe(line("mine", "explicit-release", 5));
  });

  test("on-demand adoption honours the dead peer's lifted fences and never its own file", () => {
    const fs = new FakeTerminalReleaseJournalFileSystem();
    fs.files.set(
      peer,
      line("lifted", "device-killed", 1) +
        `${JSON.stringify({ sessionId: "lifted", lifted: true })}\n` +
        line("kept", "explicit-release", 2),
    );
    const journal = open(fs);

    expect(journal.adoptDeadDaemon("self")).toEqual([]);
    expect(journal.adoptDeadDaemon("live-peer")).toEqual([
      { sessionId: "kept", reason: "explicit-release", at: 2 },
    ]);
    expect(journal.adoptDeadDaemon("never-wrote-a-journal")).toEqual([]);
  });

  test("this daemon's own intent for a session outlives the dead peer's copy", () => {
    const fs = new FakeTerminalReleaseJournalFileSystem();
    fs.files.set(peer, line("shared", "heartbeat-timeout", 1) + line("theirs", "device-killed", 2));
    const journal = open(fs);
    journal.record({ sessionId: "shared", reason: "explicit-release", at: 9 });

    expect(journal.adoptDeadDaemon("live-peer")).toEqual([
      { sessionId: "theirs", reason: "device-killed", at: 2 },
    ]);
    expect(open(fs, ["self"]).loadUnconfirmed()).toEqual([
      { sessionId: "shared", reason: "explicit-release", at: 9 },
      { sessionId: "theirs", reason: "device-killed", at: 2 },
    ]);
  });

  test("an unreadable dead peer journal reports undefined so the caller retries", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const fs = new FakeTerminalReleaseJournalFileSystem();
      fs.files.set(peer, line("peer-session", "heartbeat-timeout", 1));
      const journal = open(fs);
      journal.loadUnconfirmed();

      fs.failReads = new Error("EIO");
      expect(journal.adoptDeadDaemon("live-peer")).toBeUndefined();
      expect(fs.files.has(peer)).toBe(true);

      fs.failReads = undefined;
      expect(journal.adoptDeadDaemon("live-peer")).toEqual([
        { sessionId: "peer-session", reason: "heartbeat-timeout", at: 1 },
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a failed durable append still fences the adopted intents and keeps the dead file", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const fs = new FakeTerminalReleaseJournalFileSystem();
      fs.files.set(peer, line("peer-session", "heartbeat-timeout", 1));
      const journal = open(fs);
      fs.failNextAppend = new Error("ENOSPC");

      expect(journal.adoptDeadDaemon("live-peer")).toEqual([
        { sessionId: "peer-session", reason: "heartbeat-timeout", at: 1 },
      ]);
      expect(fs.files.get(peer)).toBe(line("peer-session", "heartbeat-timeout", 1));
    } finally {
      warn.mockRestore();
    }
  });

  test("a journal opened without a data directory adopts no peer", () => {
    const fs = new FakeTerminalReleaseJournalFileSystem();
    fs.files.set(peer, line("peer-session", "heartbeat-timeout", 1));

    expect(new FileTerminalReleaseJournal(own, fs).adoptDeadDaemon("live-peer")).toEqual([]);
    expect(fs.files.has(peer)).toBe(true);
  });
});
