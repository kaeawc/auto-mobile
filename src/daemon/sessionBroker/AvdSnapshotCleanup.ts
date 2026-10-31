import { lstat, realpath, rm } from "node:fs/promises";
import { sortedReaddir } from "../../utils/io";
import { resolve, join, basename, dirname } from "node:path";
import type { AvdDirectoryResolver } from "../../utils/android-cmdline-tools/AvdConfigReader";
import { AVD_SNAPSHOTS_DIRNAME } from "../../utils/android-cmdline-tools/AvdConfigReader";
import { AVD_DEFAULT_BOOT_SNAPSHOT } from "../../utils/android-cmdline-tools/AvdSnapshotService";
import {
  assertSafePathSegment,
  isBrokerBaselineSnapshot,
} from "../../utils/snapshotNameValidation";
import { isPathInside } from "../../utils/filesystem/pathContainment";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { isProductBrokerDevice } from "./persistedIdentity";

/** All assignment and journal references, across every scope and state; never live-only. */
export interface AvdSnapshotCleanupRegistry {
  listReferencedAvdNames(): Promise<readonly string[]>;
}
export interface AvdSnapshotCleanupLiveness {
  hasLiveProcess(avdName: string): Promise<boolean>;
  /** Must throw on discovery failure. AvdSnapshotService's best-effort lookup is unsuitable. */
  findLiveEmulatorSerial(avdName: string): Promise<string | null>;
}
export interface AvdSnapshotCleanupFilesystem {
  /** Exact on-disk spelling, including symlinks so they can be rejected explicitly. */
  listNames(directory: string): Promise<string[]>;
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  /** Remove only this directory recursively, without following symlinks. Must throw on failure. */
  removeDirectory(path: string): Promise<void>;
}
/** Path-taking filesystem adapter; no home-directory or device discovery. */
export const nodeAvdSnapshotCleanupFilesystem: AvdSnapshotCleanupFilesystem = {
  listNames: sortedReaddir,
  lstat,
  realpath,
  removeDirectory: (path) => rm(path, { recursive: true }),
};

export interface KeptAvdSnapshot {
  snapshotName: string;
  reason: string;
}
export interface AvdSnapshotCleanupReport {
  avdName: string;
  deletedSnapshotNames: string[];
  keptSnapshots: KeptAvdSnapshot[];
  error?: string;
}
interface CleanupEvidence {
  avdName: string;
  snapshotNames: readonly string[];
  referencedAvdNames: readonly string[] | null;
  running: boolean | null;
  unsafeReason?: string;
  unsafeSnapshotReasons?: ReadonlyMap<string, string>;
}

function avdKeepReason(evidence: CleanupEvidence): string | undefined {
  if (!isProductBrokerDevice(evidence.avdName)) {
    return "Not a broker-created AVD name";
  }
  if (evidence.referencedAvdNames === null) {
    return "Registry unavailable";
  }
  if (
    evidence.referencedAvdNames.some(
      (name) => name.toLowerCase() === evidence.avdName.toLowerCase(),
    )
  ) {
    return "Registry references this AVD (including case aliases)";
  }
  if (evidence.unsafeReason) {
    return evidence.unsafeReason;
  }
  if (evidence.running !== false) {
    return evidence.running ? "AVD is running" : "AVD liveness uncertain";
  }
  return undefined;
}

/** Pure policy; names alone cannot authorize execution without verified directory evidence. */
export function planAvdSnapshotCleanup(evidence: CleanupEvidence): {
  deleteNames: string[];
  keptSnapshots: KeptAvdSnapshot[];
} {
  const deleteNames: string[] = [];
  const keptSnapshots: KeptAvdSnapshot[] = [];
  const keepAvd = avdKeepReason(evidence);
  for (const snapshotName of evidence.snapshotNames) {
    let reason = keepAvd;
    if (
      snapshotName.toLowerCase() === AVD_DEFAULT_BOOT_SNAPSHOT ||
      isBrokerBaselineSnapshot(snapshotName)
    ) {
      reason = "Reserved boot or broker baseline snapshot";
    }
    reason ??= evidence.unsafeSnapshotReasons?.get(snapshotName);
    if (reason) {
      keptSnapshots.push({ snapshotName, reason });
    } else {
      deleteNames.push(snapshotName);
    }
  }
  return { deleteNames, keptSnapshots };
}

interface CleanupPorts {
  resolver: AvdDirectoryResolver;
  registry: AvdSnapshotCleanupRegistry | undefined;
  liveness: AvdSnapshotCleanupLiveness;
  filesystem: AvdSnapshotCleanupFilesystem;
  log?: Pick<typeof logger, "warn">;
}

async function assertRealDirectory(
  path: string,
  filesystem: AvdSnapshotCleanupFilesystem,
): Promise<void> {
  const stat = await filesystem.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await filesystem.realpath(path)) !== path) {
    throw new Error(`Not an exact real directory: ${path}`);
  }
  if (!(await filesystem.listNames(dirname(path))).includes(basename(path))) {
    throw new Error(`Directory name case mismatch: ${path}`);
  }
}

