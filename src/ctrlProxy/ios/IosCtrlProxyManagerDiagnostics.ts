import type { BootedDevice } from "../../models";
import type { Timer } from "../../utils/SystemTimer";
import type { HostProcessExecutor } from "../../utils/HostCommandExecutor";
import type { XcodeSigningManager } from "../../utils/ios-cmdline-tools/XcodeSigning";
import type { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import type { Xcodebuild } from "../../utils/ios-cmdline-tools/XcodebuildClient";
import type { ProcessSupervisor } from "../../utils/ProcessSupervisor";
import type { IosCtrlProxyBuilderPort } from "../IosCtrlProxyBuilderPort";
import type { RemoteCtrlProxyIOSRunner } from "../IOSCtrlProxyManager";
import type { HostPortAvailabilityChecker } from "./IOSHostPortAvailabilityChecker";
import type { IosCtrlProxyProcessClient } from "./IosCtrlProxyProcessClient";
import type { IosDeviceDetector } from "./IosDeviceDetector";
import type { IosTunnelClient } from "./IosTunnelClient";

/** Read-only view of an IOSCtrlProxyManager's collaborators and live state. */
export interface IosCtrlProxyManagerDiagnostics {
  readonly device: BootedDevice;
  readonly timer: Timer;
  readonly builder: IosCtrlProxyBuilderPort;
  readonly processExecutor: HostProcessExecutor;
  readonly xcodebuild: Xcodebuild;
  readonly processClient: IosCtrlProxyProcessClient;
  readonly signingManager: XcodeSigningManager;
  readonly deviceAppManager: DeviceAppManager;
  readonly remoteRunner: RemoteCtrlProxyIOSRunner;
  readonly hostPortAvailabilityChecker: HostPortAvailabilityChecker;
  readonly tunnelClient: IosTunnelClient;
  readonly processSupervisor: ProcessSupervisor;
  readonly deviceDetector: IosDeviceDetector;
  readonly servicePort: number;
  readonly xcTestProcessId: number | null;
  readonly isStopping: boolean;
  readonly attemptedSetup: boolean;
  hasRunnerGenerationToken(pid: number): boolean;
}
