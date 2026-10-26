import { mkdir, writeFile, rename, readFile, rm } from "node:fs/promises";
import { logger } from "../../../utils/logger";
import type { IosProtoViewerFiles } from "./IosProtoViewer";
export class NodeIosProtoViewerFiles implements IosProtoViewerFiles {
  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
  async write(path: string, bytes: Uint8Array): Promise<void> {
    await writeFile(path, bytes);
  }
  async rename(from: string, to: string): Promise<void> {
    await rename(from, to);
  }
  async read(path: string): Promise<string> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        logger.debug("ProtoViewer result pending");
        return "";
      }
      throw error;
    }
  }
  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  }
}
