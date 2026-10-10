import type { PrototypeAssetFileReader } from "../../src/features/prototype/prototypeAssetUploader";

/** In-memory prototype asset reader; records reads so tests can prove nothing touched disk. */
export class FakePrototypeAssetFileReader implements PrototypeAssetFileReader {
  private readonly files = new Map<string, Buffer>();
  private readonly directories = new Set<string>();
  readonly reads: string[] = [];

  addFile(path: string, bytes: Buffer): this {
    this.files.set(path, bytes);
    return this;
  }

  addDirectory(path: string): this {
    this.directories.add(path);
    return this;
  }

  async stat(path: string): Promise<{ isFile(): boolean; size: number }> {
    const file = this.files.get(path);
    if (file !== undefined) {
      return { isFile: () => true, size: file.length };
    }
    if (this.directories.has(path)) {
      return { isFile: () => false, size: 0 };
    }
    throw new Error(`ENOENT: no such file or directory, '${path}'`);
  }

  async readFile(path: string): Promise<Buffer> {
    this.reads.push(path);
    const file = this.files.get(path);
    if (file === undefined) {
      throw new Error(`ENOENT: no such file or directory, '${path}'`);
    }
    return file;
  }
}
