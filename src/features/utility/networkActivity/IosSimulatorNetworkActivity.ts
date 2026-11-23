import { simulatorProcessTree } from "../../../devices/bootAdmission/psSnapshot";
import { readHostProcessTable } from "../../../devices/bootAdmission/readHostProcessTable";
import type { HostProcessRow } from "../../../models/HostProcessRow";
import { errorMessage } from "../../../models/describeUnknownError";
import { commandFailureDetails } from "../../../utils/CommandError";
import type { HostCommandExecutor } from "../../../utils/HostCommandExecutor";
import { logger } from "../../../utils/logger";
import {
  getIosInstalledAppBundleId,
  getIosInstalledAppPath,
  type IosInstalledAppRecord,
} from "../../../utils/ios-cmdline-tools/iosInstalledApp";
import type { NetworkActivityProcess, NetworkActivityState } from "./NetworkActivityTypes";
import {
  parseLsofInternetSockets,
  parseNettopProcessBytes,
  type LsofProcessSockets,
  type NettopProcessBytes,
} from "./networkActivityParsers";

const HOST_READ_TIMEOUT_MS = 15_000;
const HOST_READ_MAX_BUFFER_BYTES = 16 * 1024 ** 2;

/** Every unprivileged host read the snapshot needs, so tests drive it with fakes. */
export interface IosSimulatorNetworkActivityDependencies {
  host: HostCommandExecutor;
  /** `simctl listapps` records of the simulator, for executable-path app attribution. */
  listApps: () => Promise<IosInstalledAppRecord[]>;
}

/**
 * `ps` shows runtime-root executables under `/var/run/...` while `simctl listapps` names the
 * same bundle `/private/var/run/...`; compare both without the `/private` firmlink prefix.
 */
function withoutPrivatePrefix(path: string): string {
  return path.startsWith("/private/") ? path.slice("/private".length) : path;
}

interface AppBundle {
  appId: string;
  prefix: string;
}

