import type { ExecResult } from "../../models";
import { resolveIosDeviceKind } from "./IosDeviceKind";
import { PhysicalIosPermissionsBackend } from "./PhysicalIosPermissionsBackend";
export { PhysicalIosPermissionsBackend } from "./PhysicalIosPermissionsBackend";

export interface IosSimulatorPrivacyClient {
  executeCommandArgs(args: string[], timeoutMs?: number): Promise<ExecResult>;
}

export interface IosPrivacyOperation {
  action: "grant" | "revoke" | "reset";
  permission: string;
  appId: string;
}

export interface IosPermissionsBackend {
  readonly kind: "simulator" | "physical";
  setPrivacy(operation: IosPrivacyOperation): Promise<Pick<ExecResult, "stdout" | "stderr">>;
}

export class SimulatorIosPermissionsBackend implements IosPermissionsBackend {
  readonly kind = "simulator";

  constructor(private readonly options: { deviceId: string; simctl: IosSimulatorPrivacyClient }) {}

  setPrivacy({ action, permission, appId }: IosPrivacyOperation): Promise<ExecResult> {
    return this.options.simctl.executeCommandArgs([
      "privacy",
      this.options.deviceId,
      action,
      permission,
      appId,
    ]);
  }
}

export function resolveIosPermissionsBackend(options: {
  deviceId: string;
  simctl: IosSimulatorPrivacyClient;
}): IosPermissionsBackend {
  return resolveIosDeviceKind({ deviceId: options.deviceId }) === "simulator"
    ? new SimulatorIosPermissionsBackend(options)
    : new PhysicalIosPermissionsBackend();
}
