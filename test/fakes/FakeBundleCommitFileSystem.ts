import { join, resolve, sep } from "node:path";
import type { BundleCommitFileSystem } from "../../src/features/prototype/prototypeBundle";

export class FakeBundleCommitFileSystem implements BundleCommitFileSystem {
  readonly operations: string[] = [];
  readonly files = new Map<string, Uint8Array>();
  readonly directories = new Set([resolve("/library")]);
  readonly symlinks = new Set<string>();
  failOn: string | undefined;
  private operation(value: string): void {
    this.operations.push(value);
    if (this.failOn === value) {
      throw new Error(`Injected ${value}`);
    }
  }
  async assertRealDirectory(path: string): Promise<void> {
    this.operation(`directory ${path}`);
    if (!this.directories.has(path) || this.symlinks.has(path)) {
      throw new Error(`Not a directory: ${path}`);
    }
  }
  async assertAbsent(path: string): Promise<void> {
    this.operation(`absent ${path}`);
    if (this.directories.has(path) || this.symlinks.has(path) || this.files.has(path)) {
      throw new Error(`Exists: ${path}`);
    }
  }
  async makeStagingDirectory(parent: string, mode: number): Promise<string> {
    this.operation(`stage ${parent} ${mode}`);
    const stage = join(parent, ".bundle-fake");
    if (this.directories.has(stage)) {
      throw new Error("Stage exists");
    }
    this.directories.add(stage);
    return stage;
  }
  async mkdir(path: string, mode: number): Promise<void> {
    this.operation(`mkdir ${path} ${mode}`);
    this.directories.add(path);
  }
  async writeExclusiveNoFollow(path: string, bytes: Uint8Array): Promise<void> {
    this.operation(`write ${path}`);
    if (this.symlinks.has(path) || this.files.has(path)) {
      throw new Error("Unsafe file");
    }
    this.files.set(path, Uint8Array.from(bytes));
  }
  async rename(from: string, to: string): Promise<void> {
    this.operation(`rename ${from} ${to}`);
    for (const path of [...this.directories]) {
      if (path === from || path.startsWith(`${from}${sep}`)) {
        this.directories.delete(path);
        this.directories.add(to + path.slice(from.length));
      }
    }
    for (const [path, bytes] of [...this.files]) {
      if (path.startsWith(`${from}${sep}`)) {
        this.files.delete(path);
        this.files.set(to + path.slice(from.length), bytes);
      }
    }
  }
  async remove(path: string): Promise<void> {
    this.operation(`remove ${path}`);
    for (const item of [...this.files.keys()]) {
      if (item.startsWith(`${path}${sep}`)) {
        this.files.delete(item);
      }
    }
    for (const item of [...this.directories]) {
      if (item === path || item.startsWith(`${path}${sep}`)) {
        this.directories.delete(item);
      }
    }
  }
}
