import type { ChecksumCalculator, Sha256Source } from "../../src/utils/ChecksumCalculator";

export class FakeChecksumCalculator implements ChecksumCalculator {
  public checksum: string = "fake-checksum";
  public checksumSource: Sha256Source = "node";
  public computedFiles: string[] = [];
  public shouldThrow: Error | null = null;
  private perFile = new Map<string, string>();
  private unreadable = new Set<string>();
  /**
   * When true, an unregistered path digests to something derived from the path
   * instead of the shared `checksum`, so distinct fixtures are distinct files.
   * Off by default to preserve the single-value behaviour existing suites rely on.
   */
  public distinctPerFile: boolean = false;

  /**
   * Give one path its own digest, for tests that need two files to compare
   * equal or unequal by content. Paths left unset keep returning `checksum`.
   */
  public setFileChecksum(filePath: string, checksum: string): void {
    this.perFile.set(filePath, checksum);
  }

  /** Make a single path fail, as an unlinked or truncated file would. */
  public setUnreadable(filePath: string): void {
    this.unreadable.add(filePath);
  }

  public async computeFileSha256(
    filePath: string,
  ): Promise<{ checksum: string; source: Sha256Source }> {
    if (this.shouldThrow) {
      throw this.shouldThrow;
    }
    if (this.unreadable.has(filePath)) {
      throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
    }
    this.computedFiles.push(filePath);
    const fallback = this.distinctPerFile ? `sha256(${filePath})` : this.checksum;
    return { checksum: this.perFile.get(filePath) ?? fallback, source: this.checksumSource };
  }
}
