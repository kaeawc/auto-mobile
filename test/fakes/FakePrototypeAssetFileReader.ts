import type { PrototypeAssetFileReader } from "../../src/features/prototype/prototypeAssetUploader";

/** A Node-style fs error carrying `code`, as the real reader's rejections do. */
function fsError(code: string, message: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}, '${path}'`), { code });
}

/** In-memory prototype asset reader; records reads so tests can prove nothing touched disk. */
export class FakePrototypeAssetFileReader implements PrototypeAssetFileReader {
  private readonly files = new Map<string, Buffer>();
  private readonly directories = new Set<string>();
  readonly reads: string[] = [];

  addFile(path: string, bytes: Buffer): this {
    this.files.set(path, Buffer.from(bytes));
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
    throw fsError("ENOENT", "no such file or directory", path);
  }

  async readFile(path: string): Promise<Buffer> {
    this.reads.push(path);
    const file = this.files.get(path);
    if (file === undefined) {
      throw this.directories.has(path)
        ? fsError("EISDIR", "illegal operation on a directory, read", path)
        : fsError("ENOENT", "no such file or directory", path);
    }
    // Fresh copy per read, like fs.readFile: a caller mutating it cannot corrupt storage.
    return Buffer.from(file);
  }
}
