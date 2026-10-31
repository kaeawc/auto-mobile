const GIB = 1024 ** 3;

/** Share of host RAM booted devices may use; the rest stays for the IDE, the app under test and the OS. */
export const MEMORY_BUDGET_FRACTION = 0.5;
/** One booted device is budgeted two cores. */
const CORES_PER_DEVICE = 2;

/** Hardware the AVD about to boot resolved to (`hardware-qemu.ini`), each field when known. */
export interface CandidateHardware {
  guestBytes?: number;
  cpuCores?: number;
}

export type MaxBootedSource = "env" | "derived";

export interface CapacityLimits {
  maxBooted: number;
  source: MaxBootedSource;
  /** Set when the env override was present but unusable. */
  warning?: string;
}

/** Host numbers the limit is derived from. */
export interface CapacityHostResources {
  totalMemoryBytes: number;
  cpuCount: number;
}

/** Per-platform memory assumptions for one booted device. */
export interface PerDeviceMemoryPolicy {
  defaultBytes: number;
  minBytes: number;
  maxBytes: number;
}

/**
 * Per-simulator `phys_footprint` of the whole tree including the runner. Round 6 (#15288)
 * measured 2.1–2.4 GiB settled; the default covers an unmeasured simulator with that plus
 * headroom, and `maxBytes` is only a sanity bound on a measured average.
 */
export const IOS_SIMULATOR_MEMORY_POLICY: PerDeviceMemoryPolicy = {
  defaultBytes: 2.5 * GIB,
  minBytes: 1.5 * GIB,
  maxBytes: 6 * GIB,
};

/**
 * An emulator's qemu process holds the guest RAM (2-4 GiB on typical AVDs) plus
 * emulator overhead, so the unmeasured default is larger than a simulator's.
 */
export const ANDROID_EMULATOR_MEMORY_POLICY: PerDeviceMemoryPolicy = {
  defaultBytes: 4 * GIB,
  minBytes: 1.5 * GIB,
  maxBytes: 8 * GIB,
};

/** Average measured memory (emulator RSS, simulator footprint) clamped to the policy's range, or its default when nothing was measured. */
export function estimatePerDeviceBytes(
  measuredRssBytes: readonly number[],
  policy: PerDeviceMemoryPolicy,
): number {
  if (measuredRssBytes.length === 0) {
    return policy.defaultBytes;
  }
  const average = measuredRssBytes.reduce((sum, bytes) => sum + bytes, 0) / measuredRssBytes.length;
  return Math.min(policy.maxBytes, Math.max(policy.minBytes, average));
}

/**
 * Raises a per-device estimate to at least the guest RAM the next AVD will resolve to
 * (`hardware-qemu.ini`, #15475), capped by the policy maximum. Never lowers the estimate: an
 * emulator's host footprint exceeds its guest RAM, so a small configured value saves nothing
 * until a device measurement says so.
 */
export function raisePerDeviceBytes(
  estimateBytes: number,
  candidateGuestBytes: number | undefined,
  policy: PerDeviceMemoryPolicy,
): number {
  if (candidateGuestBytes === undefined || !Number.isFinite(candidateGuestBytes)) {
    return estimateBytes;
  }
  return Math.min(policy.maxBytes, Math.max(estimateBytes, candidateGuestBytes));
}

/** One sampled emulator process, with identities when the source can provide them. */
export interface EmulatorMemoryRow {
  rssBytes: number;
  pid?: number;
  ppid?: number;
}

/** A boot counted as in flight by the same sample's admission ledger or host registry. */
export interface InFlightBootMemory {
  /** Device identity when memory is attributed per device rather than per process. */
  deviceId?: string;
  /** The device identity belongs to the old device awaiting replacement. */
  replacement?: boolean;
  processId?: number;
  handedOff: boolean;
}

/**
 * Size from settled emulators and in-flight boots, charging each boot at least the policy default.
 * Match every row by pid or parent pid. For handed-off boots whose process cannot be identified,
 * discard the smallest remaining rows, retaining the largest and flooring at the default when
 * all remaining rows could belong to those boots. An unavailable table keeps the default.
 */
export function estimateSettledPerDeviceBytes(
  rows: readonly EmulatorMemoryRow[] | undefined,
  inFlight: readonly InFlightBootMemory[],
  policy: PerDeviceMemoryPolicy,
): number {
  if (rows === undefined) {
    return policy.defaultBytes;
  }
  const inFlightBytes = inFlight.map((boot) => {
    const measured =
      boot.processId === undefined
        ? 0
        : rows.reduce(
            (sum, row) =>
              row.pid === boot.processId || row.ppid === boot.processId ? sum + row.rssBytes : sum,
            0,
          );
    return Math.max(measured, policy.defaultBytes);
  });
  const processIds = new Set(inFlight.map((boot) => boot.processId));
  processIds.delete(undefined);
  const remaining = rows
    .filter((row) => !processIds.has(row.pid) && !processIds.has(row.ppid))
    .map((row) => row.rssBytes)
    .sort((a, b) => a - b);
  if (remaining.length === 0) {
    return estimatePerDeviceBytes(inFlightBytes, policy);
  }
  const hasProcessIds = rows.some((row) => row.pid !== undefined || row.ppid !== undefined);
  const unmatchable = inFlight.filter(
    (boot) => boot.handedOff && (boot.processId === undefined || !hasProcessIds),
  ).length;
  const settled = remaining.slice(Math.min(unmatchable, remaining.length - 1));
  const sum = settled.reduce((total, bytes) => total + bytes, 0);
  const average = sum / settled.length;
  const charged =
    (sum + inFlightBytes.reduce((total, bytes) => total + bytes, 0)) /
    (settled.length + inFlight.length);
  const floor = unmatchable >= remaining.length ? policy.defaultBytes : policy.minBytes;
  return Math.min(policy.maxBytes, Math.max(policy.minBytes, floor, average, charged));
}

/**
 * Max concurrently booted devices: the smaller of the memory budget and the
 * core budget (at least 1), unless `envName` supplies a positive integer.
 */
export function resolveBootCapacityLimits(
  env: NodeJS.ProcessEnv,
  envName: string,
  resources: CapacityHostResources,
  {
    perDeviceBytes,
    coresPerDevice = CORES_PER_DEVICE,
  }: { perDeviceBytes: number; coresPerDevice?: number },
): CapacityLimits {
  const raw = env[envName];
  const override = parseOverride(raw);
  if (override !== undefined) {
    return { maxBooted: override, source: "env" };
  }
  const byMemory = Math.floor(
    (resources.totalMemoryBytes * MEMORY_BUDGET_FRACTION) / perDeviceBytes,
  );
  const byCpu = Math.floor(resources.cpuCount / Math.max(1, coresPerDevice));
  const derived: CapacityLimits = {
    maxBooted: Math.max(1, Math.min(byMemory, byCpu)),
    source: "derived",
  };
  return raw === undefined || raw.trim() === ""
    ? derived
    : {
        ...derived,
        warning: `${envName}=${JSON.stringify(raw)} is not a positive integer; using the derived limit`,
      };
}

export function parseOverride(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return undefined;
  }
  const value = Number(raw.trim());
  return value >= 1 ? value : undefined;
}
