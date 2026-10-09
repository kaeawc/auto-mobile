import type { TerminalReleaseJournalFileSystem } from "../../src/daemon/terminalReleaseJournal";

/** In-memory durable file store; contents survive a "crash" because tests share the instance. */
export class FakeTerminalReleaseJournalFileSystem implements TerminalReleaseJournalFileSystem {
  readonly files = new Map<string, string>();
  readonly appends: string[] = [];
  replaces = 0;
  /** While set, the next append throws this (a full disk). */
  failNextAppend: Error | undefined;

  readText(filePath: string): string | undefined {
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
    this.replaces++;
    this.files.set(filePath, text);
  }

  remove(filePath: string): void {
    this.files.delete(filePath);
  }
}
