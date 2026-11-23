import { join } from "node:path";
import { ActionableError } from "../../../models/ActionableError";
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
  /** Removes shaping without a reboot; the injected shaper passes traffic through. */
  clear(udid: string): Promise<void>;
  /** Cheap when AutoMobile never shaped the simulator: no profile file, no process scan. */
  read(udid: string): Promise<IosNetworkShaperReadResult>;
}

/** The environment variable the shaper reads its profile path from. */
export const IOS_NETWORK_SHAPER_PROFILE_ENV = "SIM_RS_NETSHAPE";
const BOOT_TIMEOUT_MS = 180_000;
const COMMAND_TIMEOUT_MS = 60_000;

type ShaperFileSystem = Pick<
  FileSystem,
  "existsSync" | "readFile" | "writeFile" | "ensureDir" | "rename" | "unlink"
>;

export interface IosSimulatorNetworkShaperDependencies {
  runner?: HostCommandExecutor;
  fileSystem?: ShaperFileSystem;
  dylibProvider?: IosNetworkShaperDylibProvider;
  idGenerator?: IdGenerator;
  env?: NodeJS.ProcessEnv;
  /** Where per-simulator profile files live. */
  profileDirectory?: () => string;
}

export class DefaultIosSimulatorNetworkShaper implements IosSimulatorNetworkShaper {
  private readonly runner: HostCommandExecutor;
  private readonly fs: ShaperFileSystem;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly deps: IosSimulatorNetworkShaperDependencies = {}) {
    this.runner = deps.runner ?? new DefaultHostCommandExecutor();
    this.fs = deps.fileSystem ?? new DefaultFileSystem();
    this.env = deps.env ?? process.env;
  }

  profilePath(udid: string): string {
    const directory = (this.deps.profileDirectory ?? (() => getTempDir("ios-network-shaper")))();
    return join(directory, "profiles", `${udid.toUpperCase()}.conf`);
  }

  async apply(
    udid: string,
    profile: IosNetworkShaperProfile,
  ): Promise<IosNetworkShaperApplyResult> {
    const dylib = await this.dylibProvider().ensure();
    const profilePath = this.profilePath(udid);
    // Written first so the condition holds from the first process of a shaped boot.
    await this.writeProfile(profilePath, profile);
    if (await this.isInjected(udid, dylib, profilePath)) {
      return { rebooted: false };
    }
    await this.rebootShaped(udid, dylib, profilePath);
    return { rebooted: true };
  }

  async clear(udid: string): Promise<void> {
    const profilePath = this.profilePath(udid);
    if (this.fs.existsSync(profilePath)) {
      await this.writeProfile(profilePath, UNSHAPED_PROFILE);
    }
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

const UNSHAPED_PROFILE: IosNetworkShaperProfile = {
  offline: false,
  delayMs: 0,
  downloadKbps: 0,
  uploadKbps: 0,
  packetLossPercent: 0,
};

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
