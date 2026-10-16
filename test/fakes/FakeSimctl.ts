import {
  SimCtl,
  AppleDevice,
  AppleDeviceRuntime,
  AppleDeviceType,
} from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { ChildProcess, SpawnOptions } from "child_process";
import { BootedDevice, ExecResult, DeviceInfo, ScreenSize } from "../../src/models";
import type { SimulatorDisplay } from "../../src/utils/ios-cmdline-tools/SimulatorDisplays";

const buildExecResult = (stdout: string, stderr: string = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value: string) => stdout.includes(value),
});

/**
 * Fake implementation of SimCtl for testing
 * Allows configuring responses for each method and asserting method calls
 */
export class FakeSimctl implements SimCtl {
  // Configuration state
  private currentDevice: BootedDevice | null = null;
  private availableSimulators: DeviceInfo[] = [];
  private bootedSimulators: BootedDevice[] = [];
  private bootedSimulatorsError: Error | null = null;
  private deviceInfoMap: Map<string, AppleDevice | null> = new Map();
  private deviceTypes: AppleDeviceType[] = [];
  private runtimes: AppleDeviceRuntime[] = [];
  private installedApps: any[] = [];
  private listAppsError: Error | null = null;
  private launchAppResult: {
    success: boolean;
    pid?: number;
    error?: string;
  } = {
    success: true,
    pid: 12345,
  };
  private screenSize: ScreenSize = {
    width: 1179,
    height: 2556,
  };
  private isAvailableResult: boolean = true;
  private isSimulatorRunningResult: boolean = false;
  private executeCommandResult: ExecResult = {
    stdout: "",
    stderr: "",
    toString: () => "",
    trim: () => "",
    includes: () => false,
  };
  private createdSimulatorUdid: string = "created-simulator-udid-123";
  private deviceInfoError: Error | null = null;
  private runtimesError: Error | null = null;
  private deviceTypesError: Error | null = null;
  private containerPaths = new Map<string, string>();
  private containerErrors = new Map<string, Error>();
  private commandResults = new Map<string, ExecResult>();
  private commandErrors = new Map<string, Error>();
  private argvResults = new Map<string, ExecResult>();
  private argvErrors = new Map<string, Error>();
  private argvResultSequences = new Map<
    string,
    Array<{ stdout: string; stderr: string } | Error>
  >();
  private argvSequenceCursor = new Map<string, number>();
  private openSimulatorAppError: Error | null = null;
  private simulatorAppHeadless = false;
  private pushNotificationResult: { success: boolean; error?: string } = { success: true };

  // Call tracking
  private methodCalls: Map<string, Array<Record<string, unknown>>> = new Map();

  /**
   * Configure available simulators
   */
  setAvailableSimulators(simulators: DeviceInfo[]): void {
    this.availableSimulators = simulators;
  }

  /**
   * Configure booted simulators
   */
  setBootedSimulators(simulators: BootedDevice[]): void {
    this.bootedSimulators = simulators;
  }

  /**
   * Make booted-simulator discovery fail: the checked listing rethrows it and the
   * unchecked one swallows it into `[]`, as `SimCtlClient` does.
   */
  setBootedSimulatorsError(error: Error | null): void {
    this.bootedSimulatorsError = error;
  }

  /**
   * Configure device info for a specific UDID
   */
  setDeviceInfo(udid: string, info: AppleDevice | null): void {
    this.deviceInfoMap.set(udid, info);
  }

  /**
   * Configure device types
   */
  setDeviceTypes(types: AppleDeviceType[]): void {
    this.deviceTypes = types;
  }

  /**
   * Configure runtimes
   */
  setRuntimes(runtimes: AppleDeviceRuntime[]): void {
    this.runtimes = runtimes;
  }

  /**
   * Configure installed apps
   */
  setInstalledApps(apps: any[]): void {
    this.installedApps = apps;
  }

  /**
   * Configure `listApps` to fail, modelling a simctl listing that could not be
   * produced (locked/disconnected device, unavailable Xcode) as distinct from a
   * device that genuinely has no matching app installed.
   */
  setListAppsError(error: Error | null): void {
    this.listAppsError = error;
  }

  /**
   * Configure launchApp response
   */
  setLaunchAppResult(result: { success: boolean; pid?: number; error?: string }): void {
    this.launchAppResult = result;
  }

  /**
   * Configure screen size
   */
  setScreenSize(size: ScreenSize): void {
    this.screenSize = size;
  }

  /**
   * Configure isAvailable response
   */
  setIsAvailable(available: boolean): void {
    this.isAvailableResult = available;
  }