function appBundles(apps: readonly IosInstalledAppRecord[]): AppBundle[] {
  return apps
    .map((app) => ({
      appId: getIosInstalledAppBundleId(app),
      path: getIosInstalledAppPath(app),
    }))
    .filter((app): app is { appId: string; path: string } => !!app.appId && !!app.path)
    .map((app) => ({
      appId: app.appId,
      prefix: `${withoutPrivatePrefix(app.path).replace(/\/+$/, "")}/`,
    }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
}

/** The app whose bundle holds the process executable; the longest bundle path wins. */
function appIdFor(row: HostProcessRow, bundles: readonly AppBundle[]): string | undefined {
  const command = withoutPrivatePrefix(row.command);
  return bundles.find((bundle) => command.startsWith(bundle.prefix))?.appId;
}

/** Executable basename from a `ps` command line, for processes lsof and nettop did not name. */
function commandName(row: HostProcessRow): string {
  const executable = row.command.split(" ")[0] ?? row.command;
  return executable.slice(executable.lastIndexOf("/") + 1) || row.command;
}

/** Most processes returned; the busiest by bytes, then sockets, are kept. */
export const MAX_NETWORK_ACTIVITY_PROCESSES = 50;

interface ToolRead<T> {
  value: T;
  warning?: string;
}

function degraded<T>(value: T, tool: string, error: unknown, effect: string): ToolRead<T> {
  logger.warn(`[networkActivity] ${tool} failed: ${errorMessage(error)}`, error);
  return { value, warning: `${tool} failed, ${effect}: ${errorMessage(error)}` };
}

async function readSockets(
  host: HostCommandExecutor,
  pids: readonly number[],
): Promise<ToolRead<LsofProcessSockets[]>> {
  try {
    const result = await host.executeCommand(
      "lsof",
      ["-nP", "-a", "-i", "-p", pids.join(","), "-F", "pcPnT"],
      { timeoutMs: HOST_READ_TIMEOUT_MS, maxBuffer: HOST_READ_MAX_BUFFER_BYTES },
    );
    return { value: parseLsofInternetSockets(result.stdout) };
  } catch (error) {
    const failure = commandFailureDetails(error);
    if (failure.exitCode === 1 && (failure.stdout.trim() !== "" || failure.stderr.trim() === "")) {
      // lsof exits 1 when any listed pid has already exited, or when none holds an internet
      // socket, and still prints the sockets it found.
      return { value: parseLsofInternetSockets(failure.stdout) };
    }
    return degraded([], "lsof", error, "sockets are missing");
  }
}

async function readBytes(
  host: HostCommandExecutor,
): Promise<ToolRead<Map<number, NettopProcessBytes>>> {
  try {
    const result = await host.executeCommand(
      "nettop",
      ["-P", "-L", "1", "-x", "-J", "bytes_in,bytes_out"],
      { timeoutMs: HOST_READ_TIMEOUT_MS, maxBuffer: HOST_READ_MAX_BUFFER_BYTES },
    );
    return { value: parseNettopProcessBytes(result.stdout) };
  } catch (error) {
    return degraded(new Map(), "nettop", error, "byte counts are 0");
  }
}

async function readApps(
  listApps: () => Promise<IosInstalledAppRecord[]>,
): Promise<ToolRead<IosInstalledAppRecord[]>> {
  try {
    return { value: await listApps() };
  } catch (error) {
    return degraded([], "simctl listapps", error, "appId is omitted");
  }
}

function busiest(a: NetworkActivityProcess, b: NetworkActivityProcess): number {
  return (
    b.bytesIn + b.bytesOut - (a.bytesIn + a.bytesOut) ||
    b.sockets.length - a.sockets.length ||
    a.pid - b.pid
  );
}

/**
 * Sockets and traffic of every process of one simulator, read from the host with no privileges:
 * simulator processes run on the host as the same user. `ps` finds the processes under the
 * simulator's `launchd_sim`, `lsof` lists their internet sockets and `nettop` their byte counts.
 * nettop counts the sockets open when it samples, so a connection that closed earlier is not in
 * the totals.
 */
export async function readIosSimulatorNetworkActivity(
  udid: string,
  dependencies: IosSimulatorNetworkActivityDependencies,
): Promise<NetworkActivityState> {
  const tree = simulatorProcessTree(
    await readHostProcessTable(dependencies.host, { timeoutMs: HOST_READ_TIMEOUT_MS }),
    udid,
  );
  if (tree.length === 0) {
    return {
      supported: true,
      error: `No processes found under launchd_sim for simulator ${udid}; is it booted?`,
    };
  }
  const [sockets, bytes, apps] = await Promise.all([
    readSockets(
      dependencies.host,
      tree.map((row) => row.pid),
    ),
    readBytes(dependencies.host),
    readApps(dependencies.listApps),
  ]);
  const bundles = appBundles(apps.value);
  const socketsByPid = new Map(sockets.value.map((entry) => [entry.pid, entry]));
  const active = tree
    .map((row) => toProcess(row, socketsByPid.get(row.pid), bytes.value.get(row.pid), bundles))
    .filter((process) => process.sockets.length > 0 || process.bytesIn > 0 || process.bytesOut > 0)
    .sort(busiest);
  const warnings = [sockets.warning, bytes.warning, apps.warning].filter(
    (warning): warning is string => warning !== undefined,
  );
  return {
    supported: true,
    processCount: tree.length,
    activeProcessCount: active.length,
    ...(active.length > MAX_NETWORK_ACTIVITY_PROCESSES ? { truncated: true } : {}),
    processes: active.slice(0, MAX_NETWORK_ACTIVITY_PROCESSES),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function toProcess(
  row: HostProcessRow,
  sockets: LsofProcessSockets | undefined,
  bytes: NettopProcessBytes | undefined,
  bundles: readonly AppBundle[],
): NetworkActivityProcess {
  const appId = appIdFor(row, bundles);
  return {
    pid: row.pid,
    name: sockets?.command || bytes?.name || commandName(row),
    ...(appId ? { appId } : {}),
    sockets: sockets?.sockets ?? [],
    bytesIn: bytes?.bytesIn ?? 0,
    bytesOut: bytes?.bytesOut ?? 0,
  };
}
