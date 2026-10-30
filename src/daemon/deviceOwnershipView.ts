import { dirname, join } from "node:path";
import { isAndroidOrIosPlatform, type Platform } from "../models";
import { readExclusiveLockContent, type LockContent } from "../utils/fileLock";
import { sortedReaddirSync } from "../utils/io";
import { isProcessRunning } from "../utils/processLiveness";
import { defaultLockOwnerGenerationProbe } from "../utils/lockOwnerGeneration";
import type { LockOwnerGenerationVerdict } from "../utils/fileLock";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { DeviceClaims } from "./deviceClaims";
import { toActionableError } from "../models/ActionableError";
import {
  ctrlProxyForwardLeaseDir,
  deviceIdFromCtrlProxyForwardLeaseFileName,
  ctrlProxyForwardLeaseFileName,
} from "../features/observe/android/CtrlProxyForwardLease";
import { createBindingExecOwnerLiveness } from "./sessionBroker/registry/ownerLiveness";
import type { BindingRegistry } from "./sessionBroker/registry/bindingRegistry";
import {
  DEVICE_ALLOCATION_CLAIM_SUBDIR,
  deviceAllocationClaimPath,
  iosDeviceAllocationClaimPath,
} from "./foreignDeviceOwnership";
import { getSharedAutoMobileDir } from "../utils/tempDir";

/**
 * Read-only composition of the places that each claim to say who owns a device (#11811 step a).
 * Nothing here acquires, releases or repairs; it only reports what each source says and where the
 * sources disagree, so the later consolidation into one `device_claims` table has a baseline.
 */
export type DeviceOwnershipSourceName =
  | "claim_file"
  | "legacy_claim_file"
  | "forward_lease"
  | "exec_owner"
  | "device_claims"
  | "pool_holder"
  | "session_manager";

/** What one source says about one device. */
export interface DeviceOwnerRecord {
  source: DeviceOwnershipSourceName;
  /** Owning process, for the sources that record one. */
  pid?: number;
  /** Owning session, for the sources that record one. */
  sessionId?: string;
  /** Whether `pid` is a running process (and, for exec owners, the same process generation). */
  alive?: boolean;
}

export interface DeviceRef {
  platform: Platform;
  deviceId: string;
}

/** Narrow ports: each returns what one store holds, or nothing. */
export interface DeviceOwnershipSources {
  /** Devices any store mentions, so a check can walk them without knowing ids up front. */
  listDevices(): Promise<DeviceRef[]>;
  /** Lock-file owners (allocation claim, 0.0.84 claim, CtrlProxy forwarding lease). */
  lockFileOwners(device: DeviceRef): DeviceOwnerRecord[];
  /** The persisted binding's live execution owner for the device, if any. */
  execOwner(device: DeviceRef): Promise<DeviceOwnerRecord | undefined>;
  /** The host-wide `device_claims` row dual-written beside the claim files (#11811 b). */
  tableClaim?(device: DeviceRef): Promise<DeviceOwnerRecord | undefined>;
  /** In-daemon holders; absent when the view runs outside a daemon (doctor). */
  poolHolder?(device: DeviceRef): string | null | undefined;
  sessionManagerHolder?(device: DeviceRef): string | null | undefined;
}

export type OwnershipDisagreementKind =
  | "conflicting_live_pids"
  | "conflicting_sessions"
  | "stale_record_beside_live_owner";

export interface OwnershipDisagreement {
  kind: OwnershipDisagreementKind;
  detail: string;
}

export interface DeviceOwnership extends DeviceRef {
  records: DeviceOwnerRecord[];
  /** Distinct live process ids across all records; more than one is a disagreement. */
  liveOwnerPids: number[];
  disagreements: OwnershipDisagreement[];
}

function describe(record: DeviceOwnerRecord): string {
  const parts: string[] = [record.source];
  if (record.pid !== undefined) {
    parts.push(`pid ${record.pid}${record.alive === false ? " (gone)" : ""}`);
  }
  if (record.sessionId !== undefined) {
    parts.push(`session ${record.sessionId}`);
  }
  return parts.join(" ");
}

