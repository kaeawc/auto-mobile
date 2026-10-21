import path from "node:path";
import type { Dirent } from "node:fs";
import type { MirrorFileSystem } from "../../src/features/prototype/savedPrototypeMirror";
import { compareCodeUnits } from "../../src/utils/io";

export class FakeMirrorFileSystem implements MirrorFileSystem {
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set<string>();
  failWrite = false;
  failWriteTo: string | undefined;
  failReadFrom: string | undefined;
  failRenameTo: string | undefined;
  async mkdir(directory: string): Promise<void> {
    this.directories.add(directory);
    const parent = path.posix.dirname(directory);
    if (parent !== directory) {
      await this.mkdir(parent);
    }
  }
  async writeFile(file: string, data: string | Uint8Array): Promise<void> {
    if (this.failWrite || (this.failWriteTo && file.endsWith(this.failWriteTo))) {
      throw new Error("write failed");
    }
    if (!this.directories.has(path.posix.dirname(file))) {
      throw new Error("missing directory");
    }
    this.files.set(file, typeof data === "string" ? new TextEncoder().encode(data) : data.slice());
  }
  async readFile(file: string): Promise<Uint8Array> {
    if (this.failReadFrom && file.endsWith(this.failReadFrom)) {
      throw Object.assign(new Error("read failed"), { code: "EIO" });
    }
    const bytes = this.files.get(file);
    if (!bytes) {
      throw Object.assign(new Error("missing file"), { code: "ENOENT" });
    }
    return bytes.slice();
  }
  async sortedReaddirEntries(directory: string): Promise<Pick<Dirent, "name" | "isDirectory">[]> {
    if (!this.directories.has(directory)) {
      throw Object.assign(new Error("missing directory"), { code: "ENOENT" });
    }
    return [
      ...new Set(
        [...this.directories, ...this.files.keys()]
          .filter((file) => file !== directory && path.posix.dirname(file) === directory)
          .map((file) => path.posix.basename(file)),
      ),
    ]
      .sort(compareCodeUnits)
      .map((name) => ({
        name,
        isDirectory: () => this.directories.has(path.posix.join(directory, name)),
      }));
  }
  async rm(target: string): Promise<void> {
    for (const file of this.files.keys()) {
      if (file === target || file.startsWith(target + path.posix.sep)) {
        this.files.delete(file);
      }
    }
    for (const directory of this.directories) {
      if (directory === target || directory.startsWith(target + path.posix.sep)) {
        this.directories.delete(directory);
      }
    }
  }
  async rename(from: string, to: string): Promise<void> {
    if (to === this.failRenameTo) {
      this.failRenameTo = undefined;
      throw new Error("rename failed");
    }
    const file = this.files.get(from);
    if (file) {
      this.files.set(to, file);
      this.files.delete(from);
      return;
    }
    if (!this.directories.has(from)) {
      throw new Error("missing directory");
    }
    if (this.directories.has(to)) {
      throw new Error("target exists");
    }
    const files = [...this.files].filter(([file]) => file.startsWith(from + path.posix.sep));
    const directories = [...this.directories].filter(
      (dir) => dir === from || dir.startsWith(from + path.posix.sep),
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
