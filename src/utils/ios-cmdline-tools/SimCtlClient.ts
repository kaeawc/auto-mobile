import { SimCtlShutdown, type SimctlArgvOptions } from "./SimCtlShutdown";
import { SimCtlScreenshot } from "./SimCtlScreenshot";
import { SimCtlInventory } from "./SimCtlInventory";
import { SimCtlBoot } from "./SimCtlBoot";
import {
  COMMAND_SETTLEMENT_GRACE_MS,
  SIMCTL_AVAILABILITY_PROBE_TIMEOUT_MS,
  SIMCTL_COMMAND_TIMEOUT_MS,
  type SimCtlCatalog,
  AppleDevice,
  AppleDeviceRuntime,
  AppleDeviceType,
  SimCtlFileSystem,
  defaultSimCtlFileSystem,
  SimctlLaunchOptions,
  launchEnvironment,
  SimCtl,
  execAsync,
  type SimctlExecAsync,
  defaultSpawnProcess,
  splitCommandArgs,
  SimulatorList,
  SimCtlBootOptions,
  DEFAULT_SIMCTL_BOOT_OPTIONS,
  SimulatorBootLease,
  findUniqueSimulatorRow,
} from "./SimCtlSupport";
import { simCtlSharedState } from "./SimCtlSharedState";
export type {
  SimCtlCatalog,
  AppleDevice,
  AppleDeviceRuntime,
  AppleDeviceType,
  SimCtlFileSystem,
  SimctlScreenshotFailureReason,
  SimctlLaunchOptions,
  SimCtl,
  SimCtlBootOptions,
} from "./SimCtlSupport";
import { buildSimctlArgs } from "./simctlArgs";
import {
  resolveSimCtlObservationSequence,
  type SimCtlClientDependencies,
} from "./SimCtlClientDependencies";
import { parseSimctlDeviceList } from "./simctlDeviceList";
import { parseSimctlListApps } from "./simctlListApps";
import type { IosInstalledAppRecord } from "./iosInstalledApp";
import { errorMessage } from "../describeUnknownError";
import { trackAmbient } from "../PerfContext";
import type {
  HostChildProcess as ChildProcess,
  HostSpawnOptions as SpawnOptions,
} from "../HostCommandExecutor";
import { tmpdir } from "os";
import { join } from "path";
import { logger } from "../logger";
import { ExecResult, ActionableError, DeviceInfo, BootedDevice, ScreenSize } from "../../models";
import { defaultTimer, Timer } from "../SystemTimer";
import { raceWithDeadline } from "../raceWithDeadline";
import type { DiscoveryObservationSequence } from "../DiscoveryObservationSequence";
import { createGlobalPerformanceTracker } from "../PerformanceTracker";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../deviceTimeouts";
import { PlistClient, type PlistReader } from "./PlistClient";
import { getAbortSignal } from "../AbortContext";
import { defaultIdGenerator, type IdGenerator } from "../IdGenerator";
import { DefaultSimulatorAppPresenter, type SimulatorAppPresenter } from "./SimulatorAppPresenter";
import { SimctlCommandTimeoutError } from "./SimctlCommandTimeoutError";
import {
  simulatorProfiles,
  type SimulatorDeviceTypeProfileSource,
} from "./SimulatorDeviceTypeProfiles";
import { parseSimulatorDisplays, type SimulatorDisplay } from "./SimulatorDisplays";
import type { DeviceDisplays } from "../../models/DisplayPanel";
import { type TransitionalSimulator } from "../../models/TransitionalSimulator";
import { SimctlUnavailableError } from "./SimctlUnavailableError";
import { ENV, readEnvRaw } from "../../config/env";

export { SimctlScreenshotError } from "./SimctlScreenshotError";
export { SimctlUnavailableError } from "./SimctlUnavailableError";
export { SimulatorStillShuttingDownError } from "./SimulatorStillShuttingDownError";

export class SimCtlClient implements SimCtl {
  private readonly simCtlShutdown: SimCtlShutdown;
  private createSimCtlShutdown(p?: SimCtlClientDependencies["prebootProfile"]): SimCtlShutdown {
    const client = this;
    return new SimCtlShutdown({
      prebootProfile: p,
      executeCommandArgs: (...args) => client.executeCommandArgs(...args),
      invalidateDeviceListCache: (...args) => SimCtlClient.invalidateDeviceListCache(...args),
      get timer() {
        return client.timer;
      },
      acquireSimulatorBoot: (...args) => client.acquireSimulatorBoot(...args),
      executeCommandArgv: (...args) => client.executeCommandArgv(...args),
      readSimulatorState: (...args) => client.simCtlBoot.readSimulatorState(...args),
      get execAsync() {
        return client.execAsync;
      },
    });
  }

  private readonly simCtlScreenshot: SimCtlScreenshot;
  private createSimCtlScreenshot(): SimCtlScreenshot {
    const client = this;
    return new SimCtlScreenshot({
      get timer() {
        return client.timer;
      },
      get idGenerator() {
        return client.idGenerator;
      },
      get fileSystem() {
        return client.fileSystem;
      },
      get spawnProcess() {
        return client.spawnProcess;
      },
    });
  }

