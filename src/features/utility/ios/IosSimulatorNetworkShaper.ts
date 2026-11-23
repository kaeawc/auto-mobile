import { join } from "node:path";
import { ActionableError } from "../../../models/ActionableError";
import { SingleFlight } from "../../../utils/cache/SingleFlight";
import { formatCommandError } from "../../../utils/CommandError";
import { errorMessage } from "../../../utils/describeUnknownError";
import { DefaultFileSystem, type FileSystem } from "../../../utils/filesystem/DefaultFileSystem";
import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../../utils/HostCommandExecutor";
import { defaultIdGenerator, type IdGenerator } from "../../../utils/IdGenerator";
import type { HostProcessRow } from "../../../models/HostProcessRow";
import { readHostProcessTable } from "../../../devices/bootAdmission/readHostProcessTable";
import { logger } from "../../../utils/logger";
import { isProcessRunning } from "../../../utils/processLiveness";
import {
  ctrlProxyClientLifecycle,
  type CtrlProxyClientLifecycle,
} from "../../observe/ctrlProxyClientLifecycle";
import { getTempDir } from "../../../utils/tempDir";
import {
  DefaultIosNetworkShaperDylibProvider,
  type IosNetworkShaperDylibProvider,
} from "./IosNetworkShaperDylibProvider";

/**
 * A simulator-wide shaping profile. Zero means "no limit" for every numeric field;
 * `packetLossPercent` is the percent of new connections that time out (TCP) or
 * datagrams dropped (UDP).
 */
export interface IosNetworkShaperProfile {
  offline: boolean;
  delayMs: number;
  downloadKbps: number;
  uploadKbps: number;
  packetLossPercent: number;
}

export interface IosNetworkShaperApplyResult {
  /** True when the simulator was shut down and booted with the shaper (running apps were terminated). */
  rebooted: boolean;
}

export interface IosNetworkShaperReadResult {
  /** The simulator's launchd runs with this build of the shaper and this simulator's profile file. */
  injected: boolean;
  /** The profile file's current contents, when one was written. */
  profile?: IosNetworkShaperProfile;
}

/**
 * Device-wide iOS Simulator network shaping with no network extension, root or
 * MDM (#19045). The simulator boots with the shaper dylib in launchd's
 * environment, so every process in the device loads it (WebKit's networking
 * extension and system daemons included). Profiles change live: the shaper
 * re-reads its profile file within 250 ms.
 */
export interface IosSimulatorNetworkShaper {
  /** Writes the profile, rebooting the simulator with the shaper first when it is not injected. */
  apply(udid: string, profile: IosNetworkShaperProfile): Promise<IosNetworkShaperApplyResult>;
  /**
   * Removes shaping without a reboot by deleting the profile file: the injected
   * shaper passes traffic through, and later reads skip the process scan.
   */
  clear(udid: string): Promise<void>;
  /** Cheap when no profile is active: no profile file, no process scan. */
  read(udid: string): Promise<IosNetworkShaperReadResult>;
  /**
   * Deletes every profile whose writing process is gone, unshaping each simulator
   * a crashed or stopped daemon left shaped; returns the UDIDs cleared.
   */
  clearOrphaned(): Promise<string[]>;
}

/** The environment variable the shaper reads its profile path from. */
export const IOS_NETWORK_SHAPER_PROFILE_ENV = "SIM_RS_NETSHAPE";
const BOOT_TIMEOUT_MS = 180_000;
const COMMAND_TIMEOUT_MS = 60_000;

type ShaperFileSystem = Pick<
  FileSystem,
  "existsSync" | "readFile" | "writeFile" | "ensureDir" | "rename" | "unlink" | "readdir"
>;

/** The CtrlProxy client fence a shaped reboot runs around, as other simulator stops do. */
export type ShaperRebootLifecycle = Pick<
  CtrlProxyClientLifecycle,
  "retireForShutdown" | "resumeAfterDeviceStart"
>;

export interface IosSimulatorNetworkShaperDependencies {
  runner?: HostCommandExecutor;
  fileSystem?: ShaperFileSystem;
  dylibProvider?: IosNetworkShaperDylibProvider;
  idGenerator?: IdGenerator;
  env?: NodeJS.ProcessEnv;
  /** Where per-simulator profile files live. */
  profileDirectory?: () => string;
  lifecycle?: ShaperRebootLifecycle;
  /** The pid recorded as a profile's owner; defaults to this process. */
  ownerPid?: number;
  isProcessRunning?: (pid: number) => boolean;
}

export class DefaultIosSimulatorNetworkShaper implements IosSimulatorNetworkShaper {
  private readonly runner: HostCommandExecutor;
  private readonly fs: ShaperFileSystem;
  private readonly env: NodeJS.ProcessEnv;
  /** One injection check and reboot per simulator, however many applies race. */
  private readonly injections = new SingleFlight<string, boolean>();

