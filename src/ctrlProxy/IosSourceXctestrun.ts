import * as fs from "fs/promises";
import * as path from "path";
import { ActionableError } from "../models/ActionableError";
import { errorMessage } from "../utils/describeUnknownError";
import { sortedReaddir } from "../utils/io";
import { logger } from "../utils/logger";

/** A build-products xctestrun, not a per-launch copy written with `runnerPrefix`. */
export function isSourceXctestrunFile(file: string, runnerPrefix: string): boolean {
  return file.endsWith(".xctestrun") && !file.startsWith(runnerPrefix);
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function listSourceXctestrunFiles(dir: string, runnerPrefix: string): Promise<string[]> {
  try {
    const files = await sortedReaddir(dir);
    return files
      .filter((file) => isSourceXctestrunFile(file, runnerPrefix))
      .map((file) => path.join(dir, file));
  } catch (error) {
    // The directory itself may be gone mid-extraction; the error then reports no candidates.
    logger.debug(`xctestrun candidate listing failed: ${errorMessage(error)}`, error);
    return [];
  }
}

/**
 * Read a selected source xctestrun. When it vanished (an extraction replaced the
 * Products directory after the lookup, #18339), fail with an ActionableError naming
 * the vanished file and the xctestrun files now in its directory, so the caller can
 * tell a stale selection from a missing bundle.
 */
export async function readSourceXctestrun(
  xctestrunPath: string,
  runnerPrefix: string,
): Promise<string> {
  try {
    return await fs.readFile(xctestrunPath, "utf-8");
  } catch (error) {
    if (!isFileNotFound(error)) {
      throw error;
    }
    const present = await listSourceXctestrunFiles(path.dirname(xctestrunPath), runnerPrefix);
    const remaining =
      present.length === 0 ? "no xctestrun remains there" : `present now: ${present.join(", ")}`;
    throw new ActionableError(
      `Selected xctestrun ${xctestrunPath} no longer exists (${remaining}). The CtrlProxy ` +
        `products were replaced after the lookup, for example by a bundle extraction over ` +
        `a local build; retry provisioning so the lookup runs again.`,
      { cause: error },
    );
  }
}