  /**
   * Configure isSimulatorRunning response
   */
  setIsSimulatorRunning(running: boolean): void {
    this.isSimulatorRunningResult = running;
  }

  /**
   * Configure executeCommand response
   */
  setExecuteCommandResult(result: ExecResult): void {
    this.executeCommandResult = result;
  }

  /**
   * Configure created simulator UDID
   */
  setCreatedSimulatorUdid(udid: string): void {
    this.createdSimulatorUdid = udid;
  }

  setOpenSimulatorAppError(error: Error | null): void {
    this.openSimulatorAppError = error;
  }

  /**
   * When true, {@link openSimulatorApp} reports a headless no-op (no GUI
   * launch performed) the way the real client does on a host with no Aqua
   * session, instead of reporting a completed launch.
   */
  setSimulatorAppHeadless(headless: boolean): void {
    this.simulatorAppHeadless = headless;
  }

  setDeviceInfoError(error: Error | null): void {
    this.deviceInfoError = error;
  }

  setRuntimesError(error: Error | null): void {
    this.runtimesError = error;
  }

  setDeviceTypesError(error: Error | null): void {
    this.deviceTypesError = error;
  }

  setContainerPath(bundleId: string, containerPath: string): void {
    this.containerPaths.set(bundleId, containerPath);
  }

  setContainerError(bundleId: string, error: Error): void {
    this.containerErrors.set(bundleId, error);
  }

  setCommandError(command: string, error: Error): void {
    this.commandErrors.set(command, error);
  }

  setPushNotificationResult(result: { success: boolean; error?: string }): void {
    this.pushNotificationResult = result;
  }

  setCommandResult(command: string, stdout: string, stderr: string = ""): void {
    this.commandResults.set(command, {
      stdout,
      stderr,
      toString: () => stdout,
      trim: () => stdout.trim(),
      includes: (value: string) => stdout.includes(value),
    });
  }

  /**
   * Stub a result keyed by the exact argv array. Unlike {@link setCommandResult},
   * this survives values containing spaces or empty strings, which a joined
   * command string cannot distinguish (issue #4196).
   */
  setCommandArgsResult(args: string[], stdout: string, stderr: string = ""): void {
    this.argvResults.set(JSON.stringify(args), {
      stdout,
      stderr,
      toString: () => stdout,
      trim: () => stdout.trim(),
      includes: (value: string) => stdout.includes(value),
    });
  }

  /** Stub an error keyed by the exact argv array. See {@link setCommandArgsResult}. */
  setCommandArgsError(args: string[], error: Error): void {
    this.argvErrors.set(JSON.stringify(args), error);
  }

  /**
   * Stub a sequence of results/errors keyed by the exact argv array: each call
   * consumes the next entry, and the final entry repeats once exhausted. Lets a
   * pre-mutation read and a post-mutation read of the SAME argv (e.g. two
   * `appearance` gets) diverge — the second failing while the first succeeds —
   * without monkeypatching the fake (mirrors
   * `FakeAdbClient.setCommandResultSequence`).
   */
  setCommandArgsResultSequence(
    args: string[],
    entries: Array<{ stdout: string; stderr?: string } | Error>,
  ): void {
    const key = JSON.stringify(args);
    this.argvResultSequences.set(
      key,
      entries.map((entry) =>
        entry instanceof Error ? entry : { stdout: entry.stdout, stderr: entry.stderr ?? "" },
      ),
    );
    this.argvSequenceCursor.set(key, 0);
  }

  /**
   * Get list of method calls for a specific method (for test assertions)
   */
  getMethodCalls(methodName: string): Array<Record<string, unknown>> {
    return this.methodCalls.get(methodName) || [];
  }

  /**
   * Check if a method was called
   */
  wasMethodCalled(methodName: string): boolean {
    const calls = this.methodCalls.get(methodName);
    return calls ? calls.length > 0 : false;
  }

  /**
   * Get count of method calls
   */
  getMethodCallCount(methodName: string): number {
    const calls = this.methodCalls.get(methodName);
    return calls ? calls.length : 0;
  }

  /**
   * Clear all call history
   */
  clearCallHistory(): void {
    this.methodCalls.clear();
  }

  /**
   * Record a method call with parameters
   */
  private recordCall(methodName: string, params: Record<string, unknown>): void {
    if (!this.methodCalls.has(methodName)) {
      this.methodCalls.set(methodName, []);
    }
    this.methodCalls.get(methodName)!.push(params);
  }

  // Implementation of SimCtl interface

  setDevice(device: BootedDevice): void {
    this.recordCall("setDevice", { deviceId: device.deviceId });
    this.currentDevice = device;
  }

