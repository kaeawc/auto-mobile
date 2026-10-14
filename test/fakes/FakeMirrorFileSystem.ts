import path from "node:path";
import type { MirrorFileSystem } from "../../src/features/prototype/savedPrototypeMirror";

export class FakeMirrorFileSystem implements MirrorFileSystem {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>();
  failWrite = false;
  failRenameTo: string | undefined;
  async mkdir(directory: string): Promise<void> {
    this.directories.add(directory);
    const parent = path.dirname(directory);
    if (parent !== directory) {
      await this.mkdir(parent);
    }
  }
  async writeFile(file: string, data: string | Uint8Array): Promise<void> {
    if (this.failWrite) {
      throw new Error("write failed");
    }
    if (!this.directories.has(path.dirname(file))) {
      throw new Error("missing directory");
    }
    this.files.set(file, typeof data === "string" ? new TextEncoder().encode(data) : data.slice());
  }
  async readFile(file: string): Promise<Uint8Array> {
    const bytes = this.files.get(file);
    if (!bytes) {
      throw new Error("missing file");
    }
    return bytes.slice();
  }
  async readdir(directory: string): Promise<string[]> {
    if (!this.directories.has(directory)) {
      throw Object.assign(new Error("missing directory"), { code: "ENOENT" });
    }
    return [
      ...new Set(
        [...this.directories, ...this.files.keys()]
          .filter((file) => file !== directory && path.dirname(file) === directory)
          .map((file) => path.basename(file)),
      ),
    ];
  }
  async rm(target: string): Promise<void> {
    for (const file of this.files.keys()) {
      if (file === target || file.startsWith(target + path.sep)) {
        this.files.delete(file);
      }
    }
    for (const directory of this.directories) {
      if (directory === target || directory.startsWith(target + path.sep)) {
        this.directories.delete(directory);
      }
    }
  }
  async rename(from: string, to: string): Promise<void> {
    if (to === this.failRenameTo) {
      this.failRenameTo = undefined;
      throw new Error("rename failed");
    }
    if (!this.directories.has(from)) {
      throw new Error("missing directory");
    }
    if (this.directories.has(to)) {
      throw new Error("target exists");
    }
    const files = [...this.files].filter(([file]) => file.startsWith(from + path.sep));
    const directories = [...this.directories].filter(
      (dir) => dir === from || dir.startsWith(from + path.sep),
    );
    await this.rm(from);
    for (const [file, bytes] of files) {
      this.files.set(to + file.slice(from.length), bytes);
    }
    for (const directory of directories) {
      this.directories.add(to + directory.slice(from.length));
    }
  }
}
