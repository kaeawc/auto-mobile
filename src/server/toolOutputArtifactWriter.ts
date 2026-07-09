import fs from "node:fs";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { toActionableError } from "../models/ActionableError";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { stringifyToolResponse } from "../utils/toolUtils";
import type {
  ObservationArtifactMetadata,
  ObservationArtifactWriter,
  ObservationArtifactWriteInput,
} from "./finalizeToolResponse";

export interface ToolOutputArtifactFileSystem {
  ensureDirectory(dirPath: string): void;
  assertWritableDirectory(dirPath: string): void;
  writeFileExclusive(filePath: string, content: string, mode: number): void;
}

export class NodeToolOutputArtifactFileSystem implements ToolOutputArtifactFileSystem {
  ensureDirectory(dirPath: string): void {
    fs.mkdirSync(dirPath, { recursive: true });
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
}

export interface JsonToolOutputArtifactWriterOptions {
  outputDirectory: string;
  fileSystem?: ToolOutputArtifactFileSystem;
  idGenerator?: IdGenerator;
  timer?: Timer;
}

export class JsonToolOutputArtifactWriter implements ObservationArtifactWriter {
  private readonly outputDirectory: string;
  private readonly fileSystem: ToolOutputArtifactFileSystem;
  private readonly idGenerator: IdGenerator;
  private readonly timer: Timer;

  constructor(options: JsonToolOutputArtifactWriterOptions) {
    this.outputDirectory = path.resolve(options.outputDirectory);
    this.fileSystem = options.fileSystem ?? new NodeToolOutputArtifactFileSystem();
    this.idGenerator = options.idGenerator ?? defaultIdGenerator;
    this.timer = options.timer ?? defaultTimer;
  }

  writeJsonArtifact(input: ObservationArtifactWriteInput): ObservationArtifactMetadata {
    try {
      this.fileSystem.ensureDirectory(this.outputDirectory);
      this.fileSystem.assertWritableDirectory(this.outputDirectory);

      const content = stringifyToolResponse(input.data);
      const filename = `${Math.trunc(this.timer.now())}-${safeFilenameSegment(input.tool)}-${safeFilenameSegment(this.idGenerator.next())}.json`;
      const artifactPath = path.join(this.outputDirectory, filename);
      this.fileSystem.writeFileExclusive(artifactPath, content, 0o600);

      return {
        artifact: {
          path: artifactPath,
          format: "json",
          payload: input.payload,
          bytes: Buffer.byteLength(content, "utf8"),
          tool: input.tool,
        },
      };
    } catch (error) {
      throw toActionableError(error, `Failed to write ${input.payload} artifact for ${input.tool}`);
    }
  }
}

function safeFilenameSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "artifact";
}
