import { simulatorProcessTree } from "../../../devices/bootAdmission/psSnapshot";
import { readHostProcessTable } from "../../../devices/bootAdmission/readHostProcessTable";
import type { HostProcessRow } from "../../../models/HostProcessRow";
import { toActionableError } from "../../../models/ActionableError";
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

async function readSockets(
  host: HostCommandExecutor,
  pids: readonly number[],
): Promise<LsofProcessSockets[]> {
  try {
    const result = await host.executeCommand(
      "lsof",
      ["-nP", "-a", "-i", "-p", pids.join(","), "-F", "pcPnT"],
      { timeoutMs: HOST_READ_TIMEOUT_MS, maxBuffer: HOST_READ_MAX_BUFFER_BYTES },
    );
    return parseLsofInternetSockets(result.stdout);
  } catch (error) {
    const failure = commandFailureDetails(error);
    if (failure.exitCode === 1 && failure.stdout.trim() === "") {
      // lsof exits 1 with no output when none of the pids holds an internet socket.
      logger.debug(`[networkActivity] lsof found no internet sockets: ${errorMessage(error)}`);
      return [];
    }
    throw toActionableError(error, "Failed to list simulator sockets with lsof");
  }
}

async function readBytes(host: HostCommandExecutor): Promise<Map<number, NettopProcessBytes>> {
  const result = await host.executeCommand(
    "nettop",
    ["-P", "-L", "1", "-x", "-J", "bytes_in,bytes_out"],
    { timeoutMs: HOST_READ_TIMEOUT_MS, maxBuffer: HOST_READ_MAX_BUFFER_BYTES },
  );
  return parseNettopProcessBytes(result.stdout);
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
    dependencies.listApps(),
  ]);
  const bundles = appBundles(apps);
  const socketsByPid = new Map(sockets.map((entry) => [entry.pid, entry]));
  const processes = tree
    .map((row) => toProcess(row, socketsByPid.get(row.pid), bytes.get(row.pid), bundles))
    .filter((process) => process.sockets.length > 0 || process.bytesIn > 0 || process.bytesOut > 0);
  return { supported: true, processCount: tree.length, processes };
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
