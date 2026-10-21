import { basename, dirname } from "node:path";
import { compareCodeUnits } from "../../src/utils/io";
import type { LockFileStat, LockFileSystem } from "../../src/utils/lockFileSystem";

interface FileNode {
  ino: number;
  mtimeMs: number;
  raw: string;
}

type Operation = keyof LockFileSystem | "copyExclusive";

/** In-memory POSIX namespace, including inode-preserving links, renames and descriptors. */
export class FakeLockFileSystem implements LockFileSystem {
  private readonly files = new Map<string, FileNode>();
  private readonly directories = new Set<string>(["/", "."]);
  private readonly descriptors = new Map<number, FileNode>();
  private nextInode = 1;
  /** Test-only: simulate filesystem inode reuse on the next created file. */
  nextInodeOverride?: number;
  private nextDescriptor = 1;
  readonly operations: { op: Operation; path: string }[] = [];
  failure?: (op: Operation, path: string) => string | undefined;
  linkError?: string;
  openError?: string;
  writeError?: string;
  writeFileError?: string;
  closeError?: string;

  constructor(private readonly now: () => number = () => 0) {}

  private record(op: Operation, path: string): void {
    this.operations.push({ op, path });
    const failure = this.failure?.(op, path);
    if (failure) {
      throw this.error(failure, path);
    }
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
    const ino = this.nextInodeOverride ?? this.nextInode++;
    this.nextInodeOverride = undefined;
    const node = { ino, mtimeMs: this.now(), raw };
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

  /**
   * A distinct `LockFileSystem` object over this same namespace: one per simulated process, so
   * state the lock keeps per filesystem object (pending back-outs) is per process. Every call
   * delegates here, so operations and injected failures are recorded/applied exactly once.
   */
  view(): LockFileSystem {
    return {
      mkdir: (path) => this.mkdir(path),
      list: (directory) => this.list(directory),
      openExclusive: (path) => this.openExclusive(path),
      write: (fd, content) => this.write(fd, content),
      close: (fd) => this.close(fd),
      writeFile: (path, content) => this.writeFile(path, content),
      readText: (path) => this.readText(path),
      stat: (path) => this.stat(path),
      rename: (from, to) => this.rename(from, to),
      link: (from, to) => this.link(from, to),
      unlink: (path) => this.unlink(path),
      exists: (path) => this.exists(path),
    };
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  /** Fixture inspection without recording an operation or injecting an I/O failure. */
  peek(path: string): Readonly<FileNode> | undefined {
    return this.files.get(path);
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
      .map((path) => basename(path))
      .sort(compareCodeUnits); // Like nodeLockFileSystem.list: entry order is deterministic.
  }

  openExclusive(path: string): number {
    this.record("openExclusive", path);
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
    // A descriptor keeps its file offset, so successive writes append like fs.writeFileSync(fd).
    node.raw += content;
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
    if (this.writeFileError) {
      throw this.error(this.writeFileError, path);
    }
    this.create(path, content);
  }

  readText(path: string): string {
    this.record("readText", path);
    return this.file(path).raw;
  }

  stat(path: string): LockFileStat {
    this.record("stat", path);
    const { ino, mtimeMs } = this.file(path);
    return { ino: BigInt(ino), mtimeMs };
  }

  rename(from: string, to: string): void {
    this.record("rename", from);
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

  copyExclusive(from: string, to: string): void {
    this.record("copyExclusive", to);
    this.create(to, this.file(from).raw);
  }

  unlink(path: string): void {
    this.record("unlink", path);
    if (!this.files.delete(path)) {
      throw this.error("ENOENT", path);
    }
  }

  exists(path: string): boolean {
    this.record("exists", path);
    return this.files.has(path) || this.directories.has(path);
  }
}
