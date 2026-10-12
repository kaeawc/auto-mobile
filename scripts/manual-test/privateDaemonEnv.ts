import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_DAEMON_PORT, resolveDaemonStatePath } from "../../src/daemon/constants";
import { isDaemonNamespaceIsolated } from "../../src/daemon/sharedNamespaceGuard";
import { resolveAuxSocketDir } from "../../src/daemon/socketServer/SocketServerTypes";
import { resolveDatabasePathFromEnvironment } from "../../src/db/database";
import { MANAGED_SLOT_CONFIG_ENV } from "../../src/models/managedSlotConfig";
import { shellQuote } from "../../src/utils/shellQuote";
import { errorMessage } from "../../src/utils/describeUnknownError";
import {
  getAdbServerScopedAutoMobileDir,
  getSharedAutoMobileDir,
  resolveAutoMobileBaseDir,
  resolveAutoMobileLogsDir,
} from "../../src/utils/tempDir";

export interface PrivateDaemonBatchOptions {
  batchDir: string;
  count: number;
  basePort: number;
  auxRoot?: string;
  serverPath: string;
  splitAdbCoordination?: boolean;
  orphanIdleMs?: number;
  extraEnv?: Record<string, string>;
}
export interface PrivateDaemonSpec {
  index: number;
  name: string;
  port: number;
  dir: string;
  pidFilePath: string;
  plainPidFilePath: string;
  socketPath: string;
  auxSocketDir: string;
  logDir: string;
  adbServerCoordinationDir: string;
  env: Record<string, string>;
}
export interface HostDefaults {
  homeDirs: string[];
  uid: number | string;
  canonicalize(path: string): string;
}