async function snapshotsRoot(avdName: string, ports: CleanupPorts): Promise<string> {
  assertSafePathSegment("AVD name", avdName);
  const home = await ports.filesystem.realpath(ports.resolver.getAvdHome());
  const directory = await ports.resolver.resolveAvdDirectory(avdName);
  const expected = join(home, `${avdName}.avd`);
  // Redirected AVDs need separate ownership evidence; this cleanup only owns conventional paths.
  if (!directory || resolve(directory) !== expected) {
    throw new Error("AVD resolver did not find the exact owned conventional directory");
  }
  await assertRealDirectory(expected, ports.filesystem);
  const root = join(expected, AVD_SNAPSHOTS_DIRNAME);
  await assertRealDirectory(root, ports.filesystem);
  return root;
}

async function isRunning(avdName: string, liveness: AvdSnapshotCleanupLiveness): Promise<boolean> {
  return (
    (await liveness.hasLiveProcess(avdName)) ||
    (await liveness.findLiveEmulatorSerial(avdName)) !== null
  );
}

function validateSnapshotNames(
  names: string[],
  log: Pick<typeof logger, "warn">,
): Map<string, string> {
  const failures = new Map<string, string>();
  for (const name of names) {
    try {
      assertSafePathSegment("snapshot name", name);
    } catch (error) {
      const reason = errorMessage(error);
      log.warn(`[AvdSnapshotCleanup] Keeping invalid snapshot name: ${reason}`, error);
      failures.set(name, reason);
    }
  }
  return failures;
}

async function cleanAvd(
  avdName: string,
  references: readonly string[] | null,
  registryError: string | undefined,
  ports: CleanupPorts,
): Promise<AvdSnapshotCleanupReport> {
  const report: AvdSnapshotCleanupReport = {
    avdName,
    deletedSnapshotNames: [],
    keptSnapshots: [],
    ...(registryError ? { error: registryError } : {}),
  };
  const log = ports.log ?? logger;
  let names: string[] = [];
  try {
    const root = await snapshotsRoot(avdName, ports);
    names = await ports.filesystem.listNames(root);
    const preliminary = avdKeepReason({
      avdName,
      snapshotNames: names,
      referencedAvdNames: references,
      running: false,
    });
    const running = preliminary ? null : await isRunning(avdName, ports.liveness);
    const unsafeSnapshotReasons = validateSnapshotNames(names, log);
    if (unsafeSnapshotReasons.size > 0) {
      report.error = [...unsafeSnapshotReasons.values()].join("; ");
    }
    const plan = planAvdSnapshotCleanup({
      avdName,
      snapshotNames: names,
      referencedAvdNames: references,
      running,
      unsafeSnapshotReasons,
    });
    report.keptSnapshots = plan.keptSnapshots;
    for (const kept of plan.keptSnapshots) {
      log.warn(`[AvdSnapshotCleanup] Keeping ${avdName}/${kept.snapshotName}: ${kept.reason}`);
    }
    for (const name of plan.deleteNames) {
      // Revalidate immediately before each removal; no emulator console command is used.
      const currentRoot = await snapshotsRoot(avdName, ports);
      if (currentRoot !== root || (await isRunning(avdName, ports.liveness))) {
        throw new Error("AVD directory changed or AVD started before deletion");
      }
      assertSafePathSegment("snapshot name", name);
      const target = resolve(root, name);
      if (!isPathInside(root, target, { allowEqual: false })) {
        throw new Error("Snapshot path escapes the snapshots root");
      }
      await assertRealDirectory(target, ports.filesystem);
      await ports.filesystem.listNames(target);
      await ports.filesystem.removeDirectory(target);
      report.deletedSnapshotNames.push(name);
    }
  } catch (error) {
    const reason = errorMessage(error);
    log.warn(`[AvdSnapshotCleanup] Keeping remaining snapshots for ${avdName}: ${reason}`, error);
    report.error = registryError ? `${registryError}; ${reason}` : reason;
    // Fail closed: only completed removals are reported deleted; every other known name is kept.
    const accounted = new Set([
      ...report.deletedSnapshotNames,
      ...report.keptSnapshots.map((entry) => entry.snapshotName),
    ]);
    report.keptSnapshots.push(
      ...names
        .filter((name) => !accounted.has(name))
        .map((snapshotName) => ({ snapshotName, reason })),
    );
  }
  return report;
}

/**
 * Explicit maintenance operation, never a startup sweep. The caller must exclude broker
 * allocation, registry mutation and emulator launches for the invocation: filesystem checks
 * cannot atomically fence another process launching/replacing an AVD during recursive removal.
 * Read the complete registry before any deletion; a failed read keeps the entire run.
 */
export async function cleanupAvdSnapshots(
  avdNames: readonly string[],
  ports: CleanupPorts,
): Promise<AvdSnapshotCleanupReport[]> {
  let references: readonly string[] | null = null;
  let registryError: string | undefined;
  try {
    if (!ports.registry) {
      throw new Error("Registry unavailable");
    }
    references = await ports.registry.listReferencedAvdNames();
  } catch (error) {
    registryError = errorMessage(error);
    (ports.log ?? logger).warn(
      `[AvdSnapshotCleanup] Keeping all snapshots: ${registryError}`,
      error,
    );
    // No deletion is authorized without the complete registry snapshot.
  }
  const reports: AvdSnapshotCleanupReport[] = [];
  for (const avdName of new Set(avdNames)) {
    reports.push(await cleanAvd(avdName, references, registryError, ports));
  }
  return reports;
}
