import { promises as nodeFs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionableError } from "../models";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";

export interface FileSourcePreparationArgs {
  sourcePath?: string;
  contentText?: string;
  contentBase64?: string;
}

export interface FileSource {
  path: string;
  byteCount: number;
  cleanup?: () => Promise<void>;
}

export interface FileSourceStats {
  size: number;
  isFile(): boolean;
}

export interface FileSourceFileSystem {
  stat(path: string): Promise<FileSourceStats>;
  mkdtemp(prefix: string): Promise<string>;
  writeFileBuffer(path: string, data: Buffer): Promise<void>;
  rm(path: string): Promise<void>;
}

const defaultFileSystem: FileSourceFileSystem = {
  stat: async (path) => nodeFs.stat(path),
  mkdtemp: async (prefix) => nodeFs.mkdtemp(prefix),
  writeFileBuffer: async (path, data) => nodeFs.writeFile(path, data),
  rm: async (path) => nodeFs.rm(path, { recursive: true, force: true }),
};

export async function prepareFileSource(
  args: FileSourcePreparationArgs,
  fileSystem: FileSourceFileSystem = defaultFileSystem,
): Promise<FileSource> {
  if (args.sourcePath !== undefined) {
    const sourcePath = resolvePathFromDaemonLaunchWorkingDirectory(args.sourcePath);
    const stat = await fileSystem.stat(sourcePath);
    if (!stat.isFile()) {
      throw new ActionableError(`sourcePath is not a file: ${sourcePath}`);
    }
    return { path: sourcePath, byteCount: stat.size };
  }

  if (args.contentBase64 !== undefined) {
    const decoded = Buffer.from(args.contentBase64, "base64");
    const canonical = decoded.toString("base64");
    const unpadded = canonical.replace(/=+$/, "");
    if (
      decoded.length === 0 ||
      (args.contentBase64 !== canonical && args.contentBase64 !== unpadded)
    ) {
      throw new ActionableError("contentBase64 must be valid, non-empty base64.");
    }
  }
  const buffer =
    args.contentBase64 !== undefined
      ? Buffer.from(args.contentBase64, "base64")
      : Buffer.from(args.contentText ?? "", "utf8");
  const dir = await fileSystem.mkdtemp(join(tmpdir(), "automobile-app-file-"));
  const tempPath = join(dir, "content");
  await fileSystem.writeFileBuffer(tempPath, buffer);
  return {
    path: tempPath,
    byteCount: buffer.byteLength,
    cleanup: async () => fileSystem.rm(dir),
  };
}
