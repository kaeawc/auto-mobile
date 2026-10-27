import { rm } from "node:fs/promises";
import { posix } from "node:path";
import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../describeUnknownError";
import { sortedReaddir, sortedReaddirEntries } from "../io";
import { logger } from "../logger";
import { PlistClient, type PlistReader } from "./PlistClient";
import { IOS_SIMULATOR_UUID_PATTERN } from "./iosDeviceType";
import { resolveOwnAppDataContainer } from "./simulatorOwnContainer";
import type { SimCtl } from "./SimCtlClient";
import { parsePlist } from "./XctestrunPlist";

/** A keyboard default the iOS Settings app writes when a user changes a keyboard toggle. */
export type KeyboardDefaultValue = boolean | number | string;

/**
 * User-configurable keyboard toggles in `com.apple.Preferences`. The domain also holds
 * system-maintained `Keyboard*` bookkeeping (current keyboard, last-used layout) that changes
 * during ordinary sessions, so only the settings a session can deliberately flip are tracked.
 */
export const IOS_KEYBOARD_DEFAULT_KEYS = [
  "KeyboardAutocapitalization",
  "KeyboardAutocorrection",
  "KeyboardCapsLock",
  "KeyboardCheckSpelling",
  "KeyboardPeriodShortcut",
  "KeyboardPrediction",
  "KeyboardShowPredictionBar",
] as const;

export const IOS_KEYBOARD_DEFAULTS_DOMAIN = "com.apple.Preferences";

/**
 * `simctl ui <udid> increase_contrast` writes these `com.apple.Accessibility` defaults and,
 * when turned back off, leaves them behind at 0 instead of removing them (#15017). A pool
 * simulator has neither, so a leftover is session residue even though contrast reads as disabled.
 */
export const IOS_INCREASE_CONTRAST_DEFAULT_KEYS = [
  "DarkenSystemColors",
  "PointerIncreasedContrastEnabled",
] as const;

export const IOS_ACCESSIBILITY_RESIDUE_DOMAIN = "com.apple.Accessibility";

const SAFARI_BUNDLE_ID = "com.apple.mobilesafari";

export type IosResidueFileArea = "documents" | "safari-documents";

/** Out-of-band simulator state a keep-booted reset cannot learn about from the mutation journal. */
export interface IosResidueSnapshot {
  /** Files below `Media/DCIM`, relative and sorted: the photo library's originals. */
  photos: string[];
  /** Non-Apple top-level entries of the device `Documents` directory, sorted. */
  documents: string[];
  /** Top-level entries of Safari's data-container `Documents` directory, sorted. */
  safariDocuments: string[];
  keyboard: Record<string, KeyboardDefaultValue>;
  /** The `com.apple.Accessibility` increase-contrast defaults, by key. */
  accessibility: Record<string, KeyboardDefaultValue>;
}

export interface IosResidueInspector {
  /** Reads every residue area; rejects when any area cannot be read. */
  read(deviceId: string, signal: AbortSignal): Promise<IosResidueSnapshot>;
  /** Removes the named top-level entries of one file area. */
  removeEntries(
    deviceId: string,
    area: IosResidueFileArea,
    names: readonly string[],
    signal: AbortSignal,
  ): Promise<void>;
}

export interface SimulatorResidueFileSystem {
  /** Relative paths of every file below `directory`; null when the directory does not exist. */
  listFiles(directory: string): Promise<string[] | null>;
  /** Names directly inside `directory`; null when the directory does not exist. */
  listEntries(directory: string): Promise<string[] | null>;
  /** Container metadata identity; null when the directory or metadata cannot be proven. */
  containerIdentifier(directory: string): Promise<string | null>;
  remove(path: string): Promise<void>;
}

export interface SimulatorResidueReaderDependencies {
  simctl: Pick<SimCtl, "executeCommandArgs">;
  files: SimulatorResidueFileSystem;
  /** Directory holding `<udid>/data`: the CoreSimulator device set root. */
  deviceSetRoot: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Apple's own databases and directories under `Documents` (the AMDSQLite store and its
 * sidecars, `com.apple.*` service directories) are rewritten by iOS itself while a session
 * runs, so they are not session residue and are never removed.
 */
function isSystemOwnedDocument(name: string): boolean {
  return name.startsWith(".") || name.startsWith("com.apple.") || name.startsWith("AMDSQLite");
}

function isMissingDirectory(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isKeyboardDefaultValue(value: unknown): value is KeyboardDefaultValue {
  return typeof value === "boolean" || typeof value === "number" || typeof value === "string";
}

function isMissingContainer(error: unknown): boolean {
  return errorMessage(error).includes("No such file or directory");
}

async function listNodeFiles(directory: string, prefix = ""): Promise<string[] | null> {
  let entries;
  try {
    entries = await sortedReaddirEntries(directory);
  } catch (error) {
    if (isMissingDirectory(error)) {
      // A directory the simulator never created holds nothing to leave behind.
      return null;
    }
    throw error;
  }
  const files = await Promise.all(
    entries.map(async (entry) =>
      entry.isDirectory()
        ? ((await listNodeFiles(posix.join(directory, entry.name), `${prefix}${entry.name}/`)) ??
          [])
        : [`${prefix}${entry.name}`],
    ),
  );
  return files.flat();
}

function isContainerMetadata(value: unknown): value is { MCMMetadataIdentifier: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "MCMMetadataIdentifier" in value &&
    typeof value.MCMMetadataIdentifier === "string"
  );
}

