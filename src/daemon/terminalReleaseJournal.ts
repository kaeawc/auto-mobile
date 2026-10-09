import fs from "node:fs";
import path from "node:path";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { resolveAutoMobileBaseDir } from "../utils/tempDir";

/**
 * Crash-safe record of terminal releases whose `device_sessions` write has not landed (#10959).
 *
 * A terminal release can be parked behind a wedged SQLite writer. A journal row in the same
 * database would queue behind that writer, so the intent lives in a small append-only sidecar
 * file in the daemon data directory instead: it is written (and fsync'd) BEFORE the DB write is
 * attempted and compacted away once the write lands. A daemon that crashes in between finds the
 * intent at startup and terminalizes the row before rehydrating sessions, so the released UUID is
 * never revived.
 *
 * The file is per data directory; the daemon's startup lock already keeps one daemon per data
 * directory, so there is no cross-process writer to coordinate with.
 */
export interface TerminalReleaseIntent {
  sessionId: string;
  reason: string;
  /** The release time the terminal row records (`released_at_ms`). */
  at: number;
}

export interface TerminalReleaseJournal {
  /**
   * Intents a previous daemon recorded and never confirmed. Reading also compacts a torn or
   * corrupt tail away, so later appends start on a clean line.
   */
  loadUnconfirmed(): TerminalReleaseIntent[];
  /** Durably record an intent before its terminal write is attempted. */
  record(intent: TerminalReleaseIntent): void;
  /**
   * Drop a session's intent: its terminal write landed, or its terminal fence was lifted. With
   * `reason`, only an intent for that reason is dropped, so an earlier write landing never drops
   * a later upgraded intent whose own write is still pending.
   */
  resolve(sessionId: string, reason?: string): void;
}

/** Durable file primitives the journal needs; injected so tests never touch the disk. */
export interface TerminalReleaseJournalFileSystem {
  /** The file's contents, or `undefined` when it does not exist. */
  readText(filePath: string): string | undefined;
  /** Append `text` and fsync before returning. */
  appendDurable(filePath: string, text: string): void;
  /** Replace the file's contents durably (write a sibling, fsync, rename over). */
  replaceDurable(filePath: string, text: string): void;
  /** Remove the file; a missing file is not an error. */
  remove(filePath: string): void;
}

export const TERMINAL_RELEASE_JOURNAL_FILE_NAME = "terminal-release-intents.jsonl";

/** Journal used when none is attached (unit tests of unrelated behaviour). */
export class NoopTerminalReleaseJournal implements TerminalReleaseJournal {
  loadUnconfirmed(): TerminalReleaseIntent[] {
    return [];
  }

  record(): void {}

  resolve(): void {}
}

/** A durable "fence lifted" marker: load drops the session's earlier intent (#11077). */
interface LiftedMarker {
  sessionId: string;
  lifted: true;
}

type JournalLine =
  | { kind: "intent"; intent: TerminalReleaseIntent }
  | { kind: "lifted"; sessionId: string };

function parseLine(line: string): JournalLine | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    // A torn or corrupt line carries no recoverable intent; the caller compacts it away.
    logger.debug(`[TerminalReleaseJournal] Ignoring unparsable line: ${errorMessage(error)}`);
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const fields = value as Record<string, unknown>;
  const { sessionId } = fields;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return undefined;
  }
  if (fields.lifted === true) {
    return { kind: "lifted", sessionId };
  }
  const { reason, at } = fields;
  if (typeof reason !== "string" || reason.length === 0 || !Number.isFinite(at)) {
    return undefined;
  }
  return { kind: "intent", intent: { sessionId, reason, at: at as number } };
}

/** Replay lines in order; returns whether any line was unusable. */
function replayLines(lines: string[], intents: Map<string, TerminalReleaseIntent>): boolean {
  let discarded = false;
  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed?.kind === "intent") {
      intents.set(parsed.intent.sessionId, parsed.intent);
    } else if (parsed?.kind === "lifted") {
      intents.delete(parsed.sessionId);
    } else {
      discarded = true;
    }
  }
  return discarded;
}

function serializeLifted(sessionId: string): string {
  const marker: LiftedMarker = { sessionId, lifted: true };
  return `${JSON.stringify(marker)}\n`;
}

function serialize(intent: TerminalReleaseIntent): string {
  return `${JSON.stringify({ sessionId: intent.sessionId, reason: intent.reason, at: intent.at })}\n`;
}

/**
 * Line-oriented journal. Every complete line is one JSON intent; the latest line for a session
 * wins. A final line without its newline is a write torn by a crash and is ignored, as is any
 * line that does not parse as an intent.
 */
