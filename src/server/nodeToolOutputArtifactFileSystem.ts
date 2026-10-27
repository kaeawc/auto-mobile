import fs from "node:fs";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { sortedReaddirEntriesSync } from "../utils/io";

const SECURE_TOOL_OUTPUT_DIR_MODE = 0o700;

export interface ToolOutputArtifactFileSystem {
  ensureDirectory(dirPath: string): void;
  assertWritableDirectory(dirPath: string): void;
  writeFileExclusive(filePath: string, content: string, mode: number): void;
  listFiles(dirPath: string): ToolOutputArtifactDirectoryEntry[];
  deleteFile(filePath: string): void;
}

export interface ToolOutputArtifactDirectoryEntry {
  path: string;
  name: string;
  isFile: boolean;
  mtimeMs: number;
}

export class NodeToolOutputArtifactFileSystem implements ToolOutputArtifactFileSystem {
  ensureDirectory(dirPath: string): void {
    fs.mkdirSync(dirPath, { recursive: true, mode: SECURE_TOOL_OUTPUT_DIR_MODE });
  }

  assertWritableDirectory(dirPath: string): void {
    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) {
      throw new Error(`Artifact output path is not a directory: ${dirPath}`);
    }
    fs.accessSync(dirPath, fsConstants.W_OK);
  }

  writeFileExclusive(filePath: string, content: string, mode: number): void {
    fs.writeFileSync(filePath, content, { encoding: "utf8", flag: "wx", mode });
  }

  listFiles(dirPath: string): ToolOutputArtifactDirectoryEntry[] {
    return sortedReaddirEntriesSync(dirPath).map((entry) => {
      const entryPath = path.join(dirPath, entry.name);
      const stats = fs.statSync(entryPath);
      return {
        path: entryPath,
        name: entry.name,
        isFile: entry.isFile(),
        mtimeMs: stats.mtimeMs,
      };
    });
  }

  deleteFile(filePath: string): void {
    fs.unlinkSync(filePath);
  }
}
