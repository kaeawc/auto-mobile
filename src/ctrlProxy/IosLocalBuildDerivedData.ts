import * as fs from "fs/promises";
import * as path from "path";
import { ActionableError } from "../models/ActionableError";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { type DirectoryLock, FileDirectoryLock } from "../utils/directoryLock";
import { sortedReaddir } from "../utils/io";
import type { IOSCtrlProxyBundleMetadata } from "./IosRunnerArtifactVerifier";

export type { DirectoryLock };

/** Xcode per-configuration intermediates directory for an iOS platform, e.g. `Debug-iphoneos`. */
const IOS_INTERMEDIATES_DIR = /-(iphonesimulator|iphoneos)$/;

/** Entry names in `dir`, or none when it is missing or unreadable. */
async function listDir(dir: string): Promise<string[]> {
  try {
    return await sortedReaddir(dir);
  } catch (error) {
    // A missing directory is the expected case for release-extracted or empty derived data.
    logger.debug(`[IOSCtrlProxyBuilder] No entries at ${dir}: ${errorMessage(error)}`, error);
    return [];
  }
}

/**
 * The first iOS intermediates directory a local `xcodebuild -derivedDataPath` build left in
 * `derivedDataPath` (`Build/Intermediates.noindex/<Project>.build/<Config>-iphone*`), or null.
 * A release extraction never has intermediates: the archive carries only `Build/Products`, and
 * extraction empties the directory first. Builds for other platforms (the tvOS, visionOS and
 * watchOS source-build fallbacks share this directory) do not count (#19183).
 */
export async function findLocalXcodeBuildEntry(derivedDataPath: string): Promise<string | null> {
  const intermediates = path.join(derivedDataPath, "Build", "Intermediates.noindex");
  for (const project of await listDir(intermediates)) {
    if (!project.endsWith(".build")) {
      continue;
    }
    const projectDir = path.join(intermediates, project);
    const platformDir = (await listDir(projectDir)).find((entry) =>
      IOS_INTERMEDIATES_DIR.test(entry),
    );
    if (platformDir !== undefined) {
      return path.join(projectDir, platformDir);
    }
  }
  return null;
}

/** The refusal raised instead of deleting or replacing a local iOS Xcode build. */
export function localBuildOverwriteRefusal(
  derivedDataPath: string,
  entry: string,
): ActionableError {
  return new ActionableError(
    `Refusing to replace ${derivedDataPath} with the release CtrlProxy runner: it holds a local ` +
      `iOS Xcode build (found ${entry}). Set AUTOMOBILE_CTRL_PROXY_IOS_USE_LOCAL_BUILD=true to ` +
      `use that build, point AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA at a separate directory for ` +
      `the release runner, or delete ${derivedDataPath} to reinstall the release runner.`,
  );
}

/** Whether `derivedDataPath` holds a local iOS Xcode build that must be kept; logs why. */
export async function keepsLocalXcodeBuild(derivedDataPath: string): Promise<boolean> {
  const entry = await findLocalXcodeBuildEntry(derivedDataPath);
  if (entry !== null) {
    logger.warn(`[IOSCtrlProxyBuilder] Kept local iOS Xcode build artifacts (${entry})`);
  }
  return entry !== null;
}

/** Throws {@link localBuildOverwriteRefusal} when `derivedDataPath` holds a local iOS build. */
export async function assertNoLocalXcodeBuild(derivedDataPath: string): Promise<void> {
  const entry = await findLocalXcodeBuildEntry(derivedDataPath);
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
