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
import { isMissingFileError } from "../../action/IosSimulatorMemoryWarning";
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
 * environment, so processes in the device load it (WebKit's networking
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
  /** Serializes this daemon's profile writes, rollbacks, clears and sweeps per simulator. */
  private readonly profileLocks = new Map<string, Promise<void>>();

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
    const content = formatShaperProfile(profile);
    const previous = await this.withProfileLock(profilePath, async () => {
      const snapshot = await this.snapshot(profilePath);
      try {
        // The owner lands first, so a startup sweep never sees a profile without its owner and
        // deletes live shaping; the profile lands before the boot so the first process sees it.
        await this.writeAtomically(ownerPath(profilePath), `${this.ownerPid()}\n`);
        await this.writeAtomically(profilePath, content);
      } catch (error) {
        // Under the lock nothing else wrote here: put back exactly what was there.
        await this.restoreSnapshot(profilePath, snapshot);
        throw error;
      }
      return snapshot;
    });
    try {
      // A concurrent apply joins this flight instead of rebooting the simulator a second time.
      const rebooted = await this.injections.run(udid.toUpperCase(), async () => {
        if (await this.isInjected(udid, dylib, profilePath)) {
          return false;
        }
        await this.rebootShaped(udid, dylib, profilePath);
        return true;
      });
      return { rebooted };
    } catch (error) {
      // A failed apply leaves no new condition: the previous profile (or none) comes back.
      await this.withProfileLock(profilePath, () => this.rollBack(profilePath, previous, content));
      throw error;
    }
  }

  async clear(udid: string): Promise<void> {
    const profilePath = this.profilePath(udid);
    await this.withProfileLock(profilePath, () => this.removeProfile(profilePath));
  }

  private ownerPid(): number {
    return this.deps.ownerPid ?? process.pid;
  }

  private async withProfileLock<T>(profilePath: string, task: () => Promise<T>): Promise<T> {
    const prior = this.profileLocks.get(profilePath) ?? Promise.resolve();
    const run = prior.then(task);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.profileLocks.set(profilePath, settled);
    try {
      return await run;
    } finally {
      if (this.profileLocks.get(profilePath) === settled) {
        this.profileLocks.delete(profilePath);
      }
    }
  }

  private async snapshot(profilePath: string): Promise<ProfileSnapshot> {
    return {
      profile: await this.readIfPresent(profilePath),
      owner: await this.readIfPresent(ownerPath(profilePath)),
    };
  }

  /**
   * Puts back what a failed apply replaced, unless a later apply already replaced
   * this one's profile (then that apply owns the outcome).
   */
  private async rollBack(
    profilePath: string,
    previous: ProfileSnapshot,
    written: string,
  ): Promise<void> {
    try {
      const current = await this.readIfPresent(profilePath);
      if (current !== undefined && current !== written) {
        return;
      }
    } catch (error) {
      logger.warn(`[NetworkShaper] could not read the profile at ${profilePath}`, error);
      return;
    }
    await this.restoreSnapshot(profilePath, previous);
  }

  private async restoreSnapshot(profilePath: string, previous: ProfileSnapshot): Promise<void> {
    try {
      if (previous.profile === undefined) {
        await this.removeProfile(profilePath);
        return;
      }
      if (previous.owner !== undefined) {
        await this.writeAtomically(ownerPath(profilePath), previous.owner);
      }
      await this.writeAtomically(profilePath, previous.profile);
    } catch (error) {
      logger.warn(`[NetworkShaper] could not roll back the profile at ${profilePath}`, error);
    }
  }

  /** A file's text, or undefined when it does not exist (now or by the time it is read). */
  private async readIfPresent(path: string): Promise<string | undefined> {
    if (!this.fs.existsSync(path)) {
      return undefined;
    }
    try {
      return await this.fs.readFile(path);
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private async removeProfile(profilePath: string): Promise<void> {
    // The shaper treats a missing profile file as unshaped.
    for (const path of [profilePath, ownerPath(profilePath)]) {
      await this.unlinkIfPresent(path);
    }
  }

  private async unlinkIfPresent(path: string): Promise<void> {
    if (!this.fs.existsSync(path)) {
      return;
    }
    try {
      await this.fs.unlink(path);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
      // Another remover got there first; the file is gone either way.
      logger.debug(`[NetworkShaper] ${path} was already removed`);
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
        if (await this.withProfileLock(profilePath, () => this.clearIfOrphaned(profilePath))) {
          cleared.push(name.slice(0, -".conf".length));
        }
      } catch (error) {
        logger.warn(`[NetworkShaper] could not clear orphaned profile ${name}`, error);
      }
    }
    return cleared;
  }

  /**
   * Removes a profile whose owner is gone. Another daemon on the same data
   * directory writes its owner before its profile, so the profile is first
   * claimed by an atomic rename and the owner re-read: a changed owner means a
   * live daemon took the simulator over, and its profile is put back.
   */
  private async clearIfOrphaned(profilePath: string): Promise<boolean> {
    const owner = await this.readIfPresent(ownerPath(profilePath));
    if (this.ownerIsAlive(owner)) {
      return false;
    }
    const claimed = `${profilePath}.${(this.deps.idGenerator ?? defaultIdGenerator).next()}.sweep`;
    try {
      await this.fs.rename(profilePath, claimed);
    } catch (error) {
      if (isMissingFileError(error)) {
        return false;
      }
      throw error;
    }
    if ((await this.readIfPresent(ownerPath(profilePath))) !== owner) {
      if (!this.fs.existsSync(profilePath)) {
        await this.fs.rename(claimed, profilePath);
      } else {
        await this.unlinkIfPresent(claimed);
      }
      return false;
    }
    await this.unlinkIfPresent(claimed);
    await this.unlinkIfPresent(ownerPath(profilePath));
    return true;
  }

  /** A profile with no readable owner pid is orphaned; a reused pid keeps it (the safe side). */
  private ownerIsAlive(owner: string | undefined): boolean {
    const pid = owner === undefined ? Number.NaN : Number.parseInt(owner.trim(), 10);
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
    // A concurrent clear can remove the profile while the process scan runs.
    const text = await this.readIfPresent(profilePath);
    return text === undefined
      ? { injected: false }
      : { injected, profile: parseShaperProfile(text) };
  }

  private dylibProvider(): IosNetworkShaperDylibProvider {
    return this.deps.dylibProvider ?? defaultIosNetworkShaperDylibProvider;
  }

  private async writeAtomically(path: string, content: string): Promise<void> {
    await this.fs.ensureDir(join(path, ".."));
    const partial = `${path}.${(this.deps.idGenerator ?? defaultIdGenerator).next()}.tmp`;
    await this.fs.writeFile(partial, content);
    // A rename changes the file's mtime atomically, so a reader never sees half a file.
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

interface ProfileSnapshot {
  profile?: string;
  owner?: string;
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