  private readonly simCtlInventory: SimCtlInventory;
  private createSimCtlInventory(): SimCtlInventory {
    const client = this;
    return new SimCtlInventory({
      resolveRuntimeIdentifier: (...args) => client.resolveRuntimeIdentifier(...args),
      get execAsync() {
        return client.execAsync;
      },
      executeCommandArgs: (...args) => client.executeCommandArgs(...args),
      get timer() {
        return client.timer;
      },
      get hostArchitecture() {
        return client.hostArchitecture;
      },
      enumerateDisplays: (...args) => client.enumerateDisplays(...args),
      get deviceTypeProfiles() {
        return client.deviceTypeProfiles;
      },
      get observationSequence() {
        return client.observationSequence;
      },
      getBootedSimulatorsChecked: (...args) => client.getBootedSimulatorsChecked(...args),
      getSimulatorListingChecked: (...args) => client.getSimulatorListingChecked(...args),
      listSimulators: (...args) => client.listSimulators(...args),
      listSimulatorImages: (...args) => client.listSimulatorImages(...args),
      getDeviceInfo: (...args) => client.getDeviceInfo(...args),
      invalidateDeviceListCache: (...args) => SimCtlClient.invalidateDeviceListCache(...args),
    });
  }

  private readonly simCtlBoot: SimCtlBoot;
  private createSimCtlBoot(): SimCtlBoot {
    const client = this;
    return new SimCtlBoot({
      get timer() {
        return client.timer;
      },
      getBootedSimulatorsChecked: (...args) => client.getBootedSimulatorsChecked(...args),
      get bootPresentationGenerations() {
        return simCtlSharedState.bootPresentationGenerations;
      },
      get idGenerator() {
        return client.idGenerator;
      },
      shutdownAfterFailedStart: (...args) => client.shutdownAfterFailedStart(...args),
      presentSimulatorAfterStart: (...args) => client.presentSimulatorAfterStart(...args),
      get simulatorAppPresenter() {
        return client.simulatorAppPresenter;
      },
      shutdownSimulatorCoordinated: (...args) => client.shutdownSimulatorCoordinated(...args),
      get simulatorBoots() {
        return simCtlSharedState.simulatorBoots;
      },
      get bootOptions() {
        return client.bootOptions;
      },
      executeCommandArgs: (...args) => client.executeCommandArgs(...args),
      readSimulatorTarget: (...args) => client.readSimulatorTarget(...args),
      get observationSequence() {
        return client.observationSequence;
      },
      invalidateDeviceListCache: (...args) => SimCtlClient.invalidateDeviceListCache(...args),
    });
  }

  private readonly deviceTypeProfiles: SimulatorDeviceTypeProfileSource;
  private readonly hostArchitecture = process.arch;
  device: BootedDevice | null;
  execAsync: SimctlExecAsync;
  private timer: Timer;
  private platform: NodeJS.Platform;
  private readonly plist: PlistReader;
  private readonly observationSequence: DiscoveryObservationSequence;
  private readonly spawnProcess: (
    command: string,
    args: string[],
    options?: SpawnOptions,
  ) => ChildProcess;
  private readonly fileSystem: SimCtlFileSystem;
  private readonly bootOptions: SimCtlBootOptions;
  private readonly simulatorAppPresenter: SimulatorAppPresenter;
  private readonly idGenerator: IdGenerator;
  // Cached result of the launchctl headless-session probe (null = not yet probed).
  // Re-probed after HEADLESS_SESSION_CACHE_TTL so a GUI login/logout mid-process
  // (e.g. an SSH session that later gains a GUI, or vice versa) does not leave a
  // stale answer cached for the process lifetime (issue #6372).
  private headlessSessionCache: boolean | null = null;
  private headlessSessionCacheTimestamp = 0;
  private headlessSessionProbeSequence = 0;
  private static readonly HEADLESS_SESSION_CACHE_TTL = 30_000;

