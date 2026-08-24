import type { ExecResult } from "../../src/models";
import type {
  AppleDevice,
  AppleDeviceRuntime,
  AppleDeviceType,
  SimCtl,
} from "../../src/utils/ios-cmdline-tools/SimCtlClient";

const buildExecResult = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value: string) => stdout.includes(value),
});

type FakeSimCtlClientContract = Pick<
  SimCtl,
  | "executeCommand"
  | "executeCommandArgs"
  | "getDeviceInfo"
  | "getDeviceTypes"
  | "getRuntimes"
  | "listApps"
  | "terminateApp"
  | "openSimulatorApp"
  | "pushNotification"
>;

export class FakeSimCtlClient implements FakeSimCtlClientContract {
  private deviceInfo = new Map<string, AppleDevice | null>();
  private runtimes: AppleDeviceRuntime[] = [];
  private deviceTypes: AppleDeviceType[] = [];
  private runtimesError: Error | null = null;
  private deviceTypesError: Error | null = null;
  private installedApps: any[] = [];
  private containerPaths = new Map<string, string>();
  private containerErrors = new Map<string, Error>();
  private commandResults = new Map<string, ExecResult>();
  private commandErrors = new Map<string, Error>();
  private argvResults = new Map<string, ExecResult>();
  private argvErrors = new Map<string, Error>();
  private methodCalls = new Map<string, Array<Record<string, unknown>>>();
  private openSimulatorAppError: Error | null = null;

  setOpenSimulatorAppError(error: Error | null): void {
    this.openSimulatorAppError = error;
  }

  setDeviceInfo(udid: string, info: AppleDevice | null): void {
    this.deviceInfo.set(udid, info);
  }

  setRuntimes(runtimes: AppleDeviceRuntime[]): void {
    this.runtimes = runtimes;
  }

  setDeviceTypes(deviceTypes: AppleDeviceType[]): void {
    this.deviceTypes = deviceTypes;
  }

  setRuntimesError(error: Error | null): void {
    this.runtimesError = error;
  }

  setDeviceTypesError(error: Error | null): void {
    this.deviceTypesError = error;
  }

  setInstalledApps(apps: any[]): void {
    this.installedApps = apps;
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

  getMethodCalls(methodName: string): Array<Record<string, unknown>> {
    return this.methodCalls.get(methodName) ?? [];
  }

  private recordCall(methodName: string, params: Record<string, unknown>): void {
    if (!this.methodCalls.has(methodName)) {
      this.methodCalls.set(methodName, []);
    }
    this.methodCalls.get(methodName)!.push(params);
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
      const containerPath = this.containerPaths.get(bundleId) ?? "";
      return buildExecResult(containerPath);
    }

    return buildExecResult("");
  }

  async executeCommandArgs(args: string[], timeoutMs?: number): Promise<ExecResult> {
    this.recordCall("executeCommandArgs", { args, timeoutMs });

    const argvKey = JSON.stringify(args);
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

  async getDeviceInfo(udid: string): Promise<AppleDevice | null> {
    this.recordCall("getDeviceInfo", { udid });
    return this.deviceInfo.get(udid) ?? null;
  }

  async getDeviceTypes(): Promise<AppleDeviceType[]> {
    this.recordCall("getDeviceTypes", {});
    return this.deviceTypes;
  }

  async getRuntimes(): Promise<AppleDeviceRuntime[]> {
    this.recordCall("getRuntimes", {});
    return this.runtimes;
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

  async listApps(deviceId?: string): Promise<any[]> {
    this.recordCall("listApps", { deviceId });
    return this.installedApps;
  }

  async terminateApp(bundleId: string, deviceId?: string): Promise<void> {
    this.recordCall("terminateApp", { bundleId, deviceId });
  }

  async openSimulatorApp(udid?: string): Promise<void> {
    this.recordCall("openSimulatorApp", { udid });
    if (this.openSimulatorAppError) {
      throw this.openSimulatorAppError;
    }
  }

  private pushNotificationResult: { success: boolean; error?: string } = { success: true };

  setPushNotificationResult(result: { success: boolean; error?: string }): void {
    this.pushNotificationResult = result;
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
