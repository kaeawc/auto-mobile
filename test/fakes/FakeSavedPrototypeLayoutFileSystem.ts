import type { SavedPrototypeLayoutFileSystem } from "../../src/features/prototype/savedPrototypeLayout";

export class FakeSavedPrototypeLayoutFileSystem implements SavedPrototypeLayoutFileSystem {
  files = new Map<string, Uint8Array>();
  directories = new Set<string>();
  operations: string[] = [];
  failOperation?: (operation: string) => boolean;
  private record(operation: string): void {
    this.operations.push(operation);
    if (this.failOperation?.(operation)) {
      throw new Error(`Injected failure: ${operation}`);
    }
  }
  async ensureDir(path: string): Promise<void> {
    this.record(`mkdir ${path}`);
    this.directories.add(path);
  }
  async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    this.record(`write ${path}`);
    this.files.set(path, bytes.slice());
  }
  async exists(path: string): Promise<boolean> {
    this.record(`exists ${path}`);
    return (
      this.directories.has(path) ||
      [...this.files.keys()].some((key) => key === path || key.startsWith(path + "/"))
    );
  }
  async rename(from: string, to: string): Promise<void> {
    this.record(`rename ${from} ${to}`);
    for (const [path, bytes] of [...this.files]) {
      if (path === from || path.startsWith(from + "/")) {
        this.files.delete(path);
        this.files.set(to + path.slice(from.length), bytes);
      }
    }
    for (const path of [...this.directories]) {
      if (path === from || path.startsWith(from + "/")) {
        this.directories.delete(path);
        this.directories.add(to + path.slice(from.length));
      }
    }
  }
  async remove(path: string): Promise<void> {
    this.record(`remove ${path}`);
    for (const key of this.files.keys()) {
      if (key === path || key.startsWith(path + "/")) {
        this.files.delete(key);
      }
    }
    for (const key of this.directories) {
      if (key === path || key.startsWith(path + "/")) {
        this.directories.delete(key);
      }
    }
  }
}
