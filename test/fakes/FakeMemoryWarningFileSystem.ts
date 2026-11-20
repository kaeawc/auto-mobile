import type { MemoryWarningFileSystem } from "../../src/features/action/IosSimulatorMemoryWarning";

/** Records each `utimes`; paths not in `existing` fail with ENOENT like the real call. */
export class FakeMemoryWarningFileSystem implements MemoryWarningFileSystem {
  readonly calls: Array<{ path: string; atime: Date; mtime: Date }> = [];
  failure: Error | undefined;

  constructor(private readonly existing: ReadonlySet<string>) {}

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    this.calls.push({ path, atime, mtime });
    if (this.failure) {
      throw this.failure;
    }
    if (!this.existing.has(path)) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, utime '${path}'`), {
        code: "ENOENT",
      });
    }
  }
}
