import { EMULATOR_FLAG_PROP } from "../../utils/android-cmdline-tools/deviceTraits";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";

/**
 * Root and emulator detection signals (#14062): what a device currently presents to
 * RootBeer-, Talsec- and EmulatorDetector-style checks, and whether each signal can
 * be changed at runtime. `ro.*` build props are fixed by the system image, so an
 * emulator can never hide them; reporting them as `image-fixed` is the point,
 * rather than silently ignoring a request to toggle them.
 */
type IntegritySignalFamily = "root" | "emulator";

/**
 * - `runtime`: toggleable with no special privilege.
 * - `needs-root`: toggleable only after `adb root` (and a writable `/system` for files).
 * - `image-fixed`: baked into the system image; only a different image changes it.
 */
type IntegritySignalMutability = "runtime" | "needs-root" | "image-fixed";

interface IntegritySignal {
  id: string;
  family: IntegritySignalFamily;
  description: string;
  mutability: IntegritySignalMutability;
}

export interface IntegritySignalReading extends IntegritySignal {
  /** True when the device presents this signal to a detector. */
  active: boolean;
}

/** The declarative signal catalogue; the probe below reads each one. */
export const INTEGRITY_SIGNALS: readonly IntegritySignal[] = [
  {
    id: "su-binary",
    family: "root",
    description: "su binary in a RootBeer suPaths directory",
    mutability: "needs-root",
  },
  {
    id: "superuser-apk",
    family: "root",
    description: "/system/app/Superuser.apk",
    mutability: "needs-root",
  },
  {
    id: "selinux-permissive",
    family: "root",
    description: "SELinux is permissive",
    mutability: "needs-root",
  },
  {
    id: "debuggable-build",
    family: "root",
    description: "ro.debuggable=1",
    mutability: "image-fixed",
  },
  {
    id: "insecure-build",
    family: "root",
    description: "ro.secure=0",
    mutability: "image-fixed",
  },
  {
    id: "test-keys",
    family: "root",
    description: "ro.build.tags contains test-keys",
    mutability: "image-fixed",
  },
  {
    id: "missing-otacerts",
    family: "root",
    description: "/etc/security/otacerts.zip is absent",
    mutability: "image-fixed",
  },
  {
    id: "qemu-props",
    family: "emulator",
    description: "ro.kernel.qemu / ro.boot.qemu set",
    mutability: "image-fixed",
  },
  {
    id: "emulator-hardware",
    family: "emulator",
    description: "ro.hardware is goldfish or ranchu",
    mutability: "image-fixed",
  },
  {
    id: "qemu-pipe",
    family: "emulator",
    description: "/dev/qemu_pipe exists",
    mutability: "image-fixed",
  },
  {
    id: "emulator-build-fields",
    family: "emulator",
    description: "Build FINGERPRINT/MODEL/PRODUCT look like an emulator (sdk_gphone, generic)",
    mutability: "image-fixed",
  },
];

/** Parse `getprop` output (`[key]: [value]` lines) into a map. */
export function parseGetprop(output: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = /^\[([^\]]+)\]: \[(.*)\]\s*$/.exec(line.trim());
    if (match) {
      props.set(match[1], match[2]);
    }
  }
  return props;
}

/** RootBeer-style suPaths and artifacts the probe lists; the rootState fixture plants the same set. */
const SU_PATHS = [
  "/system/xbin/su",
  "/system/bin/su",
  "/system/xbin/busybox",
  "/system/bin/busybox",
] as const;
const SUPERUSER_APK = "/system/app/Superuser.apk";

const EMULATOR_BUILD_PATTERN = /sdk_gphone|generic|emulator|ranchu|goldfish|vbox/i;

interface DeviceReads {
  props: Map<string, string>;
  selinux: string;
  /** Paths that exist, or undefined when the path read itself failed (absence is then unknown). */
  presentPaths: Set<string> | undefined;
}