  /**
   * Create an IosUtils instance
   * @param device - Optional device
   * @param execAsyncFn - promisified exec function (for testing)
   * @param dependencies - optional collaborators; see {@link SimCtlClientDependencies}
   */
  constructor(
    device: BootedDevice | null = null,
    execAsyncFn: SimctlExecAsync | null = null,
    dependencies: SimCtlClientDependencies = {},
  ) {
    const {
      timer = defaultTimer,
      platform = process.platform,
      spawnProcess = defaultSpawnProcess,
      fileSystem = defaultSimCtlFileSystem,
      bootOptions = DEFAULT_SIMCTL_BOOT_OPTIONS,
      deviceTypeProfiles,
      simulatorAppPresenter,
      idGenerator,
    } = dependencies;
    this.plist = dependencies.plist ?? new PlistClient();
    this.observationSequence = resolveSimCtlObservationSequence(dependencies);
    this.device = device;
    this.execAsync = execAsyncFn || execAsync;
    this.timer = timer;
    this.platform = platform;
    this.spawnProcess = spawnProcess;
    this.fileSystem = fileSystem;
    this.deviceTypeProfiles = deviceTypeProfiles ?? simulatorProfiles(this, this.plist, timer);
    this.simulatorAppPresenter = this.resolveSimulatorAppPresenter(simulatorAppPresenter);
    this.idGenerator = this.resolveIdGenerator(idGenerator);
    this.bootOptions = {
      maxAttempts: Math.max(1, bootOptions.maxAttempts),
      retryBackoffMs: Math.max(0, bootOptions.retryBackoffMs),
    };

    this.simCtlBoot = this.createSimCtlBoot();

    this.simCtlInventory = this.createSimCtlInventory();

    this.simCtlScreenshot = this.createSimCtlScreenshot();

    this.simCtlShutdown = this.createSimCtlShutdown(dependencies.prebootProfile);
  }

  private resolveSimulatorAppPresenter(presenter?: SimulatorAppPresenter): SimulatorAppPresenter {
    return (
      presenter ??
      new DefaultSimulatorAppPresenter(
        (udid) => this.openSimulatorAppBounded(udid),
        simCtlSharedState.simulatorAppPresentations,
      )
    );
  }

  private resolveIdGenerator(generator?: IdGenerator): IdGenerator {
    return generator ?? defaultIdGenerator;
  }

  private async openSimulatorAppBounded(udid: string): Promise<boolean> {
    const controller = new AbortController();
    return await raceWithDeadline(this.openSimulatorApp(udid, controller.signal), {
      timer: this.timer,
      timeoutMs: 1_000,
      label: "Simulator.app open",
      timeoutError: () => new Error(`Timed out opening Simulator.app for ${udid}`),
      onTimeout: () => controller.abort(),
    });
  }

  /**
   * Set the target device ID
   * @param device - Device identifier
   */
  setDevice(device: BootedDevice): void {
    this.device = device;
  }

  /**
   * Execute an simctl command
   * @param command - The simctl command to execute
   * @param timeoutMs - Optional timeout in milliseconds
   * @returns Promise with command output
   */
  async executeCommand(
    command: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    const hostArgs = splitCommandArgs(command);
    return this.executeCommandArgv(hostArgs, timeoutMs, command, { signal });
  }

  async executeCommandArgs(
    args: string[],
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    return this.executeCommandArgv(args, timeoutMs, args.join(" "), { signal });
  }

  async startCommandArgs(args: string[], options?: SpawnOptions): Promise<ChildProcess> {
    if (args.length === 0) {
      throw new Error("Command cannot be empty");
    }

    const fullArgs = buildSimctlArgs(args);
    logger.debug(`[iOS] Starting command: xcrun ${fullArgs.join(" ")}`);
    return this.spawnProcess("xcrun", fullArgs, options);
  }

  private executeCommandArgv(
    args: string[],
    timeoutMs = SIMCTL_COMMAND_TIMEOUT_MS,
    displayCommand?: string,
    options: SimctlArgvOptions = {},
  ): Promise<ExecResult> {
    // One span per simctl invocation, named by the leading subcommand so spans
    // aggregate (e.g. `simctl boot`), recorded against the ambient
    // device-lifecycle tracker when one is in scope (see PerfContext).
    return trackAmbient(`simctl ${args[0] ?? ""}`.trimEnd(), () =>
      this.executeCommandArgvInner(args, timeoutMs, displayCommand, options),
    );
  }

  private async executeCommandArgvInner(
    args: string[],
    timeoutMs: number | undefined,
    displayCommand: string | undefined,
    options: SimctlArgvOptions,
  ): Promise<ExecResult> {
    const { signal: explicitSignal, waitForTimedOutCommandSettlement, env } = options;
    if (args.length === 0) {
      throw new Error("Command cannot be empty");
    }
    const command = displayCommand ?? args.map((arg) => JSON.stringify(arg)).join(" ");
    const hostArgs = args;
    const localArgs = buildSimctlArgs(hostArgs);

    const fullCommand = `xcrun simctl ${command}`;
    const startTime = this.timer.now();

    logger.debug(`[iOS] Executing command: ${fullCommand}`);

    const callerSignal = explicitSignal ?? getAbortSignal();
    const runCommand = async (signal?: AbortSignal) => {
      try {
        // Pass env only when set, so existing exec fakes see an unchanged call shape.
        return env === undefined
          ? await this.execAsync("xcrun", localArgs, { signal })
          : await this.execAsync("xcrun", localArgs, { signal, env });
      } catch (error) {
        const tokenIndex = args.indexOf("--automobile-mutation-token");
        const token = tokenIndex >= 0 ? args[tokenIndex + 1] : undefined;
        if (!token) {
          throw error;
        }
        throw new ActionableError(errorMessage(error).split(token).join("[REDACTED]"));
      }
    };

    // On timeout we abort the
    // controller so the underlying child process is killed rather than left
    // running orphaned (issue #3938).
    if (timeoutMs) {
      let timeoutError: Error | undefined;
      let runPromise: Promise<ExecResult> | undefined;
      const controller = new AbortController();
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, controller.signal])
        : controller.signal;

