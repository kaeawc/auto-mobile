import fs from "node:fs";
import path from "node:path";
import { ActionableError } from "../models";
import { errorMessage } from "../utils/describeUnknownError";
import { releaseExclusiveLock, tryAcquireExclusiveLock } from "../utils/fileLock";
import { defaultIdGenerator } from "../utils/IdGenerator";
import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";
import { defaultTimer } from "../utils/SystemTimer";
import { ensureSecureTempDirSync } from "../utils/tempDir";

const CLI_TOOL_SELECTION_PROFILE_FILE = "tool-selection-profile";
const CLI_TOOL_SELECTION_PROFILE_LOCK_TIMEOUT_MS = 3_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
// Shared per-process token: concurrent CLI calls in this process see a live holder,
// while a recycled PID from a prior process incarnation remains reclaimable.
const PROCESS_CLI_TOOL_SELECTION_PROFILE_LOCK_TOKEN = defaultIdGenerator.next();

export interface CliToolSelectionProfileLockOptions {
  timer?: Timer;
  pollIntervalMs?: number;
  timeoutMs?: number;
  isProcessRunning?: (pid: number) => boolean;
  pid?: number;
  ownerToken?: string;
}

let cliToolSelectionProfileLockOptionsForTesting: CliToolSelectionProfileLockOptions | undefined;

export function cliToolSelectionProfilePath(env: NodeJS.ProcessEnv): string {
  return path.join(ensureSecureTempDirSync("cli", env), CLI_TOOL_SELECTION_PROFILE_FILE);
}

export function cliToolSelectionProfileLockPath(env: NodeJS.ProcessEnv): string {
  return `${cliToolSelectionProfilePath(env)}.lock`;
}

/**
 * Test-only timer and lock seam. Production callers retain the short bounded
 * wait below; tests use FakeTimer so contention never relies on wall-clock time.
 */
export function setCliToolSelectionProfileLockOptionsForTesting(
  options: CliToolSelectionProfileLockOptions,
): void {
  cliToolSelectionProfileLockOptionsForTesting = options;
}

export function resetCliToolSelectionProfileLockOptionsForTesting(): void {
  cliToolSelectionProfileLockOptionsForTesting = undefined;
}

/**
 * Serialize CLI profile mint/re-mint decisions across CLI processes sharing a
 * data directory. The normal, already-persisted reaffirm path does not call this.
 */
export async function withCliToolSelectionProfileLock(
  operation: () => Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const lock = cliToolSelectionProfileLock(env, cliToolSelectionProfileLockOptionsForTesting ?? {});
  if (!(await lock.acquire())) {
    return false;
  }
  try {
    await operation();
  } finally {
    lock.release();
  }
  return true;
}

function cliToolSelectionProfileLock(
  env: NodeJS.ProcessEnv,
  options: CliToolSelectionProfileLockOptions,
): { acquire: () => Promise<boolean>; release: () => void } {
  const timer = options.timer ?? defaultTimer;
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  // A CLI invocation must remain responsive if a holder is wedged: availability
  // wins after three seconds because an unlocked retry only restores the old race.
  const timeoutMs = options.timeoutMs ?? CLI_TOOL_SELECTION_PROFILE_LOCK_TIMEOUT_MS;
  const lockPath = cliToolSelectionProfileLockPath(env);
  const pid = options.pid ?? process.pid;
  const ownerToken = options.ownerToken ?? PROCESS_CLI_TOOL_SELECTION_PROFILE_LOCK_TOKEN;
  const deadline = timer.now() + timeoutMs;

  return {
    acquire: async (): Promise<boolean> => {
      try {
        for (;;) {
          if (
            tryAcquireExclusiveLock(lockPath, {
              pid,
              isProcessRunning: options.isProcessRunning,
              reclaimOwnPid: true,
              ownerToken,
            })
          ) {
            return true;
          }
          if (timer.now() >= deadline) {
            return false;
          }
          await timer.sleep(Math.min(pollIntervalMs, deadline - timer.now()));
        }
      } catch (error) {
        // Lock trouble is non-fatal: the caller degrades to the pre-lock behavior.
        logger.debug(`Unable to acquire CLI tool-selection profile lock: ${errorMessage(error)}`);
        return false;
      }
    },
    release: (): void => {
      releaseExclusiveLock(lockPath, pid, ownerToken);
    },
  };
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

  let temporaryProfilePath: string | undefined;
  try {
    const profilePath = cliToolSelectionProfilePath(env);
    temporaryProfilePath = `${profilePath}.${process.pid}.${defaultIdGenerator.next()}.tmp`;
    fs.writeFileSync(temporaryProfilePath, trimmedProfileUuid, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") {
      fs.chmodSync(temporaryProfilePath, 0o600);
    }
    // Same-directory rename makes readers see either the old complete UUID or
    // the new complete UUID, never a partially written profile.
    fs.renameSync(temporaryProfilePath, profilePath);
    temporaryProfilePath = undefined;
    if (process.platform !== "win32") {
      fs.chmodSync(profilePath, 0o600);
    }
  } catch (error) {
    // A write failure is non-fatal; the next invocation can safely re-mint.
    logger.debug(`Unable to persist the CLI tool-selection profile: ${errorMessage(error)}`);
    if (temporaryProfilePath) {
      try {
        fs.unlinkSync(temporaryProfilePath);
      } catch (cleanupError) {
        logger.debug(
          `Unable to remove incomplete CLI tool-selection profile: ${errorMessage(cleanupError)}`,
        );
      }
    }
  }
}
