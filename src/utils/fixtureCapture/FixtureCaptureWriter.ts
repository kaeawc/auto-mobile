import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { errorMessage } from "../describeUnknownError";
import { createTimestampedId, defaultIdGenerator, type IdGenerator } from "../IdGenerator";
import { logger } from "../logger";
import type { Timer } from "../SystemTimer";
import {
  CAPTURE_COMMANDS_FILE,
  CAPTURE_PROVENANCE_FILE,
  type ToolCallCapture,
} from "./fixtureCaptureFormat";

/** Persists one tool call's capture. Never throws: capture must not fail the tool call. */
export interface FixtureCaptureWriter {
  write(capture: ToolCallCapture): Promise<void>;
}

/** The two filesystem calls the directory writer makes. */
export interface CaptureFileSystem {
  mkdir(dir: string, options: { recursive: true }): Promise<unknown>;
  writeFile(file: string, contents: string): Promise<void>;
}

const nodeCaptureFileSystem: CaptureFileSystem = {
  mkdir: (dir, options) => fsPromises.mkdir(dir, options),
  writeFile: (file, contents) => fsPromises.writeFile(file, contents),
};

/** Tool names are registry identifiers, but keep the directory name portable regardless. */
function directoryToken(toolName: string): string {
  return toolName.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Writes `<root>/<tool>_<ms>_<id>/{provenance,commands}.json`. */
export class DirectoryFixtureCaptureWriter implements FixtureCaptureWriter {
  constructor(
    private readonly root: string,
    private readonly timer: Pick<Timer, "now">,
    private readonly idGenerator: IdGenerator = defaultIdGenerator,
    private readonly fs: CaptureFileSystem = nodeCaptureFileSystem,
  ) {}

  async write(capture: ToolCallCapture): Promise<void> {
    const name = createTimestampedId(
      directoryToken(capture.provenance.tool.name),
      this.timer,
      this.idGenerator,
    );
    const dir = path.join(this.root, name);
    try {
      await this.fs.mkdir(dir, { recursive: true });
      await this.fs.writeFile(
        path.join(dir, CAPTURE_PROVENANCE_FILE),
        `${JSON.stringify(capture.provenance, null, 2)}\n`,
      );
      await this.fs.writeFile(
        path.join(dir, CAPTURE_COMMANDS_FILE),
        `${JSON.stringify(capture.commands, null, 2)}\n`,
      );
    } catch (error) {
      // Opt-in diagnostics must never fail the tool call; leave a trace and carry on.
      logger.warn(`Failed to write fixture capture to ${dir}: ${errorMessage(error)}`);
    }
  }
}