/** Paths every private launcher and client must supply. */
export const DERIVED_PATH_VARIABLES: readonly string[] = [
  "AUTOMOBILE_DATA_DIR",
  "AUTOMOBILE_LOG_DIR",
  "AUTOMOBILE_DB_DIR",
  "AUTOMOBILE_COORDINATION_DIR",
  "AUTOMOBILE_ADB_SERVER_COORDINATION_DIR",
  "AUTOMOBILE_AUX_SOCKET_DIR",
  "AUTOMOBILE_DAEMON_SOCKET_PATH",
  "AUTOMOBILE_DAEMON_PID_FILE_PATH",
  "AUTOMOBILE_DAEMON_LOCK_FILE_PATH",
  "AUTOMOBILE_DAEMON_LAUNCH_LOG_PATH",
];
const INHERITED_PATH_OVERRIDES = ["AUTOMOBILE_DB_PATH", "AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH"];
export const INHERITED_ENV_VARIABLES: readonly string[] = [
  ...DERIVED_PATH_VARIABLES.map((key) => key.replace("AUTOMOBILE_", "AUTO_MOBILE_")),
  ...INHERITED_PATH_OVERRIDES,
  ...INHERITED_PATH_OVERRIDES.map((key) => key.replace("AUTOMOBILE_", "AUTO_MOBILE_")),
  MANAGED_SLOT_CONFIG_ENV,
];
const OWNED_ENV_VARIABLES = [
  ...DERIVED_PATH_VARIABLES,
  ...INHERITED_PATH_OVERRIDES,
  "MT_BATCH",
  "MT_DAEMON",
  "MT_SERVER",
  "MT_PORT",
];
export function isInheritedPathOverride(key: string): boolean {
  return (
    key.startsWith("AUTO_MOBILE_") ||
    (key !== MANAGED_SLOT_CONFIG_ENV && INHERITED_ENV_VARIABLES.includes(key))
  );
}
export function privateClientEnvironment(
  inherited: Record<string, string | undefined>,
  overrides: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined && key !== MANAGED_SLOT_CONFIG_ENV && !isInheritedPathOverride(key)) {
      env[key] = value;
    }
  }
  return { ...env, ...overrides };
}
export interface CanonicalizePathFs {
  realpath(path: string): string;
  lstat(path: string): { isSymbolicLink(): boolean };
  readlink(path: string): string;
}
function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
/** Resolve aliases and dangling links without opening special files such as sockets. */
export function canonicalizePath(path: string, fs: CanonicalizePathFs): string {
  function canonicalize(current: string, depth: number): string {
    try {
      return fs.realpath(current);
    } catch (error) {
      // Missing paths and unopened special files require resolving their parent instead.
      if (
        (typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ELOOP") ||
        dirname(current) === current
      ) {
        throw error;
      }
      let symlink: boolean;
      try {
        symlink = fs.lstat(current).isSymbolicLink();
      } catch (statError) {
        // A missing leaf has no link target; unreadable metadata must still fail closed.
        if (!isMissingPathError(statError) || !isMissingPathError(error)) {
          throw statError;
        }
        symlink = false;
      }
      if (symlink) {
        if (!isMissingPathError(error)) {
          throw error;
        }
        if (depth >= 8) {
          throw new Error(`Canonicalization symlink depth exceeded for ${current}`);
        }
        const parent = canonicalize(dirname(current), depth);
        return canonicalize(resolve(parent, fs.readlink(current)), depth + 1);
      }
      return join(canonicalize(dirname(current), depth), basename(current));
    }
  }
  return canonicalize(resolve(path.trim()), 0);
}
export function canonicalizeHostPath(path: string): string {
  return canonicalizePath(path, {
    realpath: realpathSync,
    lstat: lstatSync,
    readlink: readlinkSync,
  });
}
export function extraEnvRefusal(env: Record<string, string>): string | undefined {
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) {
      return `Invalid --env assignment for ${key}; use a shell variable name and a value without NUL.`;
    }
    if (
      OWNED_ENV_VARIABLES.includes(key) ||
      isInheritedPathOverride(key) ||
      key === MANAGED_SLOT_CONFIG_ENV
    ) {
      return `--env may not override ${key}; the harness owns its private namespace.`;
    }
    if (
      key === "AUTOMOBILE_APPEARANCE_SYNC" ||
      key === "AUTOMOBILE_PRIVATE_DAEMON_ORPHAN_IDLE_MS"
    ) {
      return `Use the harness options for ${key}; it is derived by the launcher.`;
    }
  }
  return undefined;
}
export function derivePrivateDaemonBatch(options: PrivateDaemonBatchOptions): PrivateDaemonSpec[] {
  // Invalid counts must be refusals, never an unbounded allocation.
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 8) {
    return [];
  }
  const auxRoot =
    options.auxRoot ??
    `/tmp/am-mt-${createHash("sha256").update(options.batchDir).digest("hex").slice(0, 8)}`;
  return Array.from({ length: options.count }, (_, offset) => {
    const index = offset + 1;
    const dir = join(options.batchDir, `daemon${index}`);
    const auxSocketDir = join(auxRoot, String(index));
    const env: Record<string, string> = {
      ...options.extraEnv,
      AUTOMOBILE_DATA_DIR: join(dir, "data"),
      AUTOMOBILE_LOG_DIR: join(dir, "logs"),
      AUTOMOBILE_DB_DIR: join(dir, "db"),
      AUTOMOBILE_COORDINATION_DIR: join(dir, "coordination"),
      AUTOMOBILE_ADB_SERVER_COORDINATION_DIR: options.splitAdbCoordination
        ? join(dir, "adb-servers")
        : join(options.batchDir, "shared", "adb-servers"),
      AUTOMOBILE_AUX_SOCKET_DIR: auxSocketDir,
      // Keep the control socket short even when the evidence root is deeply nested.
      AUTOMOBILE_DAEMON_SOCKET_PATH: join(auxSocketDir, "d.sock"),
      AUTOMOBILE_DAEMON_PID_FILE_PATH: join(dir, "daemon.pid"),
      AUTOMOBILE_DAEMON_LOCK_FILE_PATH: join(dir, "daemon.lock"),
      AUTOMOBILE_DAEMON_LAUNCH_LOG_PATH: join(dir, "launch.log"),
      AUTOMOBILE_PRIVATE_DAEMON_ORPHAN_IDLE_MS: String(options.orphanIdleMs ?? 0),
      AUTOMOBILE_APPEARANCE_SYNC: "off",
      MT_BATCH: options.batchDir,
      MT_DAEMON: `P${index}`,
      MT_SERVER: options.serverPath,
      MT_PORT: String(options.basePort + offset),
    };
    return {
      index,
      name: `P${index}`,
      port: options.basePort + offset,
      dir,
      pidFilePath: env.AUTOMOBILE_DAEMON_PID_FILE_PATH,
      plainPidFilePath: join(dir, "pid.txt"),
      socketPath: env.AUTOMOBILE_DAEMON_SOCKET_PATH,
      auxSocketDir,
      logDir: env.AUTOMOBILE_LOG_DIR,
      adbServerCoordinationDir: env.AUTOMOBILE_ADB_SERVER_COORDINATION_DIR,
      env,
    };
  });
}
function inside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
/** Shared launcher/client boundary: canonical host defaults and resident basenames. */
export function privatePathRefusal(candidate: string, host: HostDefaults): string | undefined {
  const value = candidate.trim();
  if (!isAbsolute(value) || value.includes("\0")) {
    return `Private path must be absolute without NUL: ${candidate}`;
  }
  let canonicalizing = value;
  const canonicalize = (path: string): string => {
    canonicalizing = path;
    return host.canonicalize(path);
  };
  try {
    const canonicalValue = canonicalize(value);
    for (const home of host.homeDirs) {
      const base = resolveAutoMobileBaseDir({}, home, home);
      // Product path resolvers are lazy and these explicit defaults keep the boundary host-independent.
      const roots = [
        base,
        resolveAutoMobileLogsDir({}, home, home),
        dirname(resolveDatabasePathFromEnvironment({}, base)),
        getSharedAutoMobileDir("", home, {}),
        getAdbServerScopedAutoMobileDir("", "", {}, home),
        resolveAuxSocketDir({ AUTOMOBILE_AUX_SOCKET_DIR: base }),
      ];
      if (roots.some((root) => inside(canonicalValue, canonicalize(root)))) {
        return `Refusing default product state path ${candidate}; choose a private batch/aux root outside the host defaults.`;
      }
    }
    for (const ext of ["sock", "pid", "lock"] as const) {
      const resident = resolveDaemonStatePath(ext, {}, String(host.uid));
      if (canonicalValue === canonicalize(resident) || basename(value) === basename(resident)) {
        return `Refusing resident daemon path ${candidate}; choose a private namespace.`;
      }
    }
  } catch (error) {
    // The CLI reports this refusal through its normal exit-2 path before any I/O.
    return `Refusing private path ${candidate}; cannot canonicalize ${canonicalizing}: ${errorMessage(error)}`;
  }
  return undefined;
}
export function privateDaemonBatchRefusal(
  specs: PrivateDaemonSpec[],
  options: PrivateDaemonBatchOptions,
  host: HostDefaults,
): string | undefined {
  for (const [name, value] of [
    ["batchDir", options.batchDir],
    ["auxRoot", options.auxRoot],
    ["serverPath", options.serverPath],
  ]) {
    if (value !== undefined && (!isAbsolute(value) || value.includes("\0"))) {
      return `${name} must be an absolute path without NUL.`;
    }
  }
  if (
    !Number.isInteger(options.count) ||
    options.count < 1 ||
    options.count > 8 ||
    specs.length !== options.count
  ) {
    return "count must be an integer from 1 to 8, with one spec per daemon.";
  }
  if (
    !Number.isInteger(options.basePort) ||
    options.basePort < 1 ||
    options.basePort + options.count - 1 > 65535
  ) {
    return "Choose valid TCP ports between 1 and 65535.";
  }
  if (!Number.isSafeInteger(options.orphanIdleMs ?? 0) || (options.orphanIdleMs ?? 0) < 0) {
    return "orphanIdleMs must be a non-negative safe integer.";
  }
  const extra = extraEnvRefusal(options.extraEnv ?? {});
  if (extra) {
    return extra;
  }
  const ports = new Set<number>();
  for (const spec of specs) {
    if (
      !Number.isInteger(spec.port) ||
      spec.port < 1 ||
      spec.port > 65535 ||
      spec.port === DEFAULT_DAEMON_PORT ||
      ports.has(spec.port)
    ) {
      return "Choose distinct valid ports away from DEFAULT_DAEMON_PORT.";
    }
    ports.add(spec.port);
    const paths = [
      options.batchDir,
      options.serverPath,
      ...(options.auxRoot ? [options.auxRoot] : []),
      spec.dir,
      spec.pidFilePath,
      spec.plainPidFilePath,
      spec.socketPath,
      spec.auxSocketDir,
      spec.logDir,
      spec.adbServerCoordinationDir,
      ...DERIVED_PATH_VARIABLES.flatMap((key) => (spec.env[key] ? [spec.env[key]] : [])),
    ];
    for (const candidate of paths) {
      const refusal = privatePathRefusal(candidate, host);
      if (refusal) {
        return refusal;
      }
    }
    if (!isDaemonNamespaceIsolated(spec.env)) {
      return "Private env must isolate the daemon namespace.";
    }
    // Longest published auxiliary filenames in src/daemon/daemonFiles.ts.
    if (
      Buffer.byteLength(join(spec.auxSocketDir, "performance-stream.sock")) > 103 ||
      Buffer.byteLength(spec.socketPath) > 103
    ) {
      return "Aux/control socket path exceeds 103 bytes; choose a shorter --aux-root.";
    }
  }
  return undefined;
}
export function renderEnvFile(spec: PrivateDaemonSpec, options: PrivateDaemonBatchOptions): string {
  return (
    `# Private manual-test daemon ${spec.index}; source in the client shell.\n` +
    Object.entries(spec.env)
      .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
      .join("\n") +
    "\n" +
    INHERITED_ENV_VARIABLES.map((key) => `unset ${key}\n`).join("")
  );
}