export class FileTerminalReleaseJournal implements TerminalReleaseJournal {
  /** Intents known so far; until the file has been read, only this daemon's own (#11114). */
  private readonly intents = new Map<string, TerminalReleaseIntent>();
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly fileSystem: TerminalReleaseJournalFileSystem,
  ) {}

  loadUnconfirmed(): TerminalReleaseIntent[] {
    this.ensureLoaded();
    return Array.from(this.intents.values());
  }

  record(intent: TerminalReleaseIntent): void {
    this.ensureLoaded();
    try {
      this.fileSystem.appendDurable(this.filePath, serialize(intent));
    } catch (error) {
      // The DB write is still attempted; only its crash-safety is lost for this release.
      logger.warn(
        `[TerminalReleaseJournal] Failed to record the terminal release intent of session ` +
          `${intent.sessionId}: ${errorMessage(error)}`,
        error,
      );
    }
    this.intents.set(intent.sessionId, intent);
  }

  resolve(sessionId: string, reason?: string): void {
    // An unread file may hold a predecessor's intents this cache does not: never rewrite it from
    // the partial cache, only append the lift (#11114).
    const loaded = this.ensureLoaded();
    const intent = this.intents.get(sessionId);
    if (!intent || (reason !== undefined && intent.reason !== reason)) {
      return;
    }
    this.intents.delete(sessionId);
    if (loaded && this.compact(this.intents)) {
      return;
    }
    // Compaction failed (e.g. Windows EPERM) or is unsafe: the stale intent would terminalize a
    // live session on restart, so make the lift itself durable with an appended marker.
    try {
      this.fileSystem.appendDurable(this.filePath, serializeLifted(sessionId));
    } catch (error) {
      logger.warn(
        `[TerminalReleaseJournal] Failed to record the lifted fence of session ${sessionId}: ` +
          errorMessage(error),
        error,
      );
    }
  }

  /**
   * Reads the file once it is readable; returns whether the cache reflects it. A failed read is
   * retried on the next call rather than cached as an empty journal (#11114).
   */
  private ensureLoaded(): boolean {
    if (this.loaded) {
      return true;
    }
    let text: string | undefined;
    try {
      text = this.fileSystem.readText(this.filePath);
    } catch (error) {
      logger.warn(
        `[TerminalReleaseJournal] Failed to read ${this.filePath}; unconfirmed terminal releases ` +
          `from a previous daemon cannot be applied yet: ${errorMessage(error)}`,
        error,
      );
      return false;
    }
    this.loaded = true;
    const unread = new Map(this.intents);
    this.intents.clear();
    if (text !== undefined) {
      this.replay(text);
    }
    // This daemon's own intents are the newest; one whose append failed exists only in memory.
    for (const [sessionId, intent] of unread) {
      this.intents.set(sessionId, intent);
    }
    return true;
  }

  private replay(text: string): void {
    const lines = text.split("\n");
    // Everything after the last newline is a torn append (or empty when the file ends cleanly).
    const tornTail = lines.pop() ?? "";
    const discarded = replayLines(lines, this.intents) || tornTail.length > 0;
    if (discarded) {
      logger.warn(
        `[TerminalReleaseJournal] Discarded a torn or corrupt tail of ${this.filePath}; ` +
          `${this.intents.size} intent(s) kept`,
      );
    }
    if (discarded || lines.length !== this.intents.size) {
      this.compact(this.intents);
    }
  }

  /** Returns whether the file now reflects `intents`. */
  private compact(intents: Map<string, TerminalReleaseIntent>): boolean {
    try {
      if (intents.size === 0) {
        this.fileSystem.remove(this.filePath);
      } else {
        this.fileSystem.replaceDurable(
          this.filePath,
          Array.from(intents.values(), serialize).join(""),
        );
      }
      return true;
    } catch (error) {
      // A stale intent is harmless: startup drops it once it sees the row is already terminal.
      logger.warn(
        `[TerminalReleaseJournal] Failed to compact ${this.filePath}: ${errorMessage(error)}`,
        error,
      );
      return false;
    }
  }
}

function fsyncPath(filePath: string, flags: string): void {
  const fd = fs.openSync(filePath, flags);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Real file primitives: synchronous so the intent is on disk before the DB write is issued. */
export const nodeTerminalReleaseJournalFileSystem: TerminalReleaseJournalFileSystem = {
  readText(filePath) {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  },
  appendDurable(filePath, text) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(filePath, "a", 0o600);
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  },
  replaceDurable(filePath, text) {
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    const fd = fs.openSync(temporaryPath, "w", 0o600);
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      // libuv renames with MOVEFILE_REPLACE_EXISTING on Windows, so this replaces in place there
      // too; it fails only while another process (AV, indexer) briefly holds the target open.
      // No retry or sleep here: this runs on the daemon's event loop, so a failure surfaces at once
      // and `resolve` falls back to the durable appended `lifted` marker (#11102).
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
    if (process.platform !== "win32") {
      // Persist the rename itself; Windows cannot open a directory for fsync.
      fsyncPath(path.dirname(filePath), "r");
    }
  },
  remove(filePath) {
    fs.rmSync(filePath, { force: true });
  },
};

/** The daemon's journal: one file in its data directory. */
export function createDaemonTerminalReleaseJournal(
  dataDir: string = resolveAutoMobileBaseDir(),
): FileTerminalReleaseJournal {
  return new FileTerminalReleaseJournal(
    path.join(dataDir, TERMINAL_RELEASE_JOURNAL_FILE_NAME),
    nodeTerminalReleaseJournalFileSystem,
  );
}