  async executeCommand(command: string, timeoutMs?: number): Promise<ExecResult> {
    this.recordCall("executeCommand", { command, timeoutMs });
    const commandError = this.commandErrors.get(command);
    if (commandError) {
      throw commandError;
    }

    const commandResult = this.commandResults.get(command);
    if (commandResult) {
      return commandResult;
    }

    const match = command.match(/get_app_container\s+\"([^\"]+)\"\s+\"([^\"]+)\"\s+data/);
    const bundleId = match?.[2];
    if (bundleId) {
      const error = this.containerErrors.get(bundleId);
      if (error) {
        throw error;
      }
      return buildExecResult(this.containerPaths.get(bundleId) ?? "");
    }

    return this.executeCommandResult;
  }

  async executeCommandArgs(
    args: string[],
    timeoutMs?: number,
    _signal?: AbortSignal,
  ): Promise<ExecResult> {
    this.recordCall("executeCommandArgs", { args, timeoutMs });

    const argvKey = JSON.stringify(args);

    const sequence = this.argvResultSequences.get(argvKey);
    if (sequence && sequence.length > 0) {
      const cursor = this.argvSequenceCursor.get(argvKey) ?? 0;
      const entry = sequence[Math.min(cursor, sequence.length - 1)];
      this.argvSequenceCursor.set(argvKey, cursor + 1);
      if (entry instanceof Error) {
        throw entry;
      }
      return buildExecResult(entry.stdout, entry.stderr);
    }

    const argvError = this.argvErrors.get(argvKey);
    if (argvError) {
      throw argvError;
    }
    const argvResult = this.argvResults.get(argvKey);
    if (argvResult) {
      return argvResult;
    }

    const command = args.join(" ");
    const commandError = this.commandErrors.get(command);
    if (commandError) {
      throw commandError;
    }

    const commandResult = this.commandResults.get(command);
    if (commandResult) {
      return commandResult;
    }

    if (args[0] === "get_app_container" && args[3] === "data") {
      const bundleId = args[2];
      const error = this.containerErrors.get(bundleId);
      if (error) {
        throw error;
      }
      return buildExecResult(this.containerPaths.get(bundleId) ?? "");
    }

    return buildExecResult("");
  }

  async isAvailable(): Promise<boolean> {
    this.recordCall("isAvailable", {});
    return this.isAvailableResult;
  }

  async isSimulatorRunning(name: string): Promise<boolean> {
    this.recordCall("isSimulatorRunning", { name });
    return this.isSimulatorRunningResult;
  }

  async startSimulator(udid: string, timeoutMs?: number): Promise<any> {
    this.recordCall("startSimulator", { udid, timeoutMs });
    return {
      pid: Date.now(),
      kill: () => false,
      killed: false,
      connected: false,
      exitCode: 0,
      signalCode: null,
    };
  }

  async killSimulator(device: BootedDevice): Promise<void> {
    this.recordCall("killSimulator", { deviceId: device.deviceId });
  }

  async waitForSimulatorReady(udid: string, _timeoutMs?: number): Promise<BootedDevice> {
    this.recordCall("waitForSimulatorReady", { udid });
    const simulator = this.bootedSimulators.find((s) => s.deviceId === udid);
    if (simulator) {
      return simulator;
    }
    return {
      deviceId: udid,
      name: "Unknown Simulator",
      platform: "ios",
    } as BootedDevice;
  }

  async listSimulatorImages(): Promise<DeviceInfo[]> {
    this.recordCall("listSimulatorImages", {});
    return this.availableSimulators;
  }

  async getBootedSimulators(): Promise<BootedDevice[]> {
    this.recordCall("getBootedSimulators", {});
    return this.bootedSimulatorsError ? [] : this.bootedSimulators;
  }

  async getBootedSimulatorsChecked(): Promise<BootedDevice[]> {
    this.recordCall("getBootedSimulatorsChecked", {});
    if (this.bootedSimulatorsError) {
      throw this.bootedSimulatorsError;
    }
    return this.bootedSimulators;
  }

  async getDeviceInfo(udid: string): Promise<AppleDevice | null> {
    this.recordCall("getDeviceInfo", { udid });
    if (this.deviceInfoError) {
      throw this.deviceInfoError;
    }
    return this.deviceInfoMap.get(udid) || null;
  }

  async bootSimulator(udid: string): Promise<BootedDevice> {
    this.recordCall("bootSimulator", { udid });
    const simulator = this.bootedSimulators.find((s) => s.deviceId === udid);
    if (simulator) {
      return simulator;
    }
    return {
      deviceId: udid,
      name: "Booted Simulator",
      platform: "ios",
    } as BootedDevice;
  }

  async getDeviceTypes(): Promise<AppleDeviceType[]> {
    this.recordCall("getDeviceTypes", {});
    return this.deviceTypes;
  }

  async getRuntimes(): Promise<AppleDeviceRuntime[]> {
    this.recordCall("getRuntimes", {});
    return this.runtimes;
  }

  async createSimulator(name: string, deviceType: string, runtime: string): Promise<string> {
    this.recordCall("createSimulator", { name, deviceType, runtime });
    return this.createdSimulatorUdid;
  }

  async deleteSimulator(udid: string): Promise<void> {
    this.recordCall("deleteSimulator", { udid });
  }

  async listApps(deviceId?: string): Promise<any[]> {
    this.recordCall("listApps", { deviceId });
    // Mirrors production: the lenient variant swallows a listing failure.
    if (this.listAppsError) {
      return [];
    }
    return this.installedApps;
  }

  async listAppsOrThrow(deviceId?: string): Promise<any[]> {
    this.recordCall("listAppsOrThrow", { deviceId });
    if (this.listAppsError) {
      throw this.listAppsError;
    }
    return this.installedApps;
  }

  async launchApp(
    bundleId: string,
    options?: { foregroundIfRunning?: boolean },
    deviceId?: string,
  ): Promise<{
    success: boolean;
    pid?: number;
    error?: string;
  }> {
    this.recordCall("launchApp", { bundleId, options, deviceId });
    return this.launchAppResult;
  }

  async terminateApp(
    bundleId: string,
    deviceId?: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void> {
    this.recordCall("terminateApp", { bundleId, deviceId, options });
  }

  async installApp(
    appPath: string,
    deviceId?: string,
    options?: { timeoutMs?: number },
  ): Promise<void> {
    this.recordCall("installApp", { appPath, deviceId, options });
  }

  async uninstallApp(
    bundleId: string,
    deviceId?: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void> {
    this.recordCall("uninstallApp", { bundleId, deviceId, options });
  }

  async getScreenSize(deviceId?: string): Promise<ScreenSize> {
    this.recordCall("getScreenSize", { deviceId });
    return this.screenSize;
  }

  // Operations no test configures yet: recorded, then refused like the methods this fake lacked.
  private unconfigured(name: string, args: Record<string, unknown>): never {
    this.recordCall(name, args);
    throw new TypeError(`FakeSimctl.${name} is not configured`);
  }

  async startCommandArgs(args: string[], options?: SpawnOptions): Promise<ChildProcess> {
    return this.unconfigured("startCommandArgs", { args, options });
  }

  async eraseSimulator(udid: string): Promise<void> {
    return this.unconfigured("eraseSimulator", { udid });
  }

  async enumerateDisplays(
    deviceId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<SimulatorDisplay[]> {
    return this.unconfigured("enumerateDisplays", { deviceId, timeoutMs, signal });
  }

  async screenshot(deviceId: string, display: string, signal?: AbortSignal): Promise<Buffer> {
    return this.unconfigured("screenshot", { deviceId, display, signal });
  }

  async setAppearance(mode: "light" | "dark", deviceId?: string): Promise<void> {
    return this.unconfigured("setAppearance", { mode, deviceId });
  }

  async presentSimulatorAfterStart(
    udid: string,
    bootGeneration: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.unconfigured("presentSimulatorAfterStart", { udid, bootGeneration, signal });
  }

  async getDeviceTypesChecked(): Promise<AppleDeviceType[]> {
    this.recordCall("getDeviceTypesChecked", {});
    if (this.deviceTypesError) {
      throw this.deviceTypesError;
    }
    return this.deviceTypes;
  }

  async getRuntimesChecked(): Promise<AppleDeviceRuntime[]> {
    this.recordCall("getRuntimesChecked", {});
    if (this.runtimesError) {
      throw this.runtimesError;
    }
    return this.runtimes;
  }

  async openSimulatorApp(udid?: string, _signal?: AbortSignal): Promise<boolean> {
    this.recordCall("openSimulatorApp", { udid });
    if (this.openSimulatorAppError) {
      throw this.openSimulatorAppError;
    }
    return !this.simulatorAppHeadless;
  }

  async pushNotification(
    deviceId: string,
    bundleId: string,
    payloadJson: string,
  ): Promise<{ success: boolean; error?: string }> {
    this.recordCall("pushNotification", { deviceId, bundleId, payloadJson });
    return this.pushNotificationResult;
  }
}