/** Pure judgement over the records of one device. */
export function judgeOwnership(device: DeviceRef, records: DeviceOwnerRecord[]): DeviceOwnership {
  const disagreements: OwnershipDisagreement[] = [];
  const live = records.filter((r) => r.pid !== undefined && r.alive !== false);
  const liveOwnerPids = [
    ...new Set(live.flatMap((r) => (r.pid === undefined ? [] : [r.pid]))),
  ].sort((a, b) => a - b);
  if (liveOwnerPids.length > 1) {
    disagreements.push({
      kind: "conflicting_live_pids",
      detail: `live owners ${liveOwnerPids.join(", ")}: ${live.map(describe).join("; ")}`,
    });
  }
  const withSession = records.filter((r) => r.sessionId !== undefined);
  const sessions = [...new Set(withSession.map((r) => r.sessionId))];
  if (sessions.length > 1) {
    disagreements.push({
      kind: "conflicting_sessions",
      detail: `sessions ${sessions.join(", ")}: ${withSession.map(describe).join("; ")}`,
    });
  }
  const stale = records.filter((r) => r.pid !== undefined && r.alive === false);
  if (stale.length > 0 && liveOwnerPids.length > 0) {
    disagreements.push({
      kind: "stale_record_beside_live_owner",
      detail: `${stale.map(describe).join("; ")} while pid ${liveOwnerPids.join(", ")} is live`,
    });
  }
  return { ...device, records, liveOwnerPids, disagreements };
}

export class DeviceOwnershipView {
  constructor(private readonly sources: DeviceOwnershipSources) {}

  async ownershipOf(device: DeviceRef): Promise<DeviceOwnership> {
    const records = [...this.sources.lockFileOwners(device)];
    const exec = await this.sources.execOwner(device);
    if (exec) {
      records.push(exec);
    }
    const table = await this.sources.tableClaim?.(device);
    if (table) {
      records.push(table);
    }
    const pool = this.sources.poolHolder?.(device);
    if (pool) {
      records.push({ source: "pool_holder", sessionId: pool });
    }
    const manager = this.sources.sessionManagerHolder?.(device);
    if (manager) {
      records.push({ source: "session_manager", sessionId: manager });
    }
    return judgeOwnership(device, records);
  }

  async snapshot(): Promise<DeviceOwnership[]> {
    const devices = await this.sources.listDevices();
    return Promise.all(devices.map((device) => this.ownershipOf(device)));
  }
}

// ---------------------------------------------------------------------------------------------
// Production sources (read-only)
// ---------------------------------------------------------------------------------------------

export interface LockFileReaders {
  readLock(path: string): LockContent | undefined;
  isProcessRunning(pid: number): boolean;
  listFiles(dir: string): string[];
  /**
   * Whether `pid` is still the process generation recorded in the lock (#13279). Omitted: the PID
   * probe alone decides. "unknown" keeps a possibly-live owner.
   */
  generationVerdict?(pid: number, recorded: string): LockOwnerGenerationVerdict;
}

const defaultLockFileReaders: LockFileReaders = {
  readLock: (path) => readExclusiveLockContent(path),
  isProcessRunning: (pid) => isProcessRunning(pid),
  listFiles: (dir) => sortedReaddirSync(dir),
  generationVerdict: (pid, recorded) => defaultLockOwnerGenerationProbe.compare(pid, recorded),
};

export interface DefaultSourcesOptions {
  /** Persisted binding registry, when one is readable; omitted means no exec-owner records. */
  registry?: Pick<BindingRegistry, "findDeviceHolder">;
  /** The host-wide claims table, when the registry is readable; omitted means no table records. */
  claims?: Pick<DeviceClaims, "get" | "list">;
  readers?: LockFileReaders;
  /** Maps an adb serial to the stable id the registry keys on; identity when omitted. */
  stableDeviceId?: (device: DeviceRef) => string;
  env?: NodeJS.ProcessEnv;
}

