import fs from "node:fs";
import path from "node:path";
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
