import { constants } from "node:fs";
import { lstat, open, mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../../utils/logger";
import type { BundleCommitFileSystem } from "./bundleCommit";

/** App-private parent + fresh stage, never a user-controlled extraction destination. */
export class NodeBundleCommitFileSystem implements BundleCommitFileSystem {
  async assertRealDirectory(path: string): Promise<void> {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Not a real directory: ${path}`);
    }
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const opened = await handle.stat();
      if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
        throw new Error(`Directory changed while opening: ${path}`);
      }
    } finally {
      await handle.close();
    }
  }
  async assertAbsent(path: string): Promise<void> {
    try {
      await lstat(path);
    } catch (error) {
      // ENOENT is the required fresh-destination condition, including dangling-symlink protection.
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        logger.debug("Bundle destination is fresh", { path });
        return;
      }
      logger.warn("Cannot inspect bundle destination", error);
      throw error;
    }
    throw new Error(`Bundle destination already exists: ${path}`);
  }
  async makeStagingDirectory(parent: string, mode: number): Promise<string> {
    if (mode !== 0o700) {
      throw new Error("Bundle staging requires mode 0700");
    }
    // mkdtemp creates the fresh directory with mode 0700, tightened further by the caller umask.
    return mkdtemp(join(parent, ".bundle-"));
  }
  async mkdir(path: string, mode: number): Promise<void> {
    await mkdir(path, { mode });
  }
  async writeExclusiveNoFollow(path: string, bytes: Uint8Array): Promise<void> {
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
  }
  async rename(from: string, to: string): Promise<void> {
    await rename(from, to);
  }
  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }
}