      try {
        runPromise = runCommand(signal);
        const result = await raceWithDeadline(runPromise, {
          timer: this.timer,
          timeoutMs,
          signal: callerSignal,
          label: "simctl command",
          timeoutError: () =>
            (timeoutError = new SimctlCommandTimeoutError(
              `Command timed out after ${timeoutMs}ms: ${fullCommand}`,
            )),
          onTimeout: () => controller.abort(timeoutError),
        });
        const duration = this.timer.now() - startTime;
        logger.debug(`[iOS] Command completed in ${duration}ms: ${command}`);
        return result;
      } catch (error) {
        if (waitForTimedOutCommandSettlement && runPromise && error === timeoutError) {
          await this.waitForCommandSettlement(runPromise, command);
        }
        const commandError = this.toActionableSimctlUnavailableError(error);
        const duration = this.timer.now() - startTime;
        logger.warn(
          `[iOS] Command failed after ${duration}ms: ${command} - ${errorMessage(commandError)}`,
        );
        throw commandError;
      }
    }

    // No timeout specified
    try {
      const result = await runCommand(callerSignal);
      const duration = this.timer.now() - startTime;
      logger.debug(`[iOS] Command completed in ${duration}ms: ${command}`);
      return result;
    } catch (error) {
      const commandError = this.toActionableSimctlUnavailableError(error);
      const duration = this.timer.now() - startTime;
      logger.warn(
        `[iOS] Command failed after ${duration}ms: ${command} - ${errorMessage(commandError)}`,
      );
      throw commandError;
    }
  }

  private async waitForCommandSettlement(
    runPromise: Promise<ExecResult>,
    command: string,
  ): Promise<void> {
    let settlementTimedOut = false;
    const timeout = new Error("simctl command settlement grace expired");
    try {
      await raceWithDeadline(
        runPromise.then(
          () => undefined,
          () => undefined,
        ),
        {
          timer: this.timer,
          timeoutMs: COMMAND_SETTLEMENT_GRACE_MS,
          label: "simctl command settlement",
          timeoutError: () => timeout,
          onTimeout: () => {
            settlementTimedOut = true;
          },
        },
      );
    } catch (error) {
      if (error !== timeout) {
        throw error;
      }
    }
    if (settlementTimedOut) {
      logger.warn(
        `[iOS] Command did not settle within ${COMMAND_SETTLEMENT_GRACE_MS}ms after termination: ${command}`,
      );
    }
  }

  /**
   * Check if simctl is available
   * @returns Promise with boolean indicating availability
   */
  async isAvailable(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<boolean> {
    return this.isLocalSimctlAvailable(options);
  }

  private async isLocalSimctlAvailable(options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<boolean> {
    const controller = new AbortController();
    const signal = options?.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const probe = this.execAsync("xcrun", ["--find", "simctl"], { signal });
    try {
      return await raceWithDeadline(
        probe.then(
          () => true,
          () => false,
        ),
        {
          timer: this.timer,
          timeoutMs: options?.timeoutMs ?? SIMCTL_AVAILABILITY_PROBE_TIMEOUT_MS,
          label: "simctl availability",
          onTimeout: () => controller.abort(),
        },
      );
    } catch (error) {
      logger.debug(`src/utils/ios-cmdline-tools/SimCtlClient.ts fallback failed: ${error}`, error);
      return false;
    }
  }

  private toActionableSimctlUnavailableError(error: unknown): unknown {
    const detail = errorMessage(error);
    if (
      !/(?:unable to find utility ["']?simctl|active developer path .* does not exist|xcode-select: error|command not found: xcrun|spawn xcrun ENOENT)/i.test(
        detail,
      )
    ) {
      return error;
    }
    const message =
      this.platform === "darwin"
        ? `simctl is not available. Please install Xcode command line tools to continue. ${detail}`
        : "iOS simulator tooling is only available on macOS.";
    return new SimctlUnavailableError(message);
  }

  /**
   * Get the list of all simulators and devices
   * @returns Promise with simulator list data
   */
  async listSimulators(timeoutMs?: number, signal?: AbortSignal): Promise<SimulatorList> {
    const perf = createGlobalPerformanceTracker();
    perf.startOperation("simctlListDevices");
    const result = await this.executeCommandArgs(["list", "devices", "--json"], timeoutMs, signal);
    perf.endOperation("simctlListDevices");

    try {
      perf.startOperation("jsonParse");
      const simulatorData = parseSimctlDeviceList(result.stdout);
      perf.endOperation("jsonParse");
      return simulatorData as SimulatorList;
    } catch (error) {
      const stdoutSnippet = result.stdout.trim().slice(0, 300);
      const stderrSnippet = result.stderr.trim().slice(0, 300);
      logger.error(`Failed to parse simctl device list: ${error}`);
      throw new ActionableError(
        "Failed to parse iOS device list from 'xcrun simctl list devices --json'. " +
          `${errorMessage(error)}. ` +
          `stdout (first 300 chars): ${stdoutSnippet || "<empty>"}. ` +
          `stderr (first 300 chars): ${stderrSnippet || "<empty>"}.`,
      );
    }
  }

  async readSimulatorTarget(udid: string, timeoutMs?: number, signal?: AbortSignal) {
    return findUniqueSimulatorRow(await this.listSimulators(timeoutMs, signal), udid);
  }

  async isSimulatorRunning(identifier: string): Promise<boolean> {
    return (await this.getBootedSimulators()).some(
      (simulator) => simulator.deviceId === identifier || simulator.name === identifier,
    );
  }
  startSimulator(
    udid: string,
    timeoutMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS,
  ): Promise<ChildProcess> {
    return this.simCtlBoot.startSimulator(udid, timeoutMs);
  }

  presentSimulatorAfterStart(
    udid: string,
    bootGeneration: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.simCtlBoot.presentSimulatorAfterStart(udid, bootGeneration, signal);
  }

  private acquireSimulatorBoot(
    udid: string,
    deadlineMs: number | undefined,
    signal: AbortSignal | undefined,
    operation: "start" | "shut down" | "erase" = "start",
  ): Promise<SimulatorBootLease> {
    return this.simCtlBoot.acquireSimulatorBoot(udid, deadlineMs, signal, operation);
  }
  private shutdownAfterFailedStart(udid: string, lease: SimulatorBootLease): Promise<void> {
    return this.simCtlShutdown.shutdownAfterFailedStart(udid, lease);
  }

  private shutdownSimulatorCoordinated(
    udid: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    expectedOwnerToken?: object,
  ): Promise<void> {
    return this.simCtlShutdown.shutdownSimulatorCoordinated(udid, timeoutMs, signal, {
      expectedOwnerToken,
    });
  }

  killSimulator(
    device: BootedDevice,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    return this.simCtlShutdown.killSimulator(device, options);
  }

  eraseSimulator(udid: string): Promise<void> {
    return this.simCtlShutdown.eraseSimulator(udid);
  }

  waitForSimulatorReady(
    udid: string,
    timeoutMs?: number,
    options?: { assumeBooted?: boolean },
  ): Promise<BootedDevice> {
    return this.simCtlBoot.waitForSimulatorReady(udid, timeoutMs, options);
  }
  resolveRuntimeIdentifier(requestedVersion?: string, signal?: AbortSignal): Promise<string> {
    return this.simCtlInventory.resolveRuntimeIdentifier(requestedVersion, signal);
  }

  resolveRuntimeIdentifiersForBounds(
    minVersion?: string,
    maxVersion?: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    return this.simCtlInventory.resolveRuntimeIdentifiersForBounds(minVersion, maxVersion, signal);
  }

  listSimulatorImages(
    timeoutMs?: number,
    options: { bypassCache?: boolean; signal?: AbortSignal } = {},
  ): Promise<DeviceInfo[]> {
    return this.simCtlInventory.listSimulatorImages(timeoutMs, options);
  }

  getBootedSimulators(timeoutMs?: number, signal?: AbortSignal): Promise<BootedDevice[]> {
    return this.simCtlInventory.getBootedSimulators(timeoutMs, signal);
  }

  getBootedSimulatorsChecked(
    timeoutMs?: number,
    signal?: AbortSignal,
    options: { bypassCache?: boolean; maxCacheAgeMs?: number } = {},
  ): Promise<BootedDevice[]> {
    return this.simCtlInventory.getBootedSimulatorsChecked(timeoutMs, signal, options);
  }

  getSimulatorListingChecked(
    timeoutMs?: number,
    signal?: AbortSignal,
    options: { bypassCache?: boolean; maxCacheAgeMs?: number } = {},
  ): Promise<{ booted: BootedDevice[]; transitional: TransitionalSimulator[] }> {
    return this.simCtlInventory.getSimulatorListingChecked(timeoutMs, signal, options);
  }

  getDeviceInfo(udid: string): Promise<AppleDevice | null> {
    return this.simCtlInventory.getDeviceInfo(udid);
  }

  readDeviceDisplays(udid: string, signal?: AbortSignal): Promise<DeviceDisplays | undefined> {
    return this.simCtlInventory.readDeviceDisplays(udid, signal);
  }

  bootSimulator(udid: string): Promise<BootedDevice> {
    return this.simCtlBoot.bootSimulator(udid);
  }
  getDeviceTypes(signal?: AbortSignal): Promise<AppleDeviceType[]> {
    return this.simCtlInventory.getDeviceTypes(signal);
  }

  getCatalogChecked(signal?: AbortSignal): Promise<SimCtlCatalog> {
    return this.simCtlInventory.getCatalogChecked(signal);
  }

  getDeviceTypesChecked(signal?: AbortSignal): Promise<AppleDeviceType[]> {
    return this.simCtlInventory.getDeviceTypesChecked(signal);
  }

  getRuntimes(timeoutMs?: number, signal?: AbortSignal): Promise<AppleDeviceRuntime[]> {
    return this.simCtlInventory.getRuntimes(timeoutMs, signal);
  }

  getRuntimesChecked(timeoutMs?: number, signal?: AbortSignal): Promise<AppleDeviceRuntime[]> {
    return this.simCtlInventory.getRuntimesChecked(timeoutMs, signal);
  }

  cloneSimulator(sourceUdid: string, name: string, signal?: AbortSignal): Promise<string> {
    return this.simCtlInventory.cloneSimulator(sourceUdid, name, signal);
  }
  shutdownSimulator(udid: string, signal?: AbortSignal): Promise<void> {
    return this.simCtlShutdown.shutdownSimulatorCoordinated(udid, 120_000, signal);
  }
  createSimulator(
    name: string,
    deviceType: string,
    runtime: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.simCtlInventory.createSimulator(name, deviceType, runtime, signal);
  }

  /** Drop shared inventory snapshots and fence older in-flight listings. */
  static invalidateDeviceListCache(): void {
    SimCtlInventory.invalidateDeviceListCache();
  }
  deleteSimulator(
    udid: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    return this.simCtlShutdown.deleteSimulator(udid, options);
  }

  private requireSimulatorDeviceId(deviceId?: string): string {
    const targetDevice = deviceId || this.device?.deviceId;
    if (!targetDevice || targetDevice === "booted") {
      throw new ActionableError(
        "No simulator is selected. Bind a device when constructing SimCtlClient or pass a deviceId. " +
          "Use a simulator UDID from xcrun simctl list devices or the listDevices tool.",
      );
    }
    return targetDevice;
  }

  /**
   * List all installed apps on the simulator
   * @param deviceId - Optional simulator UDID (defaults to the bound device; required when unbound)
   * @returns Promise with array of app objects containing bundle identifiers and other metadata
   */
  async listApps(deviceId?: string): Promise<IosInstalledAppRecord[]> {
    try {
      return await this.listAppsOrThrow(deviceId);
    } catch (error) {
      // Legacy lenient contract: callers of `listApps` treat an unavailable
      // listing as "no apps". Callers that must distinguish a failed listing
      // from an empty device use `listAppsOrThrow` instead (issue #5621).
      logger.warn(`Failed to list iOS apps: ${error}`);
      return [];
    }
  }

  /**
   * List installed apps, propagating a listing failure instead of collapsing it
   * into an empty array. `listApps` swallows the error for its existing
   * callers; consumers that must tell "the listing failed" apart from "the
   * device has no such app" — the install pre-checks in `UninstallApp` and
   * `TerminateApp` — call this variant (issue #5621).
   * @param deviceId - Optional simulator UDID (defaults to the bound device; required when unbound)
   * @returns Promise with array of app objects containing bundle identifiers and other metadata
   */
  async listAppsOrThrow(
    deviceId?: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<IosInstalledAppRecord[]> {
    const targetDevice = this.requireSimulatorDeviceId(deviceId);
    logger.debug(`Listing installed apps on iOS simulator ${targetDevice}`);

    // simctl listapps may return an old-style plist instead of JSON (Xcode
    // 26+). The plist owner receives the exact bytes over stdin, avoiding a
    // shell pipe and a temporary host file.
    const listAppsJson = async (args: string[]): Promise<string> => {
      options?.signal?.throwIfAborted();
      const result = await this.executeCommandArgs(
        ["listapps", ...args],
        options?.timeoutMs,
        options?.signal,
      );
      try {
        JSON.parse(result.stdout);
        return result.stdout;
      } catch (error) {
        logger.debug(`[iOS] listapps returned plist; converting with plutil: ${error}`);
        return JSON.stringify(
          await this.plist.readJsonBytes(Buffer.from(result.stdout, "utf8"), {
            signal: options?.signal,
          }),
        );
      }
    };

    try {
      return parseSimctlListApps(await listAppsJson([targetDevice, "--all"]));
    } catch (error) {
      logger.warn(`Failed to list iOS apps with --all: ${error}`);
      options?.signal?.throwIfAborted();
    }

    return parseSimctlListApps(await listAppsJson([targetDevice]));
  }

  /**
   * Launch an app on the simulator
   * @param bundleId - The bundle identifier of the app to launch
   * @param options - Launch options
   * @param deviceId - Optional simulator UDID (defaults to the bound device; required when unbound)
   * @returns Promise with launch result containing success status and optional PID
   */
  async launchApp(
    bundleId: string,
    options?: SimctlLaunchOptions,
    deviceId?: string,
  ): Promise<{
    success: boolean;
    pid?: number;
    error?: string;
  }> {
    try {
      const targetDevice = this.requireSimulatorDeviceId(deviceId);
      logger.debug(`Launching app ${bundleId} on iOS simulator ${targetDevice}`);
      const launchArgs = ["launch", targetDevice, bundleId, ...(options?.launchArguments ?? [])];
      const result = await this.executeCommandArgv(
        launchArgs,
        DEFAULT_DEVICE_READY_TIMEOUT_MS,
        `launch ${targetDevice} ${bundleId} [app arguments redacted]`,
        { waitForTimedOutCommandSettlement: false, env: launchEnvironment(options?.environment) },
      );

      // Parse the output to extract PID if available
      // Example output: "com.example.app: 12345"
      const pidMatch = result.stdout.match(/:\s*(\d+)/);
      const pid = pidMatch ? parseInt(pidMatch[1], 10) : undefined;

      return {
        success: true,
        pid,
      };
    } catch (error) {
      logger.warn(`Failed to launch iOS app ${bundleId}: ${error}`);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Terminate an app on the simulator
   * @param bundleId - The bundle identifier of the app to terminate
   * @param deviceId - Optional simulator UDID (defaults to the bound device; required when unbound)
   * @returns Promise that resolves when termination is complete
   */
  async terminateApp(
    bundleId: string,
    deviceId?: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void> {
    const targetDevice = this.requireSimulatorDeviceId(deviceId);
    logger.debug(`Terminating app ${bundleId} on iOS simulator ${targetDevice}`);

    try {
      await this.executeCommandArgs(
        ["terminate", targetDevice, bundleId],
        options?.timeoutMs,
        options?.signal,
      );
    } catch (error) {
      logger.warn(`Failed to terminate iOS app ${bundleId}: ${error}`);
      throw error;
    }
  }

  async installApp(
    appPath: string,
    deviceId?: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void> {
    const targetDevice = this.requireSimulatorDeviceId(deviceId);
    logger.debug(`Installing app ${appPath} on iOS simulator ${targetDevice}`);
    await this.executeCommandArgs(
      ["install", targetDevice, appPath],
      options?.timeoutMs,
      options?.signal,
    );
  }

  async uninstallApp(
    bundleId: string,
    deviceId?: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void> {
    const targetDevice = this.requireSimulatorDeviceId(deviceId);
    logger.debug(`Uninstalling app ${bundleId} from iOS simulator ${targetDevice}`);
    await this.executeCommandArgs(
      ["uninstall", targetDevice, bundleId],
      options?.timeoutMs,
      options?.signal,
    );
  }

  /**
   * Get the screen size of the simulator
   * @param deviceId - Optional simulator UDID (defaults to the bound device; required when unbound)
   * @returns Promise with screen dimensions
   */
  async getScreenSize(deviceId?: string, timeoutMs?: number): Promise<ScreenSize> {
    const targetDevice = this.requireSimulatorDeviceId(deviceId);

    logger.info(`[iOS] Getting screen size for simulator ${targetDevice}`);

    const display = (await this.enumerateDisplays(targetDevice, timeoutMs)).find(
      (candidate) => candidate.uiScale !== null,
    );
    if (display?.uiScale) {
      return {
        width: Math.round(display.width / display.uiScale),
        height: Math.round(display.height / display.uiScale),
      };
    }

    throw new ActionableError("Unable to determine screen size from provided data.");
  }

  async enumerateDisplays(
    deviceId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<SimulatorDisplay[]> {
    const result = await this.executeCommandArgs(["io", deviceId, "enumerate"], timeoutMs, signal);
    return parseSimulatorDisplays(result.stdout);
  }
  screenshot(deviceId: string, display?: string, signal?: AbortSignal): Promise<Buffer> {
    return this.simCtlScreenshot.screenshot(deviceId, display, signal);
  }

  async setAppearance(mode: "light" | "dark", deviceId?: string): Promise<void> {
    const targetDevice = this.requireSimulatorDeviceId(deviceId);
    await this.executeCommandArgs(["ui", targetDevice, "appearance", mode]);
  }

  /**
   * Deliver a simulated remote push to a booted simulator via `simctl push`.
   * Writes the payload to a temp .apns file because executeCommand cannot stream stdin.
   */
  async pushNotification(
    deviceId: string,
    bundleId: string,
    payloadJson: string,
  ): Promise<{ success: boolean; error?: string }> {
    const dir = await this.fileSystem.mkdtemp(join(tmpdir(), "automobile-apns-"));
    const file = join(dir, "payload.apns");
    try {
      await this.fileSystem.writeFile(file, payloadJson, "utf8");
      // `xcrun simctl push <udid> <bundleId> <file>`; bundleId may be omitted when the
      // payload carries "Simulator Target Bundle", but passing it explicitly is harmless.
      const result = await this.executeCommandArgs(["push", deviceId, bundleId, file]);
      // `simctl push` can exit 0 (delivered) while still writing advisory or
      // diagnostic text to stderr, depending on the Xcode/simctl version.
      // Success is driven by the exit code alone — executeCommandArgs already
      // throws on a non-zero exit, which the catch below converts into
      // { success: false, error } (issue #6517). Log stderr for diagnostics
      // only; it must not flip a delivered push into a reported failure.
      if ((result.stderr || "").trim().length > 0) {
        logger.debug(`[iOS] simctl push wrote to stderr despite exit 0: ${result.stderr.trim()}`);
      }
      return { success: true };
    } catch (error) {
      logger.warn(`[iOS] Failed to push simulator notification: ${errorMessage(error)}`);
      return { success: false, error: errorMessage(error) };
    } finally {
      await this.fileSystem.rm(dir, { recursive: true, force: true }).catch((error) => {
        logger.warn(`[iOS] Failed to clean up simulator notification file: ${errorMessage(error)}`);
      });
    }
  }

  async openSimulatorApp(udid?: string, signal?: AbortSignal): Promise<boolean> {
    // On a headless macOS host (no Aqua GUI session, e.g. a launchd daemon or
    // SSH context) `open -a Simulator` fails with OSLaunchdErrorDomain Code=125
    // after a slow retry, wasting wall-clock against the daemon-start budget.
    // The booted simulator + CtrlProxy work without the GUI, so skip the launch.
    if (await this.isHeadlessSession(signal)) {
      logger.debug("Skipping open -a Simulator: headless session (no Aqua GUI)");
      return false;
    }

    // Ensure Simulator.app is open (creates windows for all booted devices).
    // Direct `open`/`osascript` bypass the executeCommandArgv funnel, so give
    // them their own ambient leaves (see PerfContext).
    await trackAmbient("open -a Simulator", () =>
      this.execAsync("open", ["-a", "Simulator"], { signal }),
    );
    // The start presenter already limits this to one call per boot. `open -a`
    // presents the app; activating it again would steal focus a second time.
    return true;
  }

  /**
   * Determine whether the current host can launch the Simulator GUI.
   *
   * Resolution order:
   *  1. Non-darwin platforms are always headless (Simulator.app is macOS-only).
   *     This gate comes BEFORE the env override so `AUTOMOBILE_IOS_HEADLESS=false`
   *     (or `""`) can never make `openSimulatorApp` shell `open -a Simulator` on
   *     Linux/Windows, where that binary does not exist (issue #4177).
   *  2. `AUTOMOBILE_IOS_HEADLESS` env override (`true`/`1` => headless, else force GUI launch).
   *  3. Auto-detect via `launchctl managername`: an `Aqua` manager means a GUI
   *     login session; anything else (`System`/`Background`) is a daemon/SSH
   *     context with no GUI domain.
   *
   * If detection itself fails we assume a GUI session to preserve the prior
   * behavior. The result is cached for {@link HEADLESS_SESSION_CACHE_TTL} so
   * launchctl is not probed on every call, but a stale answer does not persist
   * for the process lifetime — mirrors the {@link DEVICE_LIST_CACHE_TTL} pattern.
   */
  private async isHeadlessSession(signal?: AbortSignal): Promise<boolean> {
    if (this.platform !== "darwin") {
      return true;
    }

    const override = readEnvRaw(ENV.IOS_HEADLESS);
    if (override !== undefined) {
      return override === "true" || override === "1";
    }

    const cacheAge = this.timer.now() - this.headlessSessionCacheTimestamp;
    if (
      this.headlessSessionCache !== null &&
      cacheAge >= 0 &&
      cacheAge < SimCtlClient.HEADLESS_SESSION_CACHE_TTL
    ) {
      return this.headlessSessionCache;
    }

    // Two device starts can race past the expired TTL and each launch an
    // independent probe. A sequence distinguishes probes that begin in the
    // same timer tick; only the newest one may update the cache. Each caller
    // keeps its own probe and cancellation signal.
    const probeSequence = ++this.headlessSessionProbeSequence;
    const headless = await this.detectHeadlessSession(signal);
    if (probeSequence === this.headlessSessionProbeSequence) {
      this.headlessSessionCache = headless;
      this.headlessSessionCacheTimestamp = this.timer.now();
    }
    return headless;
  }

  private async detectHeadlessSession(signal?: AbortSignal): Promise<boolean> {
    try {
      // Direct launchctl (not a simctl subcommand), so it bypasses the
      // executeCommandArgv funnel; give it its own ambient leaf (see PerfContext).
      const result = await trackAmbient("launchctl managername", () =>
        this.execAsync("launchctl", ["managername"], { signal }),
      );
      const managerName = (result.stdout || "").trim();
      // "Aqua" is the GUI login session manager; "System"/"Background" are not.
      return managerName !== "Aqua";
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      // Can't determine the session type; assume a GUI session so we preserve
      // the historical behavior rather than silently suppressing the launch.
      logger.debug(`launchctl managername probe failed, assuming GUI session: ${error}`);
      return false;
    }
  }
}

// Backward compatibility export
export { SimCtlClient as Simctl };
