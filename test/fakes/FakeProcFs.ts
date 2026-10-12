import type { ProcFs } from "../../src/features/bootAdmission/procProcessTable";

/** In-memory procfs; no host filesystem access. */
export class FakeProcFs implements ProcFs {
  entries: string[] = [];
  files = new Map<string, string | Error>();
  listError: Error | undefined;
  readonly reads: string[] = [];
  activeReads = 0;
  maxActiveReads = 0;
  onRead: ((path: string) => Promise<void>) | undefined;

  async listEntries(): Promise<string[]> {
    if (this.listError) {
      throw this.listError;
    }
    return [...this.entries];
  }

  async readText(path: string): Promise<string> {
    this.reads.push(path);
    this.activeReads += 1;
    this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);
    try {
      await this.onRead?.(path);
      const value = this.files.get(path);
      if (value instanceof Error) {
        throw value;
      }
      if (value === undefined) {
        throw Object.assign(new Error("process exited"), { code: "ENOENT" });
      }
      return value;
    } finally {
      this.activeReads -= 1;
    }
  }
}
