import fs from "node:fs";
import path from "node:path";
import { ActionableError } from "../models";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { ensureSecureTempDirSync } from "../utils/tempDir";

const CLI_TOOL_SELECTION_PROFILE_FILE = "tool-selection-profile";

export function cliToolSelectionProfilePath(env: NodeJS.ProcessEnv): string {
  return path.join(ensureSecureTempDirSync("cli", env), CLI_TOOL_SELECTION_PROFILE_FILE);
}

export function loadPersistedCliToolSelectionProfile(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  try {
    const profileUuid = fs.readFileSync(cliToolSelectionProfilePath(env), "utf8").trim();
    if (profileUuid.length === 0) {
      return undefined;
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profileUuid)) {
      logger.debug(
        "Ignoring persisted CLI tool-selection profile because the file content is not a valid UUID",
      );
      return undefined;
    }
    return profileUuid;
  } catch (error) {
    // A read failure only means the next CLI invocation must mint again.
    logger.debug(`Unable to load the persisted CLI tool-selection profile: ${errorMessage(error)}`);
    return undefined;
  }
}

/**
 * Fail before minting a daemon-side profile when this CLI process cannot
 * persist its UUID for a later invocation.
 */
export function ensureCliToolSelectionProfileStoreWritable(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const profilePath = cliToolSelectionProfilePath(env);
  const storePath = path.dirname(profilePath);
  try {
    fs.accessSync(storePath, fs.constants.W_OK);
    if (fs.existsSync(profilePath)) {
      if (!fs.statSync(profilePath).isFile()) {
        throw new Error("profile path is not a regular file");
      }
      fs.accessSync(profilePath, fs.constants.W_OK);
    }
  } catch (error) {
    throw new ActionableError(
      `CLI tool-selection profile store is not writable: ${profilePath}. Fix its permissions or set AUTOMOBILE_DATA_DIR/AUTO_MOBILE_DATA_DIR to a writable directory so the CLI can persist a stable tool-selection profile across invocations.`,
      { cause: error },
    );
  }
}

export function persistCliToolSelectionProfile(
  profileUuid: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const trimmedProfileUuid = profileUuid.trim();
  if (trimmedProfileUuid.length === 0) {
    return;
  }

  try {
    const profilePath = cliToolSelectionProfilePath(env);
    fs.writeFileSync(profilePath, trimmedProfileUuid, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") {
      fs.chmodSync(profilePath, 0o600);
    }
  } catch (error) {
    // A write failure is non-fatal; the next invocation can safely re-mint.
    logger.debug(`Unable to persist the CLI tool-selection profile: ${errorMessage(error)}`);
  }
}
