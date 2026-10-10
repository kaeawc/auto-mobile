import path from "node:path";
import type { TerminalReleaseJournalDirectory } from "../../src/daemon/terminalReleaseJournal";

/** In-memory durable file store; contents survive a "crash" because tests share the instance. */
export class FakeTerminalReleaseJournalFileSystem implements TerminalReleaseJournalDirectory {
  readonly files = new Map<string, string>();
  readonly appends: string[] = [];
  replaces = 0;
  /** While set, the next append throws this (a full disk). */
  failNextAppend: Error | undefined;
  /** While set, compaction (replace/remove) throws it, e.g. Windows EPERM. */
  failCompaction: Error | undefined;
  /** While set, reads throw it (e.g. EACCES or EIO). */
  failReads: Error | undefined;

  listNames(dirPath: string): string[] {
    return Array.from(this.files.keys())
      .filter((filePath) => path.dirname(filePath) === dirPath)
      .map((filePath) => path.basename(filePath));
  }

  readText(filePath: string): string | undefined {
    if (this.failReads) {
      throw this.failReads;
    }
    return this.files.get(filePath);
  }

  appendDurable(filePath: string, text: string): void {
    const failure = this.failNextAppend;
    if (failure) {
      this.failNextAppend = undefined;
      throw failure;
    }
    this.appends.push(text);
    this.files.set(filePath, (this.files.get(filePath) ?? "") + text);
  }

  replaceDurable(filePath: string, text: string): void {
    if (this.failCompaction) {
      throw this.failCompaction;
    }
    this.replaces++;
    this.files.set(filePath, text);
  }

  remove(filePath: string): void {
    if (this.failCompaction) {
      throw this.failCompaction;
    }
    this.files.delete(filePath);
  }
}
