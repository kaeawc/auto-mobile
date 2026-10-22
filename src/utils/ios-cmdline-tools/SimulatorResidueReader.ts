import { rm } from "node:fs/promises";
import { join, posix, sep } from "node:path";
import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../describeUnknownError";
import { sortedReaddir, sortedReaddirEntries } from "../io";
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
  remove(path: string): Promise<void>;
}

export interface SimulatorResidueReaderDependencies {
  simctl: Pick<SimCtl, "executeCommandArgs">;
  files: SimulatorResidueFileSystem;
  /** Directory holding `<udid>/data`: the CoreSimulator device set root. */
  deviceSetRoot: string;
  timeoutMs?: number;
}

const SIMULATOR_UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
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
        ? ((await listNodeFiles(join(directory, entry.name), `${prefix}${entry.name}/`)) ?? [])
        : [`${prefix}${entry.name}`],
    ),
  );
  return files.flat();
}

export const nodeSimulatorResidueFileSystem: SimulatorResidueFileSystem = {
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
  remove: (path) => rm(path, { recursive: true, force: false }),
};

export class SimulatorResidueReader implements IosResidueInspector {
  constructor(private readonly dependencies: SimulatorResidueReaderDependencies) {}

  async read(deviceId: string, signal: AbortSignal): Promise<IosResidueSnapshot> {
    const dataRoot = this.dataRoot(deviceId);
    const { files } = this.dependencies;
    signal.throwIfAborted();
    const photos = (await files.listFiles(join(dataRoot, "Media", "DCIM"))) ?? [];
    signal.throwIfAborted();
    const documents = (await files.listEntries(join(dataRoot, "Documents"))) ?? [];
    const safariRoot = await this.safariDocumentsRoot(deviceId, signal);
    const safariDocuments = safariRoot ? ((await files.listEntries(safariRoot)) ?? []) : [];
    signal.throwIfAborted();
    return {
      photos: [...photos].sort(),
      documents: documents.filter((name) => !isSystemOwnedDocument(name)).sort(),
      safariDocuments: [...safariDocuments].sort(),
      keyboard: await this.readKeyboardDefaults(deviceId, signal),
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
        ? join(this.dataRoot(deviceId), "Documents")
        : await this.safariDocumentsRoot(deviceId, signal);
    if (!root || names.some((name) => !this.isSingleEntryName(name))) {
      throw new ActionableError("iOS residue cleanup refused an unproven file path");
    }
    for (const name of names) {
      signal.throwIfAborted();
      await this.dependencies.files.remove(join(root, name));
    }
  }

  private isSingleEntryName(name: string): boolean {
    return (
      name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes(sep)
    );
  }

  private dataRoot(deviceId: string): string {
    if (!SIMULATOR_UDID.test(deviceId)) {
      throw new ActionableError(
        `iOS residue lookup requires a simulator UDID, received ${deviceId}`,
      );
    }
    return join(this.dependencies.deviceSetRoot, deviceId, "data");
  }

  /** Safari's data container `Documents` path, or null when Safari has no container yet. */
  private async safariDocumentsRoot(deviceId: string, signal: AbortSignal): Promise<string | null> {
    const dataRoot = this.dataRoot(deviceId);
    let stdout: string;
    try {
      stdout = (
        await this.dependencies.simctl.executeCommandArgs(
          ["get_app_container", deviceId, SAFARI_BUNDLE_ID, "data"],
          this.dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal,
        )
      ).stdout.trim();
    } catch (error) {
      if (isMissingContainer(error)) {
        // simctl reports a container Safari never created as ENOENT: nothing to leave behind.
        return null;
      }
      throw error;
    }
    const containers = join(dataRoot, "Containers", "Data", "Application");
    if (!stdout.startsWith(`${containers}${sep}`) || posix.normalize(stdout) !== stdout) {
      throw new ActionableError("iOS residue cleanup refused an unproven file path");
    }
    return join(stdout, "Documents");
  }

  private async readKeyboardDefaults(
    deviceId: string,
    signal: AbortSignal,
  ): Promise<Record<string, KeyboardDefaultValue>> {
    const exported = await this.dependencies.simctl.executeCommandArgs(
      ["spawn", deviceId, "defaults", "export", IOS_KEYBOARD_DEFAULTS_DOMAIN, "-"],
      this.dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal,
    );
    const plist = await parsePlist(exported.stdout);
    if (!(plist instanceof Map)) {
      throw new ActionableError("iOS keyboard defaults export is not a dictionary");
    }
    const keyboard: Record<string, KeyboardDefaultValue> = {};
    for (const key of IOS_KEYBOARD_DEFAULT_KEYS) {
      const value = plist.get(key);
      if (isKeyboardDefaultValue(value)) {
        keyboard[key] = value;
      }
    }
    return keyboard;
  }
}
