import * as fs from "fs";
import { sortedReaddirSync } from "./io";

/**
 * A file's identity at one instant. `ino` is a bigint because NTFS file IDs exceed
 * 2^53: as a number, two distinct files' IDs can round to the same value.
 */
export interface LockFileStat {
  ino: bigint;
  mtimeMs: number;
}

/** The number `Stats.mtimeMs` Node and Bun derive from the same timespec. */
export function mtimeMsFromNs(mtimeNs: bigint): number {
  return Number(mtimeNs / 1_000_000_000n) * 1000 + Number(mtimeNs % 1_000_000_000n) / 1e6;
}

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
  stat(path: string): LockFileStat;
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
    const { ino, mtimeNs } = fs.statSync(path, { bigint: true });
    return { ino, mtimeMs: mtimeMsFromNs(mtimeNs) };
  },
  rename: (from, to) => fs.renameSync(from, to),
  link: (from, to) => fs.linkSync(from, to),
  unlink: (path) => fs.unlinkSync(path),
  exists: (path) => fs.existsSync(path),
};