  constructor(private readonly deps: IosSimulatorNetworkShaperDependencies = {}) {
    this.runner = deps.runner ?? new DefaultHostCommandExecutor();
    this.fs = deps.fileSystem ?? new DefaultFileSystem();
    this.env = deps.env ?? process.env;
  }

  profilePath(udid: string): string {
    return join(this.profilesDirectory(), `${udid.toUpperCase()}.conf`);
  }

  private profilesDirectory(): string {
    const directory = (this.deps.profileDirectory ?? (() => getTempDir("ios-network-shaper")))();
    return join(directory, "profiles");
  }

  async apply(
    udid: string,
    profile: IosNetworkShaperProfile,
  ): Promise<IosNetworkShaperApplyResult> {
    const dylib = await this.dylibProvider().ensure();
    const profilePath = this.profilePath(udid);
    // Written first so the condition holds from the first process of a shaped boot.
    await this.writeProfile(profilePath, profile);
    await this.fs.writeFile(ownerPath(profilePath), `${this.deps.ownerPid ?? process.pid}\n`);
    // A concurrent apply joins this flight instead of rebooting the simulator a second time.
    const rebooted = await this.injections.run(udid.toUpperCase(), async () => {
      if (await this.isInjected(udid, dylib, profilePath)) {
        return false;
      }
      await this.rebootShaped(udid, dylib, profilePath);
      return true;
    });
    return { rebooted };
  }

  async clear(udid: string): Promise<void> {
    const profilePath = this.profilePath(udid);
    await this.removeProfile(profilePath);
  }

  private async removeProfile(profilePath: string): Promise<void> {
    // The shaper treats a missing profile file as unshaped.
    for (const path of [profilePath, ownerPath(profilePath)]) {
      if (this.fs.existsSync(path)) {
        await this.fs.unlink(path);
      }
    }
  }

  async clearOrphaned(): Promise<string[]> {
    const directory = this.profilesDirectory();
    if (!this.fs.existsSync(directory)) {
      return [];
    }
    const names = (await this.fs.readdir(directory)).filter((name) => name.endsWith(".conf"));
    const cleared: string[] = [];
    for (const name of names) {
      const profilePath = join(directory, name);
      try {
        if (await this.ownerIsAlive(profilePath)) {
          continue;
        }
        await this.removeProfile(profilePath);
        cleared.push(name.slice(0, -".conf".length));
      } catch (error) {
        logger.warn(`[NetworkShaper] could not clear orphaned profile ${name}`, error);
      }
    }
    return cleared;
  }

