const GIB = 1024 ** 3;

/** Share of host RAM booted devices may use; the rest stays for the IDE, the app under test and the OS. */
const MEMORY_BUDGET_FRACTION = 0.5;
/** One booted device is budgeted two cores. */
const CORES_PER_DEVICE = 2;

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

export const IOS_SIMULATOR_MEMORY_POLICY: PerDeviceMemoryPolicy = {
  defaultBytes: 3 * GIB,
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

/** Average measured RSS clamped to the policy's range, or its default when nothing was measured. */
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

/** One sampled emulator process, with identities when the source can provide them. */
export interface EmulatorMemoryRow {
  rssBytes: number;
  pid?: number;
  ppid?: number;
}

/** A boot counted as in flight by the same sample's admission ledger or host registry. */
export interface InFlightBootMemory {
  processId?: number;
  handedOff: boolean;
}

/**
 * Size from settled emulators only, charging each in-flight boot at least the policy default.
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
  const processIds = new Set(inFlight.map((boot) => boot.processId));
  processIds.delete(undefined);
  const remaining = rows
    .filter((row) => !processIds.has(row.pid) && !processIds.has(row.ppid))
    .map((row) => row.rssBytes)
    .sort((a, b) => a - b);
  if (remaining.length === 0) {
    return policy.defaultBytes;
  }
  const hasProcessIds = rows.some((row) => row.pid !== undefined || row.ppid !== undefined);
  const unmatchable = inFlight.filter(
    (boot) => boot.handedOff && (boot.processId === undefined || !hasProcessIds),
  ).length;
  const settled = remaining.slice(Math.min(unmatchable, remaining.length - 1));
  const sum = settled.reduce((total, bytes) => total + bytes, 0);
  const average = sum / settled.length;
  const charged =
    (sum + inFlight.length * policy.defaultBytes) / (settled.length + inFlight.length);
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
  perDeviceBytes: number,
): CapacityLimits {
  const raw = env[envName];
  const override = parseOverride(raw);
  if (override !== undefined) {
    return { maxBooted: override, source: "env" };
  }
  const byMemory = Math.floor(
    (resources.totalMemoryBytes * MEMORY_BUDGET_FRACTION) / perDeviceBytes,
  );
  const byCpu = Math.floor(resources.cpuCount / CORES_PER_DEVICE);
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

function parseOverride(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) {
    return undefined;
  }
  const value = Number(raw.trim());
  return value >= 1 ? value : undefined;
}