export function createNodeSimulatorResidueFileSystem(
  plist: Pick<PlistReader, "readJsonFile">,
): SimulatorResidueFileSystem {
  return {
    listFiles: (directory) => listNodeFiles(directory),
    listEntries: async (directory) => {
      try {
        return await sortedReaddir(directory);
      } catch (error) {
        if (isMissingDirectory(error)) {
          // A directory the simulator never created holds nothing to leave behind.
          return null;
        }
        throw error;
      }
    },
    containerIdentifier: async (directory) => {
      try {
        const metadata = await plist.readJsonFile(
          posix.join(directory, ".com.apple.mobile_container_manager.metadata.plist"),
        );
        if (isContainerMetadata(metadata)) {
          return metadata.MCMMetadataIdentifier;
        }
        logger.warn(
          `Simulator container metadata has no string MCMMetadataIdentifier: ${directory}`,
        );
        return null;
      } catch (error) {
        if (isMissingDirectory(error) || isMissingContainer(error)) {
          // Uncreated containers or metadata cannot establish ownership; callers refuse cleanup.
          logger.debug(`Simulator container metadata is missing: ${errorMessage(error)}`);
          return null;
        }
        logger.warn(
          `Simulator container metadata could not be read for ${directory}: ${errorMessage(error)}`,
          error,
        );
        return null;
      }
    },
    remove: (path) => rm(path, { recursive: true, force: false }),
  };
}

let plistClient: PlistClient | undefined;

export const nodeSimulatorResidueFileSystem = createNodeSimulatorResidueFileSystem({
  readJsonFile: (path, options) => (plistClient ??= new PlistClient()).readJsonFile(path, options),
});

export class SimulatorResidueReader implements IosResidueInspector {
  constructor(private readonly dependencies: SimulatorResidueReaderDependencies) {}

  async read(deviceId: string, signal: AbortSignal): Promise<IosResidueSnapshot> {
    const dataRoot = this.dataRoot(deviceId);
    const { files } = this.dependencies;
    signal.throwIfAborted();
    const safariRoot = await this.safariDocumentsRoot(deviceId, signal);
    const photos = (await files.listFiles(posix.join(dataRoot, "Media", "DCIM"))) ?? [];
    signal.throwIfAborted();
    const documents = (await files.listEntries(posix.join(dataRoot, "Documents"))) ?? [];
    const safariDocuments = safariRoot ? ((await files.listEntries(safariRoot)) ?? []) : [];
    signal.throwIfAborted();
    return {
      photos: [...photos].sort(),
      documents: documents.filter((name) => !isSystemOwnedDocument(name)).sort(),
      safariDocuments: [...safariDocuments].sort(),
      keyboard: await this.readDefaults(
        deviceId,
        IOS_KEYBOARD_DEFAULTS_DOMAIN,
        IOS_KEYBOARD_DEFAULT_KEYS,
        signal,
      ),
      accessibility: await this.readDefaults(
        deviceId,
        IOS_ACCESSIBILITY_RESIDUE_DOMAIN,
        IOS_INCREASE_CONTRAST_DEFAULT_KEYS,
        signal,
      ),
    };
  }

  async removeEntries(
    deviceId: string,
    area: IosResidueFileArea,
    names: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    const root =
      area === "documents"
        ? posix.join(this.dataRoot(deviceId), "Documents")
        : await this.safariDocumentsRoot(deviceId, signal);
    if (!root || names.some((name) => !this.isSingleEntryName(name))) {
      throw new ActionableError("iOS residue cleanup refused an unproven file path");
    }
    for (const name of names) {
      signal.throwIfAborted();
      await this.dependencies.files.remove(posix.join(root, name));
    }
  }

  private isSingleEntryName(name: string): boolean {
    return (
      name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\")
    );
  }

  private dataRoot(deviceId: string): string {
    if (!IOS_SIMULATOR_UUID_PATTERN.test(deviceId)) {
      throw new ActionableError(
        `iOS residue lookup requires a simulator UDID, received ${deviceId}`,
      );
    }
    return posix.join(this.dependencies.deviceSetRoot, deviceId, "data");
  }

  /** Safari's data container `Documents` path, or null when Safari has no container yet. */
  private async safariDocumentsRoot(deviceId: string, signal: AbortSignal): Promise<string | null> {
    try {
      const root = await resolveOwnAppDataContainer({
        deviceId,
        bundleId: SAFARI_BUNDLE_ID,
        deviceSetRoot: this.dependencies.deviceSetRoot,
        identity: this.dependencies.files,
        run: (args) =>
          this.dependencies.simctl.executeCommandArgs(
            args,
            this.dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            signal,
          ),
      });
      return posix.join(root, "Documents");
    } catch (error) {
      if (isMissingContainer(error)) {
        // Safari has never created a container, so there is nothing to leave behind.
        logger.debug(`Safari container is missing: ${errorMessage(error)}`);
        return null;
      }
      throw error;
    }
  }

  private async readDefaults(
    deviceId: string,
    domain: string,
    trackedKeys: readonly string[],
    signal: AbortSignal,
  ): Promise<Record<string, KeyboardDefaultValue>> {
    const exported = await this.dependencies.simctl.executeCommandArgs(
      ["spawn", deviceId, "defaults", "export", domain, "-"],
      this.dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal,
    );
    const plist = await parsePlist(exported.stdout);
    if (!(plist instanceof Map)) {
      throw new ActionableError(`iOS ${domain} defaults export is not a dictionary`);
    }
    const defaults: Record<string, KeyboardDefaultValue> = {};
    for (const key of trackedKeys) {
      const value = plist.get(key);
      if (isKeyboardDefaultValue(value)) {
        defaults[key] = value;
      }
    }
    return defaults;
  }
}
