import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { logger } from "../logger";
import type { EmulatorConsoleAuthTokenReader } from "./EmulatorConsoleClient";

export class FileEmulatorConsoleAuthTokenReader implements EmulatorConsoleAuthTokenReader {
  constructor(
    private readonly tokenPath: string = path.join(os.homedir(), ".emulator_console_auth_token"),
  ) {}

  async read(): Promise<string | null> {
    try {
      const content = await fs.promises.readFile(this.tokenPath, "utf-8");
      const trimmed = content.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return null;
      }
      logger.warn(
        `Failed to read emulator console auth token from ${this.tokenPath}: ${err.message}`,
      );
      return null;
    }
  }
}
