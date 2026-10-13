import { basename, dirname } from "node:path";
import type { LockFileSystem } from "../../src/utils/lockFileSystem";

interface FileNode {
  ino: number;
  mtimeMs: number;
  raw: string;
}

/** In-memory POSIX namespace, including inode-preserving links, renames and descriptors. */
export class FakeLockFileSystem implements LockFileSystem {
  private readonly files = new Map<string, FileNode>();
  private readonly directories = new Set<string>(["/", "."]);
  private readonly descriptors = new Map<number, FileNode>();
  private nextInode = 1;
  private nextDescriptor = 1;
  readonly operations: { op: keyof LockFileSystem; path: string }[] = [];
  failure?: (op: keyof LockFileSystem, path: string) => string | undefined;
  linkError?: string;
  openError?: string;
  writeError?: string;
  writeFileError?: string;
  closeError?: string;

  constructor(private readonly now: () => number = () => 0) {}

  private record(op: keyof LockFileSystem, path: string): void {
    this.operations.push({ op, path });
  }

  private error(code: string, path: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`${code}: ${path}`), { code });
  }

  private file(path: string): FileNode {
    const node = this.files.get(path);
    if (!node) {
      throw this.error("ENOENT", path);
    }
    return node;
  }

  private create(path: string, raw: string): FileNode {
    if (this.files.has(path)) {
      throw this.error("EEXIST", path);
    }
    if (!this.directories.has(dirname(path))) {
      throw this.error("ENOENT", path);
    }
    const node = { ino: this.nextInode++, mtimeMs: this.now(), raw };
    this.files.set(path, node);
    return node;
  }

  /** Fixture setup with an explicit historical mtime. */
  seed(path: string, raw: string, mtimeMs = this.now()): void {
    this.mkdir(dirname(path));
    this.files.set(path, { ino: this.nextInode++, mtimeMs, raw });
  }

  /** Fixture mutation preserving inode, like a legacy descriptor write or utimes. */
  update(path: string, raw: string, mtimeMs = this.now()): void {
    const node = this.file(path);
    node.raw = raw;
    node.mtimeMs = mtimeMs;
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  mkdir(path: string): void {
    this.record("mkdir", path);
    if (this.files.has(path)) {
      throw this.error("EEXIST", path);
    }
    let parent = path;
    while (!this.directories.has(parent)) {
      if (this.files.has(parent)) {
        throw this.error("ENOTDIR", parent);
      }
      this.directories.add(parent);
      parent = dirname(parent);
    }
  }

  list(directory: string): string[] {
    this.record("list", directory);
    if (this.files.has(directory)) {
      throw this.error("ENOTDIR", directory);
    }
    if (!this.directories.has(directory)) {
      throw this.error("ENOENT", directory);
    }
    return [...new Set([...this.files.keys(), ...this.directories])]
      .filter((path) => path !== directory && dirname(path) === directory)
      .map((path) => basename(path));
  }

  openExclusive(path: string): number {
    this.record("openExclusive", path);
    const failure = this.failure?.("openExclusive", path);
    if (failure) {
      throw this.error(failure, path);
    }
    if (this.files.has(path)) {
      throw this.error("EEXIST", path);
    }
    if (this.openError) {
      throw this.error(this.openError, path);
    }
    const node = this.create(path, "");
    const fd = this.nextDescriptor++;
    this.descriptors.set(fd, node);
    return fd;
  }

  write(fd: number, content: string): void {
    this.record("write", String(fd));
    if (this.writeError) {
      throw this.error(this.writeError, String(fd));
    }
    const node = this.descriptors.get(fd);
    if (!node) {
      throw this.error("EBADF", String(fd));
    }
    node.raw = content;
    node.mtimeMs = this.now();
  }

  close(fd: number): void {
    this.record("close", String(fd));
    if (!this.descriptors.delete(fd)) {
      throw this.error("EBADF", String(fd));
    }
    if (this.closeError) {
      throw this.error(this.closeError, String(fd));
    }
  }

  writeFile(path: string, content: string): void {
    this.record("writeFile", path);
    const failure = this.failure?.("writeFile", path);
    if (failure) {
      throw this.error(failure, path);
    }
    if (this.writeFileError) {
      throw this.error(this.writeFileError, path);
    }
    this.create(path, content);
  }

  readText(path: string): string {
    this.record("readText", path);
    return this.file(path).raw;
  }

  stat(path: string): { ino: number; mtimeMs: number } {
    this.record("stat", path);
    const { ino, mtimeMs } = this.file(path);
    return { ino, mtimeMs };
  }

  rename(from: string, to: string): void {
    this.record("rename", from);
    const failure = this.failure?.("rename", from);
    if (failure) {
      throw this.error(failure, from);
    }
    const node = this.file(from);
    if (!this.directories.has(dirname(to))) {
      throw this.error("ENOENT", to);
    }
    if (from === to) {
      return;
    }
    this.files.set(to, node); // POSIX rename replaces an existing destination.
    this.files.delete(from);
  }

  link(from: string, to: string): void {
    this.record("link", to);
    const failure = this.failure?.("link", to);
    if (failure) {
      throw this.error(failure, to);
    }
    if (this.linkError) {
      throw this.error(this.linkError, to);
    }
    const node = this.file(from);
    if (this.files.has(to)) {
      throw this.error("EEXIST", to);
    }
    if (!this.directories.has(dirname(to))) {
      throw this.error("ENOENT", to);
    }
    this.files.set(to, node);
  }

  unlink(path: string): void {
    this.record("unlink", path);
    const failure = this.failure?.("unlink", path);
    if (failure) {
      throw this.error(failure, path);
    }
    if (!this.files.delete(path)) {
      throw this.error("ENOENT", path);
    }
  }

  exists(path: string): boolean {
    this.record("exists", path);
    return this.files.has(path) || this.directories.has(path);
  }
}
