import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { toActionableError } from "../models/ActionableError";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";
import { logger } from "../utils/logger";
import { buildToolOutputResourceUri } from "./toolOutputResources";
import {
  buildToolOutputArtifactFilename,
  hasWriterIssuedFilenameShape,
  toolOutputArtifactLedger,
  type ToolOutputArtifactLedger,
} from "./toolOutputArtifactLedger";
import type {
  ObservationArtifactMetadata,
  ObservationArtifactWriter,
  ObservationArtifactWriteInput,
} from "./finalizeToolResponse";
import { sortedReaddirEntriesSync } from "../utils/io";

const SECURE_TOOL_OUTPUT_DIR_MODE = 0o700;
const PRUNE_INTERVAL_MS = 60_000;

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
  private directoryValidated = false;
  private lastPruneTimeMs: number | undefined;

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
      if (!this.directoryValidated) {
        this.fileSystem.ensureDirectory(this.outputDirectory);
        this.fileSystem.assertWritableDirectory(this.outputDirectory);
        this.directoryValidated = true;
      }
      this.pruneOldArtifactsIfDue();

      const content = serializeArtifactContent(input);
      const filename = buildToolOutputArtifactFilename(
        this.timer.now(),
        input.tool,
        this.idGenerator.next(),
      );
      const artifactPath = path.join(this.outputDirectory, filename);
      this.writeArtifactFile(artifactPath, content);
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
      // Re-check directory state on the next write after any failed filesystem operation.
      this.directoryValidated = false;
      throw toActionableError(error, `Failed to write ${input.payload} artifact for ${input.tool}`);
    }
  }

  /**
   * The validation cache lives for the daemon's lifetime, so the output directory
   * can be removed underneath it (a cleaned build/scratch dir). A write that fails
   * with ENOENT re-validates (recreates) the directory and retries once; any other
   * failure, or a second ENOENT, is reported as before.
   */
  private writeArtifactFile(artifactPath: string, content: string): void {
    try {
      this.fileSystem.writeFileExclusive(artifactPath, content, 0o600);
    } catch (error) {
      if (!isEnoent(error)) {
        throw error;
      }
      logger.warn(`Tool output directory missing, recreating: ${this.outputDirectory}`);
      this.directoryValidated = false;
      this.fileSystem.ensureDirectory(this.outputDirectory);
      this.fileSystem.assertWritableDirectory(this.outputDirectory);
      this.directoryValidated = true;
      this.fileSystem.writeFileExclusive(artifactPath, content, 0o600);
    }
  }

  private pruneOldArtifactsIfDue(): void {
    if (!this.retention) {
      return;
    }
    const nowMs = this.timer.now();
    if (this.lastPruneTimeMs !== undefined && nowMs - this.lastPruneTimeMs < PRUNE_INTERVAL_MS) {
      return;
    }
    this.lastPruneTimeMs = nowMs;
    this.pruneOldArtifacts();
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
        .filter((entry) => entry.isFile && this.isIssuedArtifact(entry))
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
        this.deletePrunedFile(filePath);
        // Keep provenance in lockstep so a pruned file stops resolving (#5917).
        this.ledger.forget(filePath);
      }
    } catch (error) {
      logger.warn(`Failed to prune old tool output artifacts: ${error}`, error);
    }
  }

  /**
   * Whether the prune may delete this file. The output directory can be one the
   * user chose and share with other content (`--tool-outputs-dir .`), so an
   * extension match is not enough (issue #10078): the file must be one this
   * process recorded in the ledger, or carry the writer's own filename shape
   * (which covers artifacts a previous daemon process issued).
   */
  private isIssuedArtifact(entry: ToolOutputArtifactDirectoryEntry): boolean {
    return (
      this.ledger.resolve(entry.name)?.path === entry.path ||
      hasWriterIssuedFilenameShape(entry.name)
    );
  }

  private deletePrunedFile(filePath: string): void {
    try {
      this.fileSystem.deleteFile(filePath);
    } catch (error) {
      if (!isEnoent(error)) {
        throw error;
      }
      // Another concurrent prune may already have removed this selected file.
      logger.debug(`Artifact already removed during prune: ${filePath}`);
    }
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * The bytes an artifact is persisted as.
 *
 * An artifact is advertised as the COMPLETE payload — a client that follows
 * `artifact.path`/`resourceUri` must find everything the inline response left
 * out. So the writer serializes with a plain `JSON.stringify`, deliberately NOT
 * with `stringifyToolResponse`: that serializer drops every property named
 * `extras`, which is a token saving for the daemon's INLINE observation
 * rendering and nothing more. Making it the writer's default made the artifact's
 * completeness depend on which call site happened to spill, and an extras-heavy
 * payload spilled with the very bytes that triggered the spill missing (#6870).
 *
 * `input.serialized` remains an override for a caller that has already rendered
 * the exact bytes it measured and must persist those (the CLI's pretty-printed
 * output, whose reported `bytes` has to match the file) — never a way to opt
 * back into stripping.
 */
function serializeArtifactContent(input: ObservationArtifactWriteInput): string {
  return input.serialized ?? JSON.stringify(input.data);
}
