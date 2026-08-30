import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { toActionableError } from "../models/ActionableError";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { stringifyToolResponse } from "../utils/toolUtils";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";
import { logger } from "../utils/logger";
import { buildToolOutputResourceUri } from "./toolOutputResources";
import {
  toolOutputArtifactLedger,
  type ToolOutputArtifactLedger,
} from "./toolOutputArtifactLedger";
import type {
  ObservationArtifactMetadata,
  ObservationArtifactWriter,
  ObservationArtifactWriteInput,
} from "./finalizeToolResponse";

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
    return fs.readdirSync(dirPath, { withFileTypes: true }).map((entry) => {
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

export interface ToolOutputArtifactRetention {
  maxAgeMs: number;
  maxFiles: number;
  overflowMinAgeMs: number;
}

export interface JsonToolOutputArtifactWriterOptions {
  outputDirectory: string;
  fileSystem?: ToolOutputArtifactFileSystem;
  idGenerator?: IdGenerator;
  timer?: Timer;
  retention?: ToolOutputArtifactRetention;
  ledger?: ToolOutputArtifactLedger;
}

export class JsonToolOutputArtifactWriter implements ObservationArtifactWriter {
  private readonly outputDirectory: string;
  private readonly fileSystem: ToolOutputArtifactFileSystem;
  private readonly idGenerator: IdGenerator;
  private readonly timer: Timer;
  private readonly retention: ToolOutputArtifactRetention | undefined;
  private readonly ledger: ToolOutputArtifactLedger;

  constructor(options: JsonToolOutputArtifactWriterOptions) {
    this.outputDirectory = resolvePathFromDaemonLaunchWorkingDirectory(options.outputDirectory);
    this.fileSystem = options.fileSystem ?? new NodeToolOutputArtifactFileSystem();
    this.idGenerator = options.idGenerator ?? defaultIdGenerator;
    this.timer = options.timer ?? defaultTimer;
    this.retention = options.retention;
    // Default to the process-wide ledger the tool-output resource reads from, so
    // an artifact this writer creates is fetchable in-band (issue #5917).
    this.ledger = options.ledger ?? toolOutputArtifactLedger;
  }

  writeJsonArtifact(input: ObservationArtifactWriteInput): ObservationArtifactMetadata {
    try {
      this.fileSystem.ensureDirectory(this.outputDirectory);
      this.fileSystem.assertWritableDirectory(this.outputDirectory);
      this.pruneOldArtifacts();

      const content = stringifyToolResponse(input.data);
      const filename = `${Math.trunc(this.timer.now())}-${safeFilenameSegment(input.tool)}-${safeFilenameSegment(this.idGenerator.next())}.json`;
      const artifactPath = path.join(this.outputDirectory, filename);
      this.fileSystem.writeFileExclusive(artifactPath, content, 0o600);
      // Record provenance (path + content hash) so the resource serves only the
      // exact bytes we wrote: it re-hashes what it reads and rejects any later
      // replacement at that path — symlink, regular-file swap, or inode-reuse
      // alias — in a world-writable --tool-outputs-dir (#5917).
      const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
      this.ledger.record(artifactPath, sha256);

      return {
        artifact: {
          path: artifactPath,
          format: "json",
          payload: input.payload,
          bytes: Buffer.byteLength(content, "utf8"),
          tool: input.tool,
          // Companion in-protocol fetch for the host `path` (issue #5882): a
          // remote MCP client reads the raw JSON via this `automobile:` resource.
          resourceUri: buildToolOutputResourceUri(filename),
        },
      };
    } catch (error) {
      throw toActionableError(error, `Failed to write ${input.payload} artifact for ${input.tool}`);
    }
  }

  private pruneOldArtifacts(): void {
    const retention = this.retention;
    if (!retention) {
      return;
    }

    try {
      const nowMs = this.timer.now();
      const candidates = this.fileSystem
        .listFiles(this.outputDirectory)
        .filter((entry) => entry.isFile && entry.name.endsWith(".json"))
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      const expired = candidates.filter((entry) => nowMs - entry.mtimeMs > retention.maxAgeMs);
      const expiredPaths = new Set(expired.map((entry) => entry.path));
      const remainingCount = candidates.length - expiredPaths.size;
      const overflowCount = Math.max(0, remainingCount - retention.maxFiles);
      const overflow = candidates
        .filter((entry) => !expiredPaths.has(entry.path))
        .filter((entry) => nowMs - entry.mtimeMs > retention.overflowMinAgeMs)
        .slice(0, overflowCount);
      const filesToDelete = new Set([...expired, ...overflow].map((entry) => entry.path));

      for (const filePath of filesToDelete) {
        this.fileSystem.deleteFile(filePath);
        // Keep provenance in lockstep so a pruned file stops resolving (#5917).
        this.ledger.forget(filePath);
      }
    } catch (error) {
      logger.warn(`Failed to prune old tool output artifacts: ${error}`, error);
    }
  }
}

function safeFilenameSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "artifact";
}