  /** A profile with no readable owner pid is orphaned; a reused pid keeps it (the safe side). */
  private async ownerIsAlive(profilePath: string): Promise<boolean> {
    const owner = ownerPath(profilePath);
    if (!this.fs.existsSync(owner)) {
      return false;
    }
    const pid = Number.parseInt((await this.fs.readFile(owner)).trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    return (this.deps.isProcessRunning ?? ((value: number) => isProcessRunning(value)))(pid);
  }

  async read(udid: string): Promise<IosNetworkShaperReadResult> {
    const profilePath = this.profilePath(udid);
    // No profile file means AutoMobile never shaped this simulator: skip the process scan.
    if (!this.fs.existsSync(profilePath)) {
      return { injected: false };
    }
    const env = await this.launchdEnvironment(udid);
    const injected =
      env !== undefined &&
      env.includes(`${IOS_NETWORK_SHAPER_PROFILE_ENV}=${profilePath}`) &&
      env.includes("DYLD_INSERT_LIBRARIES=");
    return { injected, profile: parseShaperProfile(await this.fs.readFile(profilePath)) };
  }

  private dylibProvider(): IosNetworkShaperDylibProvider {
    return this.deps.dylibProvider ?? defaultIosNetworkShaperDylibProvider;
  }

  private async writeProfile(path: string, profile: IosNetworkShaperProfile): Promise<void> {
    await this.fs.ensureDir(join(path, ".."));
    const partial = `${path}.${(this.deps.idGenerator ?? defaultIdGenerator).next()}.tmp`;
    await this.fs.writeFile(partial, formatShaperProfile(profile));
    // A rename changes the file's mtime atomically, so the shaper never reads half a profile.
    await this.fs.rename(partial, path);
  }

  private async isInjected(udid: string, dylib: string, profilePath: string): Promise<boolean> {
    const env = await this.launchdEnvironment(udid);
    return (
      env !== undefined &&
      env.includes(`DYLD_INSERT_LIBRARIES=${dylib}`) &&
      env.includes(`${IOS_NETWORK_SHAPER_PROFILE_ENV}=${profilePath}`)
    );
  }

  /** The booted simulator's launchd_sim environment, or undefined when it is not running. */
  private async launchdEnvironment(udid: string): Promise<string | undefined> {
    const marker = `/${udid.toUpperCase()}/data/var/run/launchd_bootstrap.plist`;
    let rows: HostProcessRow[];
    try {
      rows = await readHostProcessTable(this.runner, { timeoutMs: COMMAND_TIMEOUT_MS });
    } catch (error) {
      logger.warn(`[NetworkShaper] process listing failed: ${errorMessage(error)}`, error);
      return undefined;
    }
    const pid = findLaunchdSimPid(rows, marker);
    if (pid === undefined) {
      return undefined;
    }
    try {
      // Read-only: this process's own environment, which ps prints after its command.
      const args = ["-E", "-ww", "-o", "command=", "-p", String(pid)];
      return (await this.runner.executeCommand("ps", args)).stdout;
    } catch (error) {
      logger.warn(`[NetworkShaper] launchd_sim ${pid} environment read failed`, error);
      return undefined;
    }
  }

  private async rebootShaped(udid: string, dylib: string, profilePath: string): Promise<void> {
    const lifecycle = this.deps.lifecycle ?? ctrlProxyClientLifecycle;
    // Fence the CtrlProxy client so the runner's exit does not start a reconnect mid-reboot.
    await lifecycle.retireForShutdown("ios", udid);
    try {
      await this.shutdownAndBootShaped(udid, dylib, profilePath);
    } finally {
      // The next CtrlProxy call reconnects to the freshly booted simulator.
      lifecycle.resumeAfterDeviceStart("ios", udid);
    }
  }

  private async shutdownAndBootShaped(
    udid: string,
    dylib: string,
    profilePath: string,
  ): Promise<void> {
    try {
      await this.runner.executeCommand("xcrun", ["simctl", "shutdown", udid], {
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
    } catch (error) {
      // Already shut down is the only expected failure; the boot below reports anything else.
      logger.debug(`[NetworkShaper] simctl shutdown ${udid}: ${errorMessage(error)}`);
    }
    await this.simctl(["boot", udid], {
      ...this.env,
      SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: dylib,
      [`SIMCTL_CHILD_${IOS_NETWORK_SHAPER_PROFILE_ENV}`]: profilePath,
    });
    await this.simctl(["bootstatus", udid], undefined, BOOT_TIMEOUT_MS);
    if (!(await this.isInjected(udid, dylib, profilePath))) {
      throw new ActionableError(
        `The iOS Simulator ${udid} booted, but its launchd does not carry the network shaper; shaping was not applied.`,
      );
    }
  }

  private async simctl(
    args: string[],
    env?: NodeJS.ProcessEnv,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<void> {
    try {
      await this.runner.executeCommand("xcrun", ["simctl", ...args], {
        timeoutMs,
        ...(env ? { env } : {}),
      });
    } catch (error) {
      throw new ActionableError(
        `Rebooting the iOS Simulator with the network shaper failed. ${formatCommandError(error, { command: "xcrun", args: ["simctl", ...args] })}`,
        { cause: error },
      );
    }
  }
}

/** The pid of the process that wrote a profile, beside it. */
function ownerPath(profilePath: string): string {
  return profilePath.replace(/\.conf$/, ".owner");
}

/** The shaper's `key=value` profile format. */
export function formatShaperProfile(profile: IosNetworkShaperProfile): string {
  return [
    `offline=${profile.offline ? 1 : 0}`,
    `latency_ms=${Math.max(0, Math.round(profile.delayMs))}`,
    `down_kbps=${Math.max(0, Math.round(profile.downloadKbps))}`,
    `up_kbps=${Math.max(0, Math.round(profile.uploadKbps))}`,
    `loss_pct=${Math.min(100, Math.max(0, Math.round(profile.packetLossPercent)))}`,
    "",
  ].join("\n");
}

/** Parses the profile format back; unknown keys and malformed lines are ignored. */
export function parseShaperProfile(text: string): IosNetworkShaperProfile {
  const values = new Map(
    text
      .split("\n")
      .map((line) => line.split("="))
      .filter((parts) => parts.length === 2)
      .map(([key, value]) => [key!.trim(), Number.parseInt(value!.trim(), 10)] as const)
      .filter(([, value]) => Number.isFinite(value)),
  );
  return {
    offline: (values.get("offline") ?? 0) !== 0,
    delayMs: values.get("latency_ms") ?? 0,
    downloadKbps: values.get("down_kbps") ?? 0,
    uploadKbps: values.get("up_kbps") ?? 0,
    packetLossPercent: values.get("loss_pct") ?? 0,
  };
}

/** The pid of the `launchd_sim` whose bootstrap plist path contains `marker`. */
export function findLaunchdSimPid(
  rows: readonly Pick<HostProcessRow, "pid" | "command">[],
  marker: string,
): number | undefined {
  return rows.find((row) => row.command.startsWith("launchd_sim ") && row.command.includes(marker))
    ?.pid;
}

export const defaultIosNetworkShaperDylibProvider: IosNetworkShaperDylibProvider =
  new DefaultIosNetworkShaperDylibProvider();

export const defaultIosSimulatorNetworkShaper: IosSimulatorNetworkShaper =
  new DefaultIosSimulatorNetworkShaper();
