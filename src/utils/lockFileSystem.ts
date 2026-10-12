import * as fs from "fs";

/** Synchronous operations used by the exclusive-lock protocol. */
export interface LockFileSystem {
  mkdir(path: string): void;
  openExclusive(path: string): number;
  write(fd: number, content: string): void;
  close(fd: number): void;
  /** Private publication tmp: truncate/overwrite leftover bytes from a recycled PID. */
  writeFile(path: string, content: string): void;
  readText(path: string): string;
  stat(path: string): { ino: number; mtimeMs: number };
  rename(from: string, to: string): void;
  link(from: string, to: string): void;
  unlink(path: string): void;
  exists(path: string): boolean;
}

/** Resolve fs methods at call time so existing namespace spies still observe them. */
export const nodeLockFileSystem: LockFileSystem = {
  mkdir: (path) => {
    fs.mkdirSync(path, { recursive: true });
  },
  openExclusive: (path) => fs.openSync(path, "wx", 0o600),
  write: (fd, content) => fs.writeFileSync(fd, content),
  close: (fd) => fs.closeSync(fd),
  writeFile: (path, content) => fs.writeFileSync(path, content, { flag: "w", mode: 0o600 }),
  readText: (path) => fs.readFileSync(path, "utf-8"),
  stat: (path) => {
    const { ino, mtimeMs } = fs.statSync(path);
    return { ino, mtimeMs };
  },
  rename: (from, to) => fs.renameSync(from, to),
  link: (from, to) => fs.linkSync(from, to),
  unlink: (path) => fs.unlinkSync(path),
  exists: (path) => fs.existsSync(path),
};
