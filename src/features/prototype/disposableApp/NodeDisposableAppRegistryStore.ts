import { promises as fs } from "node:fs";
import path from "node:path";
import { toActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../../utils/describeUnknownError";
import { defaultIdGenerator, type IdGenerator } from "../../../utils/IdGenerator";
import { logger } from "../../../utils/logger";
import { resolveAutoMobileBaseDir } from "../../../utils/tempDir";
import type { DisposableAppRegistryStore } from "./DisposableAppRegistry";

export const DISPOSABLE_APP_REGISTRY_FILE = "disposable-apps.json";

/** The registry document under the AutoMobile data dir, written atomically with owner-only mode. */
export class NodeDisposableAppRegistryStore implements DisposableAppRegistryStore {
  constructor(
    private readonly directory: () => string = resolveAutoMobileBaseDir,
    private readonly ids: IdGenerator = defaultIdGenerator,
  ) {}

  async read(): Promise<string | undefined> {
    try {
      return await fs.readFile(path.join(this.directory(), DISPOSABLE_APP_REGISTRY_FILE), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // No registry yet: nothing has been installed from this host.
        return undefined;
      }
      throw toActionableError(error, "Failed to read the disposable app registry");
    }
  }

  async write(contents: string): Promise<void> {
    const directory = this.directory();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = path.join(directory, DISPOSABLE_APP_REGISTRY_FILE);
    const temporary = `${destination}.${this.ids.next()}.tmp`;
    try {
      await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, destination);
    } finally {
      try {
        await fs.rm(temporary, { force: true });
      } catch (error) {
        // The rename already published the registry; a leftover temporary file is inert.
        logger.debug(
          `Failed to remove disposable app registry temporary file: ${errorMessage(error)}`,
        );
      }
    }
  }
}
