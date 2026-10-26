import { open, readFile, readlink, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { sortedReaddirEntries } from "../../utils/io";
import { logger } from "../../utils/logger";
import type { CloneRelocationFileSystem, CloneRelocationScan } from "./SimulatorCloneRelocator";

const READ_CHUNK_BYTES = 1024 * 1024;
const SCAN_BATCH = 32;

/** Whether the file contains `needle`, reading in bounded chunks that overlap by one needle. */
async function fileContainsBytes(path: string, needle: Buffer): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES + needle.length - 1);
    let carried = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, carried, READ_CHUNK_BYTES, null);
      if (bytesRead === 0) {
        return false;
      }
      const filled = carried + bytesRead;
      if (chunk.subarray(0, filled).includes(needle)) {
        return true;
      }
      carried = Math.min(needle.length - 1, filled);
      chunk.copy(chunk, 0, filled - carried, filled);
    }
  } finally {
    await handle.close();
  }
}

export class NodeCloneRelocationFileSystem implements CloneRelocationFileSystem {
  async scan(
    root: string,
    needle: string,
    skipDirs: readonly string[],
    signal?: AbortSignal,
  ): Promise<CloneRelocationScan> {
    const needleBytes = Buffer.from(needle);
    const skipped = new Set(skipDirs.map((dir) => join(root, dir)));
    const files: string[] = [];
    const links: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      signal?.throwIfAborted();
      const entries = await sortedReaddirEntries(directory);
      const subdirectories: string[] = [];
      const regularFiles: string[] = [];
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          if ((await readlink(path)).includes(needle)) {
            links.push(path);
          }
        } else if (entry.isDirectory()) {
          if (!skipped.has(path)) {
            subdirectories.push(path);
          }
        } else if (entry.isFile()) {
          regularFiles.push(path);
        }
      }
      for (let start = 0; start < regularFiles.length; start += SCAN_BATCH) {
        const batch = regularFiles.slice(start, start + SCAN_BATCH);
        const hits = await Promise.all(batch.map((path) => fileContainsBytes(path, needleBytes)));
        files.push(...batch.filter((_, index) => hits[index]));
      }
      for (const subdirectory of subdirectories) {
        await walk(subdirectory);
      }
    };
    await walk(root);
    return { files, links };
  }

  async exists(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        // A WAL without its database is an orphan; there is nothing to checkpoint.
        logger.debug(`no database beside ${path}`);
        return false;
      }
      throw error;
    }
  }

  fileContains(path: string, needle: string): Promise<boolean> {
    return fileContainsBytes(path, Buffer.from(needle));
  }

  async replaceInFile(path: string, from: string, to: string): Promise<void> {
    const needle = Buffer.from(from);
    const replacement = Buffer.from(to);
    if (needle.length !== replacement.length) {
      throw new Error(`Refusing a length-changing rewrite of ${relative(".", path)}`);
    }
    const content = await readFile(path);
    let index = content.indexOf(needle);
    if (index < 0) {
      return;
    }
    while (index >= 0) {
      replacement.copy(content, index);
      index = content.indexOf(needle, index + needle.length);
    }
    await writeFile(path, content);
  }

  async retargetLink(path: string, from: string, to: string): Promise<void> {
    const target = (await readlink(path)).split(from).join(to);
    await unlink(path);
    await symlink(target, path);
  }
}
