import type { BootedDevice } from "../models";
import { resolveIosDeviceKind } from "../utils/ios-cmdline-tools/IosDeviceKind";
import type { ResetAppLogsRequest, SessionLogProvider } from "./DefaultSessionLogService";
import type { IosSimulatorSessionLogProvider } from "./IosSimulatorSessionLogProvider";
import type { PhysicalIosSessionLogProvider } from "./PhysicalIosSessionLogProvider";
import type {
  ResetAppLogsPathOutcome,
  SessionLogAppGroupRequest,
  SessionLogAppGroupResult,
  SessionLogFilesRequest,
  SessionLogFilesResult,
  UnifiedLogWindowRequest,
  UnifiedLogWindowResult,
} from "./sessionLogContract";

/**
 * The service keys providers by platform, so iOS gets one provider that routes
 * each read by device kind: Simulators read through simctl, physical devices
 * through the host `log collect` path (#14104).
 */
export class IosSessionLogProvider implements SessionLogProvider {
  readonly platform = "ios" as const;

  constructor(
    private readonly simulator: IosSimulatorSessionLogProvider,
    private readonly physical: PhysicalIosSessionLogProvider,
  ) {}

  readAppLogs(
    device: BootedDevice,
    appId: string,
    request: SessionLogFilesRequest,
    maxBytes: number,
  ): Promise<SessionLogFilesResult> {
    return this.isPhysical(device)
      ? this.physical.readAppLogs(device)
      : this.simulator.readAppLogs(device, appId, request, maxBytes);
  }

  resetAppLogs(request: ResetAppLogsRequest): Promise<ResetAppLogsPathOutcome[]> {
    return this.isPhysical(request.device)
      ? this.physical.resetAppLogs(request)
      : this.simulator.resetAppLogs(request);
  }

  readAppGroup(
    device: BootedDevice,
    appId: string,
    request: SessionLogAppGroupRequest,
    maxBytes: number,
  ): Promise<SessionLogAppGroupResult> {
    // The Simulator provider refuses physical devices with its own reason.
    return this.simulator.readAppGroup(device, appId, request, maxBytes);
  }

  collectUnifiedLog(
    device: BootedDevice,
    appId: string,
    request: UnifiedLogWindowRequest,
    maxBytes: number,
    signal?: AbortSignal,
    retain: "head" | "tail" = "head",
  ): Promise<UnifiedLogWindowResult> {
    return this.isPhysical(device)
      ? this.physical.collectUnifiedLog(device, appId, request, maxBytes, signal)
      : this.simulator.collectUnifiedLog(device, appId, request, maxBytes, signal, retain);
  }

  private isPhysical(device: BootedDevice): boolean {
    return resolveIosDeviceKind({ deviceId: device.deviceId }) === "physical";
  }
}