const prop = (reads: DeviceReads, key: string): string => reads.props.get(key) ?? "";
const hasPath = (reads: DeviceReads, path: string): boolean =>
  reads.presentPaths?.has(path) === true;

/** One predicate per catalogued signal id; an id with no predicate reads as inactive. */
const SIGNAL_READERS: Readonly<Record<string, (reads: DeviceReads) => boolean>> = {
  "su-binary": (reads) => SU_PATHS.some((path) => /\/su$/.test(path) && hasPath(reads, path)),
  "superuser-apk": (reads) => hasPath(reads, SUPERUSER_APK),
  "selinux-permissive": (reads) => /permissive/i.test(reads.selinux),
  "debuggable-build": (reads) => prop(reads, "ro.debuggable") === "1",
  "insecure-build": (reads) => prop(reads, "ro.secure") === "0",
  "test-keys": (reads) => prop(reads, "ro.build.tags").includes("test-keys"),
  // Absence is only established by a successful read; a failed read leaves the signal off.
  "missing-otacerts": (reads) =>
    reads.presentPaths !== undefined && !reads.presentPaths.has("/etc/security/otacerts.zip"),
  "qemu-props": (reads) =>
    [EMULATOR_FLAG_PROP, "ro.boot.qemu"].some((key) => ["1", "true"].includes(prop(reads, key))),
  "emulator-hardware": (reads) => /^(goldfish|ranchu)$/.test(prop(reads, "ro.hardware")),
  "qemu-pipe": (reads) => hasPath(reads, "/dev/qemu_pipe"),
  "emulator-build-fields": (reads) =>
    ["ro.build.fingerprint", "ro.product.model", "ro.product.name"].some((key) =>
      EMULATOR_BUILD_PATTERN.test(prop(reads, key)),
    ),
};

const isActive = (id: string, reads: DeviceReads): boolean => SIGNAL_READERS[id]?.(reads) ?? false;

/** Run one read-only shell command; undefined means the read failed (and was logged). */
async function shellOut(
  adb: Pick<AdbExecutor, "execute">,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const result = await adb.execute(["shell", ...args], { signal });
    if (result.error) {
      logger.warn(`integrity probe 'shell ${args[0]}' returned an error: ${result.error}`);
      return undefined;
    }
    return result.stdout.replace(/\r\n?/g, "\n").trim();
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    // Best-effort read: a failed sub-probe leaves its signals inactive, but is logged.
    logger.warn(`integrity probe 'shell ${args[0]}' failed: ${errorMessage(error)}`, error);
    return undefined;
  }
}

const PROBED_PATHS = [...SU_PATHS, SUPERUSER_APK, "/etc/security/otacerts.zip", "/dev/qemu_pipe"];

/**
 * Read every catalogued signal from one device with read-only shell commands.
 * A failed sub-read leaves its signals inactive (absence-based ones included)
 * rather than failing the probe.
 */
export async function readIntegritySignals(
  adb: Pick<AdbExecutor, "execute">,
  signal?: AbortSignal,
): Promise<IntegritySignalReading[]> {
  const props = parseGetprop((await shellOut(adb, ["getprop"], signal)) ?? "");
  const selinux = (await shellOut(adb, ["getenforce"], signal)) ?? "";
  // adb joins these words for the device shell. `ls` exits nonzero when ANY operand is
  // missing (the normal case on a stock device) even though it still lists the ones that
  // exist, and the adb client rejects a nonzero exit, so `; true` keeps the partial listing.
  const listing = await shellOut(
    adb,
    ["ls", "-d", ...PROBED_PATHS, "2>/dev/null;", "true"],
    signal,
  );
  const presentPaths =
    listing === undefined ? undefined : new Set(listing.split("\n").map((line) => line.trim()));
  const reads: DeviceReads = { props, selinux, presentPaths };
  return INTEGRITY_SIGNALS.map((entry) => ({ ...entry, active: isActive(entry.id, reads) }));
}
