import * as fs from "fs/promises";
import * as path from "path";
import { ActionableError } from "../models/ActionableError";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { type DirectoryLock, FileDirectoryLock } from "../utils/directoryLock";

export type { DirectoryLock };
import type { IOSCtrlProxyBundleMetadata } from "./IosRunnerArtifactVerifier";

/**
 * Entries `xcodebuild -derivedDataPath` always writes and an extracted release bundle never
 * contains: the release archive carries only `Build/Products`, and its extraction empties the
 * directory first. Any one of them means the directory holds a local Xcode build (#19183).
 */
const LOCAL_XCODE_BUILD_ENTRIES = [
  path.join("Build", "Intermediates.noindex"),
  "Logs",
  "info.plist",
  "ModuleCache.noindex",
] as const;

export type PathProbe = (target: string) => Promise<void>;

/**
 * The first local-Xcode-build entry found in `derivedDataPath`, or null when the directory is
 * missing or holds only extracted release products.
 */
export async function findLocalXcodeBuildEntry(
  derivedDataPath: string,
  probe: PathProbe = (target) => fs.access(target),
): Promise<string | null> {
  for (const entry of LOCAL_XCODE_BUILD_ENTRIES) {
    const candidate = path.join(derivedDataPath, entry);
    try {
      await probe(candidate);
      return candidate;
    } catch (error) {
      // A missing entry is the expected case for release-extracted or empty directories.
      logger.debug(
        `[IOSCtrlProxyBuilder] No local build entry at ${candidate}: ${errorMessage(error)}`,
        error,
      );
    }
  }
  return null;
}

/** The refusal raised instead of deleting or replacing a local Xcode build. */
export function localBuildOverwriteRefusal(
  derivedDataPath: string,
  entry: string,
): ActionableError {
  return new ActionableError(
    `Refusing to replace ${derivedDataPath} with the release CtrlProxy runner: it holds a local ` +
      `Xcode build (found ${entry}). Set AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD=true to use ` +
      `that build, or point AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA at a separate directory for ` +
      `the release runner.`,
  );
}

/** Whether `derivedDataPath` holds a local Xcode build that must be kept; logs why. */
export async function keepsLocalXcodeBuild(derivedDataPath: string): Promise<boolean> {
  const entry = await findLocalXcodeBuildEntry(derivedDataPath);
  if (entry !== null) {
    logger.warn(`[IOSCtrlProxyBuilder] Kept local Xcode build artifacts (${entry})`);
  }
  return entry !== null;
}

/** Throws {@link localBuildOverwriteRefusal} when `derivedDataPath` holds a local Xcode build. */
export async function assertNoLocalXcodeBuild(
  derivedDataPath: string,
  probe?: PathProbe,
): Promise<void> {
  const entry = await findLocalXcodeBuildEntry(derivedDataPath, probe);
  if (entry !== null) {
    throw localBuildOverwriteRefusal(derivedDataPath, entry);
  }
}

/** Long enough for another daemon to finish extracting the runner bundle. */
const DERIVED_DATA_PROCESS_LOCK_TIMEOUT_MS = 10 * 60_000;

/** The injected lock, or the `O_EXCL` file lock beside `derivedDataPath` (extraction empties it). */
export function processLock(
  { derivedDataProcessLock }: { derivedDataProcessLock?: DirectoryLock },
  derivedDataPath: string,
): DirectoryLock {
  if (derivedDataProcessLock) {
    return derivedDataProcessLock;
  }
  return new FileDirectoryLock({
    fileName: `.${path.basename(derivedDataPath)}.automobile-ctrl-proxy.lock`,
    description: "the iOS CtrlProxy derived-data lock",
    holderActivity:
      "Another AutoMobile daemon is installing the release runner into this derived-data directory",
    timeoutMs: DERIVED_DATA_PROCESS_LOCK_TIMEOUT_MS,
  });
}

/** What {@link installReleaseExclusively} needs from the builder. */
export interface ReleaseInstallTarget {
  derivedDataPath: string;
  lock: DirectoryLock;
  expectedChecksum(): string;
  readMetadata(): Promise<IOSCtrlProxyBundleMetadata | null>;
  /** The release xctestrun in `derivedDataPath`, or null; a cached path must be re-probed. */
  findXctestrun(): Promise<string | null>;
}

/**
 * Run `install` under the cross-process lock on the derived-data directory's parent, so daemons
 * sharing the directory install one at a time (#19183). `install` is skipped when another process
 * extracted the expected release into this directory while this one waited: extracting again
 * would only delete a runner that process may already be launching. `afterInstall` always runs
 * under the lock. `before` is the metadata read before this process downloaded.
 */
export async function installReleaseExclusively(
  target: ReleaseInstallTarget,
  before: IOSCtrlProxyBundleMetadata | null,
  install: (() => Promise<void>) | null,
  afterInstall: () => Promise<void>,
): Promise<void> {
  const lockDirectory = path.dirname(target.derivedDataPath);
  await fs.mkdir(lockDirectory, { recursive: true });
  await target.lock.withLock(lockDirectory, async () => {
    if (install !== null && !(await installedByAnotherProcess(target, before))) {
      await install();
    }
    await afterInstall();
  });
}

async function installedByAnotherProcess(
  target: ReleaseInstallTarget,
  before: IOSCtrlProxyBundleMetadata | null,
): Promise<boolean> {
  const expectedChecksum = target.expectedChecksum().toLowerCase();
  if (expectedChecksum.length === 0) {
    return false;
  }
  const current = await target.readMetadata();
  if (
    current === null ||
    current.derivedDataPath !== target.derivedDataPath ||
    current.extractedAt === before?.extractedAt ||
    current.checksum?.toLowerCase() !== expectedChecksum ||
    (await target.findXctestrun()) === null
  ) {
    return false;
  }
  logger.info(
    "[IOSCtrlProxyBuilder] Another process installed this release runner while waiting; reusing it",
    { derivedDataPath: target.derivedDataPath },
  );
  return true;
}