export function createDefaultDeviceOwnershipSources(
  options: DefaultSourcesOptions = {},
): DeviceOwnershipSources {
  const readers = options.readers ?? defaultLockFileReaders;
  const env = options.env ?? process.env;
  const execAlive = createBindingExecOwnerLiveness();
  const claimDir = (platform: Platform): string =>
    dirname(
      platform === "ios"
        ? iosDeviceAllocationClaimPath("probe", env)
        : deviceAllocationClaimPath("probe", env),
    );
  const legacyDir = (): string => getSharedAutoMobileDir(DEVICE_ALLOCATION_CLAIM_SUBDIR);

  const record = (
    source: DeviceOwnershipSourceName,
    path: string,
  ): DeviceOwnerRecord | undefined => {
    const content = readers.readLock(path);
    if (!content || Number.isNaN(content.pid)) {
      return undefined;
    }
    // A PID the OS reused for an unrelated process is not the lock holder (#13279).
    const running = readers.isProcessRunning(content.pid);
    const reused =
      running &&
      content.generation !== undefined &&
      readers.generationVerdict?.(content.pid, content.generation) === "different";
    return { source, pid: content.pid, alive: running && !reused };
  };

  const idsIn = (dir: string, platform: Platform): DeviceRef[] => {
    try {
      return readers.listFiles(dir).flatMap((name) => {
        const deviceId = deviceIdFromCtrlProxyForwardLeaseFileName(name);
        return deviceId === undefined ? [] : [{ platform, deviceId }];
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // A directory that was never created simply means nothing claimed through it.
        logger.debug(`ownership view: ${dir} does not exist: ${errorMessage(error)}`);
        return [];
      }
      // EACCES/EIO must not read as "nothing claimed": the doctor check reports the failure.
      throw toActionableError(error, `Cannot list device ownership directory ${dir}`);
    }
  };

  return {
    async listDevices() {
      const tabled = ((await options.claims?.list()) ?? []).map(({ platform, deviceId }) => ({
        platform,
        deviceId,
      }));
      const all = [
        ...tabled,
        ...idsIn(claimDir("android"), "android"),
        ...idsIn(claimDir("ios"), "ios"),
        ...idsIn(legacyDir(), "android"),
        ...idsIn(ctrlProxyForwardLeaseDir(), "android"),
      ];
      const seen = new Set<string>();
      return all.filter((d) => {
        const key = `${d.platform}:${d.deviceId}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
    },
    lockFileOwners({ platform, deviceId }) {
      const name = ctrlProxyForwardLeaseFileName(deviceId);
      const found = [
        record("claim_file", join(claimDir(platform), name)),
        platform === "android" ? record("legacy_claim_file", join(legacyDir(), name)) : undefined,
        platform === "android"
          ? record("forward_lease", join(ctrlProxyForwardLeaseDir(), name))
          : undefined,
      ];
      return found.filter((r): r is DeviceOwnerRecord => r !== undefined);
    },
    async tableClaim(device) {
      const claim = await options.claims?.get(device.platform, device.deviceId);
      if (!claim) {
        return undefined;
      }
      const running = readers.isProcessRunning(claim.pid);
      const reused =
        running &&
        claim.processGenerationToken !== undefined &&
        readers.generationVerdict?.(claim.pid, claim.processGenerationToken) === "different";
      return {
        source: "device_claims",
        pid: claim.pid,
        ...(claim.sessionUuid === undefined ? {} : { sessionId: claim.sessionUuid }),
        alive: running && !reused,
      };
    },
    async execOwner(device) {
      // Bindings hold only Android and iOS devices, so a watch has no binding execution owner.
      if (!options.registry || !isAndroidOrIosPlatform(device.platform)) {
        return undefined;
      }
      const stable = options.stableDeviceId?.(device) ?? device.deviceId;
      const holder = await options.registry.findDeviceHolder(device.platform, stable);
      const owner = holder?.assignment.execOwner;
      return owner
        ? {
            source: "exec_owner",
            pid: owner.pid,
            sessionId: owner.sessionUuid,
            alive: execAlive(owner),
          }
        : undefined;
    },
  };
}
