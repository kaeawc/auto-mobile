import * as path from "path";
import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";
import type { AdbClientFactory } from "./AdbClientFactory";
import { defaultAdbClientFactory } from "./AdbClientFactory";
import type { AvdDirectoryResolver } from "./AvdConfigReader";
import { AVD_SNAPSHOTS_DIRNAME, FileAvdConfigReader } from "./AvdConfigReader";
import type { AndroidEmulator } from "./AndroidEmulatorClient";
import { AndroidEmulatorClient } from "./AndroidEmulatorClient";
import { DeviceSnapshotStore } from "../DeviceSnapshotStore";
import {
  buildVmSnapshotCommand,
  evaluateVmSnapshotResult,
  formatVmSnapshotExecutionError,
  isMissingVmSnapshotError,
} from "./vmSnapshot";
import {
  defaultEmulatorConsoleBusyRegistry,
  type EmulatorConsoleBusyRegistry,
} from "./EmulatorConsoleBusyRegistry";

/**
 * The emulator's own boot snapshot. It is never an AutoMobile capture, so the
 * archive's orphan report excludes it — surfacing it would invite deleting the
 * AVD's quick-boot state (#6490).
 */
export const AVD_DEFAULT_BOOT_SNAPSHOT = "default_boot";

export interface AvdSnapshotDirectoryEntry {
  snapshotName: string;
  /**
   * The directory this entry was measured at, as resolved — which is NOT always
   * `~/.android/avd/<avd>.avd/snapshots/<name>`. ANDROID_AVD_HOME and an
   * `<avd>.ini` redirect both move it, so reporting the conventional path sent
   * anyone following the manual-cleanup instructions at a directory the scanner
   * never looked in (#6891 review).
   */
  directoryPath: string;
  /** null when the directory exists but its size could not be measured. */
  sizeBytes: number | null;
}

export interface VmSnapshotReclaimOutcome {
  /** True when the in-AVD snapshot is gone (deleted now, or already absent). */
  reclaimed: boolean;
  /** Why the reclaim did not happen; recorded on the row as the pending reason. */
  reason?: string;
}

/**
 * The emulator-owned half of device-snapshot accounting: the
 * `<avd>.avd/snapshots/<name>` payload a VM snapshot actually occupies, and the
 * emulator-console delete that reclaims it. Split out from the manager so the
 * manager can be unit-tested against a fake with no filesystem and no adb
 * (issue #6490, parent #6371).
 */
export interface AvdSnapshotOperations {
  /** On-disk bytes of `<avd>.avd/snapshots/<name>`, or null when not found. */
  measureVmSnapshotBytes(avdName: string, snapshotName: string): Promise<number | null>;
  /** Every `<avd>.avd/snapshots/*` directory, exactly as it is on disk. */
  listAvdSnapshotDirectories(avdName: string): Promise<AvdSnapshotDirectoryEntry[]>;
  /** AVD names present on this host (`<avdHome>/<name>.avd`). */
  listKnownAvdNames(): Promise<string[]>;
  /** adb serial of the running emulator for `avdName`, or null when it is not live. */
  findLiveEmulatorSerial(avdName: string): Promise<string | null>;
  /**
   * Issue `adb -s <serial> emu avd snapshot del <name>` and judge the response.
   * When `expectedAvdName` is supplied, verify that the serial still belongs to
   * that AVD immediately before dispatching the destructive console command.
   */
  deleteVmSnapshot(
    deviceId: string,
    snapshotName: string,
    timeoutMs: number,
    expectedAvdName?: string,
  ): Promise<VmSnapshotReclaimOutcome>;
}

/**
 * Directory primitives this service needs. {@link DeviceSnapshotStore} supplies
 * them, so production and tests measure in-AVD payloads through exactly the
 * filesystem seam the archive already uses.
 */
export type SnapshotDirectoryMeasurer = Pick<
  DeviceSnapshotStore,
  "getDirectorySize" | "listSubdirectoryNames" | "listFileNames"
>;

const AVD_DIRECTORY_SUFFIX = ".avd";
const AVD_REGISTRY_SUFFIX = ".ini";

export class AvdSnapshotService implements AvdSnapshotOperations {
  private readonly directories: SnapshotDirectoryMeasurer;
  private readonly avdDirectories: AvdDirectoryResolver;
  private readonly emulator: AndroidEmulator;
  private readonly adbFactory: AdbClientFactory;

  constructor(
    directories: SnapshotDirectoryMeasurer = new DeviceSnapshotStore(),
    avdDirectories: AvdDirectoryResolver = new FileAvdConfigReader(),
    emulator: AndroidEmulator = new AndroidEmulatorClient(),
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    private readonly consoleBusyRegistry: EmulatorConsoleBusyRegistry = defaultEmulatorConsoleBusyRegistry,
  ) {
    this.directories = directories;
    this.avdDirectories = avdDirectories;
    this.emulator = emulator;
    this.adbFactory = adbFactory;
  }

