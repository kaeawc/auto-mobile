import type { ScreenshotFileWriter } from "../../src/features/observe/screenshot/ScreenshotFileWriter";

/**
 * Records capture writes/removals instead of touching disk, and lets a test run
 * a side effect (typically an abort) while a write is in flight. Models the real
 * writer's exclusive create ("wx") and idempotent remove (#11868).
 */
export class FakeScreenshotFileWriter implements ScreenshotFileWriter {
  readonly written: string[] = [];
  readonly removed: string[] = [];
  private readonly existing = new Set<string>();

  constructor(private readonly duringWrite?: () => void) {}

  /** Whether a capture currently exists at the path. */
  has(filePath: string): boolean {
    return this.existing.has(filePath);
  }

  async write(filePath: string, _data: Buffer): Promise<void> {
    if (this.existing.has(filePath)) {
      throw Object.assign(new Error(`EEXIST: file already exists, open '${filePath}'`), {
        code: "EEXIST",
      });
    }
    this.existing.add(filePath);
    this.written.push(filePath);
    this.duringWrite?.();
  }

  async remove(filePath: string): Promise<void> {
    this.existing.delete(filePath);
    this.removed.push(filePath);
  }
}
