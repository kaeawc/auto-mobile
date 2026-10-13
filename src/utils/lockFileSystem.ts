import * as fs from "fs";
import { sortedReaddirSync } from "./io";

/**
 * Synchronous operations used by the exclusive-lock protocol.
 * Every file the lock protocol creates is 0600; markers are renames of those files;
 * directories are created with the process default.
 */
export interface LockFileSystem {
  mkdir(path: string): void;
  /** Entry names, without the directory prefix. */
  list(directory: string): string[];
  openExclusive(path: string): number;
  write(fd: number, content: string): void;
  close(fd: number): void;
  /** Exclusive-create a private publication file; EEXIST leaves existing bytes untouched. */
  writeFile(path: string, content: string): void;
  readText(path: string): string;
  stat(path: string): { ino: number; mtimeMs: number };
  rename(from: string, to: string): void;
  link(from: string, to: string): void;
  unlink(path: string): void;
  exists(path: string): boolean;
}

/**
 * Resolve fs methods at call time so existing namespace spies still observe them.
 * Every file the lock protocol creates is 0600; markers are renames of those files;
 * directories are created with the process default.
 */
export const nodeLockFileSystem: LockFileSystem = {
  mkdir: (path) => {
    fs.mkdirSync(path, { recursive: true });
  },
  list: (directory) => sortedReaddirSync(directory),
  openExclusive: (path) => fs.openSync(path, "wx", 0o600),
  write: (fd, content) => fs.writeFileSync(fd, content),
  close: (fd) => fs.closeSync(fd),
  writeFile: (path, content) => fs.writeFileSync(path, content, { flag: "wx", mode: 0o600 }),
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