  async measureVmSnapshotBytes(avdName: string, snapshotName: string): Promise<number | null> {
    const snapshotsRoot = await this.resolveSnapshotsRoot(avdName);
    if (!snapshotsRoot) {
      return null;
    }
    return this.directories.getDirectorySize(path.join(snapshotsRoot, snapshotName));
  }

  async listAvdSnapshotDirectories(avdName: string): Promise<AvdSnapshotDirectoryEntry[]> {
    const snapshotsRoot = await this.resolveSnapshotsRoot(avdName);
    if (!snapshotsRoot) {
      return [];
    }
    const names = await this.directories.listSubdirectoryNames(snapshotsRoot);
    if (!names) {
      return [];
    }

    const entries: AvdSnapshotDirectoryEntry[] = [];
    for (const snapshotName of names) {
      const directoryPath = path.join(snapshotsRoot, snapshotName);
      entries.push({
        snapshotName,
        directoryPath,
        sizeBytes: await this.directories.getDirectorySize(directoryPath),
      });
    }
    return entries;
  }

  async listKnownAvdNames(): Promise<string[]> {
    const avdHome = this.avdDirectories.getAvdHome();
    // Two shapes live side by side in the AVD home. A conventional AVD is the
    // `<name>.avd` DIRECTORY; an AVD relocated elsewhere leaves only the
    // `<name>.ini` registry FILE behind, with its payload — snapshots included —
    // on another disk. Scanning directories alone made relocated AVDs invisible,
    // so the redirect-aware resolver this service exists to use was never even
    // consulted for them (#6490 review). Both shapes can be present for the same
    // AVD, hence the dedupe.
    const names = new Set<string>();
    for (const [entries, suffix] of [
      [await this.directories.listSubdirectoryNames(avdHome), AVD_DIRECTORY_SUFFIX],
      [await this.directories.listFileNames(avdHome), AVD_REGISTRY_SUFFIX],
    ] as const) {
      for (const entry of entries ?? []) {
        if (entry.endsWith(suffix) && entry.length > suffix.length) {
          names.add(entry.slice(0, -suffix.length));
        }
      }
    }
    return Array.from(names);
  }

  async findLiveEmulatorSerial(avdName: string): Promise<string | null> {
    if (!avdName) {
      return null;
    }
    try {
      const devices = await this.emulator.getBootedDevices(true);
      return devices.find((device) => device.name === avdName)?.deviceId ?? null;
    } catch (error) {
      // Device enumeration failing means "we cannot prove the emulator is live",
      // which is the same decision as "it is not live": the caller records a
      // pending reclaim instead of losing the reference (CLAUDE.md strategy 2).
      logger.warn(
        `[AvdSnapshot] Failed to look up a live emulator for AVD '${avdName}': ${errorMessage(error)}`,
        error,
      );
      return null;
    }
  }

  async deleteVmSnapshot(
    deviceId: string,
    snapshotName: string,
    timeoutMs: number,
    expectedAvdName?: string,
  ): Promise<VmSnapshotReclaimOutcome> {
    const adb = this.adbFactory.create({ deviceId, name: deviceId, platform: "android" });
    const command = buildVmSnapshotCommand("delete", snapshotName);

    let result;
    try {
      result = await this.consoleBusyRegistry.runExclusive(deviceId, async () => {
        if (expectedAvdName !== undefined) {
          const liveDevice = (await this.emulator.getBootedDevices(true)).find(
            (device) => device.deviceId === deviceId,
          );
          if (liveDevice?.name !== expectedAvdName) {
            const actualAvdName = liveDevice?.name ?? "no longer live";
            const reason =
              `Skipping VM snapshot delete for '${snapshotName}': serial '${deviceId}' expected AVD ` +
              `'${expectedAvdName}' but currently hosts '${actualAvdName}'`;
            logger.warn(`[AvdSnapshot] ${reason}`);
            return { reclaimed: false, reason };
          }
        }

        return adb.execute(command.split(" "), {
          timeoutMs,
          waitForProcessSettlementAfterAbort: true,
        });
      });
    } catch (error) {
      const reason = formatVmSnapshotExecutionError("delete", snapshotName, error);
      logger.warn(`[AvdSnapshot] ${reason}`, error);
      return { reclaimed: false, reason };
    }

    if ("reclaimed" in result) {
      return result;
    }

    const evaluation = evaluateVmSnapshotResult("delete", snapshotName, result);
    if (evaluation.ok) {
      return { reclaimed: true };
    }
    if (isMissingVmSnapshotError(evaluation.errorMessage)) {
      // Already gone: the bytes the caller wanted reclaimed are reclaimed.
      logger.debug(`[AvdSnapshot] ${evaluation.errorMessage}`);
      return { reclaimed: true };
    }
    logger.warn(`[AvdSnapshot] ${evaluation.errorMessage}`);
    return { reclaimed: false, reason: evaluation.errorMessage };
  }

  private async resolveSnapshotsRoot(avdName: string): Promise<string | null> {
    if (!avdName) {
      return null;
    }
    const avdDirectory = await this.avdDirectories.resolveAvdDirectory(avdName);
    if (!avdDirectory) {
      return null;
    }
    return path.join(avdDirectory, AVD_SNAPSHOTS_DIRNAME);
  }
}
