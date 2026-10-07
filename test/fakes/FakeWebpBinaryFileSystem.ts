import type { WebpBinaryFileSystem } from "../../src/utils/image/webp/WebpBinaryResolver";

/** In-memory {@link WebpBinaryFileSystem}: only paths marked executable resolve. */
export class FakeWebpBinaryFileSystem implements WebpBinaryFileSystem {
  readonly executables = new Set<string>();
  readonly ensuredDirectories: string[] = [];
  readonly madeExecutable: string[] = [];

  addExecutable(filePath: string): void {
    this.executables.add(filePath);
  }

  async isExecutableFile(filePath: string): Promise<boolean> {
    return this.executables.has(filePath);
  }

  async ensureDirectory(dirPath: string): Promise<void> {
    this.ensuredDirectories.push(dirPath);
  }

  async makeExecutable(filePath: string): Promise<void> {
    this.madeExecutable.push(filePath);
  }
}
