import type { ScreenshotFileWriter } from "../../src/features/observe/screenshot/ScreenshotFileWriter";

/**
 * Records capture writes/removals instead of touching disk, and lets a test run
 * a side effect (typically an abort) while a write is in flight.
 */
export class FakeScreenshotFileWriter implements ScreenshotFileWriter {
  readonly written: string[] = [];
  readonly removed: string[] = [];

  constructor(private readonly duringWrite?: () => void) {}

  async write(filePath: string, _data: Buffer): Promise<void> {
    this.written.push(filePath);
    this.duringWrite?.();
  }

  async remove(filePath: string): Promise<void> {
    this.removed.push(filePath);
  }
}
