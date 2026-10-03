import type { ExecResult } from "../../models";
import { resolveIosDeviceKind } from "./IosDeviceKind";

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

/**
 * Keep permissions' historical simulator-only predicate in one place. The generic
 * device backend requires unrelated terminate/uninstall dependencies to read kind;
 * this narrow resolver avoids supplying stub transports for those operations.
 */
export function resolveIosPermissionsKind(options: {
  deviceId: string;
}): IosPermissionsBackend["kind"] {
  return resolveIosDeviceKind(options);
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

export class PhysicalIosPermissionsBackend implements IosPermissionsBackend {
  readonly kind = "physical";

  async setPrivacy(
    _operation: IosPrivacyOperation,
  ): Promise<Pick<ExecResult, "stdout" | "stderr">> {
    // Actions retain their existing physical reset/query routing and reject this
    // simulator-only operation before it reaches a transport.
    throw new Error("iOS permission changes via simctl privacy are only supported on simulators");
  }
}

export function resolveIosPermissionsBackend(options: {
  deviceId: string;
  simctl: IosSimulatorPrivacyClient;
}): IosPermissionsBackend {
  return resolveIosPermissionsKind(options) === "simulator"
    ? new SimulatorIosPermissionsBackend(options)
    : new PhysicalIosPermissionsBackend();
}
