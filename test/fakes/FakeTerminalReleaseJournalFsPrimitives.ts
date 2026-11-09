import path from "node:path";
import type { TerminalReleaseJournalFsPrimitives } from "../../src/daemon/terminalReleaseJournal";

function enoent(syscall: string, target: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${target}'`), {
    code: "ENOENT",
  });
}

/**
 * In-memory `node:fs` primitives for createNodeTerminalReleaseJournalFileSystem: records every
 * fsync'd path in order so durability ordering is asserted without touching the real disk.
 */
export class FakeTerminalReleaseJournalFsPrimitives implements TerminalReleaseJournalFsPrimitives {
  readonly directories = new Set<string>();
  readonly files = new Map<string, string>();
  /** The path behind each fsync, in call order. */
  readonly syncedPaths: string[] = [];
  readonly renames: Array<[string, string]> = [];
  /** While set, every rename throws it (e.g. Windows EPERM while AV holds the target). */
  failRename: Error | undefined;
  private readonly open = new Map<number, string>();
  private nextFd = 3;

  constructor(existingDirectories: string[] = []) {
    existingDirectories.forEach((dir) => this.addDirectory(dir));
  }

  private isDirectory(dirPath: string): boolean {
    return path.dirname(dirPath) === dirPath || this.directories.has(dirPath);
  }

  private addDirectory(dirPath: string): void {
    if (!this.isDirectory(dirPath)) {
      this.addDirectory(path.dirname(dirPath));
      this.directories.add(dirPath);
    }
  }

  mkdirSync(dirPath: string): string | undefined {
    let firstMissing: string | undefined;
    for (let dir = dirPath; !this.isDirectory(dir); dir = path.dirname(dir)) {
      firstMissing = dir;
    }
    this.addDirectory(dirPath);
    return firstMissing;
  }

  openSync(filePath: string, flags: string): number {
    if (flags === "r") {
      if (!this.isDirectory(filePath) && !this.files.has(filePath)) {
        throw enoent("open", filePath);
      }
    } else {
      if (!this.isDirectory(path.dirname(filePath))) {
        throw enoent("open", filePath);
      }
      if (flags === "w" || !this.files.has(filePath)) {
        this.files.set(filePath, "");
      }
    }
    const fd = this.nextFd++;
    this.open.set(fd, filePath);
    return fd;
  }

  private pathOf(fd: number): string {
    const filePath = this.open.get(fd);
    if (filePath === undefined) {
      throw Object.assign(new Error(`EBADF: bad file descriptor ${fd}`), { code: "EBADF" });
    }
    return filePath;
  }

  writeSync(fd: number, text: string): number {
    const filePath = this.pathOf(fd);
    this.files.set(filePath, (this.files.get(filePath) ?? "") + text);
    return text.length;
  }

  fsyncSync(fd: number): void {
    this.syncedPaths.push(this.pathOf(fd));
  }

  closeSync(fd: number): void {
    this.pathOf(fd);
    this.open.delete(fd);
  }

  renameSync(from: string, to: string): void {
    this.renames.push([from, to]);
    if (this.failRename) {
      throw this.failRename;
    }
    const text = this.files.get(from);
    if (text === undefined) {
      throw enoent("rename", from);
    }
    this.files.delete(from);
    this.files.set(to, text);
  }

  rmSync(filePath: string): void {
    this.files.delete(filePath);
  }

  readFileSync(filePath: string): string {
    const text = this.files.get(filePath);
    if (text === undefined) {
      throw enoent("open", filePath);
    }
    return text;
  }

  readdirSync(dirPath: string): string[] {
    if (!this.isDirectory(dirPath)) {
      throw enoent("scandir", dirPath);
    }
    return [...this.directories, ...this.files.keys()]
      .filter((entry) => entry !== dirPath && path.dirname(entry) === dirPath)
      .map((entry) => path.basename(entry));
  }
}
