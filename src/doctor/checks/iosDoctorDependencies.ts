/**
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { ExecResult } from "../../models";
import { SimCtlClient, type SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { XcodebuildClient, type Xcodebuild } from "../../utils/ios-cmdline-tools/XcodebuildClient";
import { DefaultHostCommandExecutor } from "../../utils/HostCommandExecutor";
import { logger, type Logger } from "../../utils/logger";
import type { IosRunnerCommandRequirements } from "../../features/observe/ios/iosRunnerFeatureCommands";
import {
  SecurityClient,
  type SecurityClientApi,
} from "../../utils/ios-cmdline-tools/SecurityClient";
import { createCoreDeviceProbeHolder } from "../../utils/ios-cmdline-tools/CoreDeviceProbeHolder";
import type { CoreDeviceProbeDiagnostics } from "../../utils/ios-cmdline-tools/CoreDeviceCapabilityProbe";
import {
  NetworkFilterStatusInspector,
  type NetworkFilterHostStatus,
} from "../../features/networkFilter/NetworkFilterInstaller";
import { DOCTOR_EXEC_TIMEOUT_MS } from "../../utils/diagnosticTimeouts";
import { sortedReaddir } from "../../utils/io";
import {
  createIosSimFleetDoctorDependencies,
  type IosSimFleetDoctorDependencies,
} from "./iosSimFleet";
import {
  createIosCtrlProxyRunnerInspector,
  createIosObserveRoundTripInspector,
  type IosCtrlProxyRunnerInspector,
  type IosObserveRoundTripInspector,
} from "./iosRunnerInspectors";

// Route generic host-command execution through the shared HostCommandExecutor
// seam rather than a raw child_process execFile. The exec leaf lives in
// HostCommandExecutor, so the xcodebuild boundary ratchet does not flag this
// file, and xcodebuild specifically still goes through XcodebuildClient below.
const hostCommandExecutor = new DefaultHostCommandExecutor();

export interface IosDoctorDependencies {
  getCoreDeviceProbe: () => CoreDeviceProbeDiagnostics;
  platform: () => NodeJS.Platform;
  execFile: (
    file: string,
    args: string[],
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<ExecResult>;
  xcodebuild: Pick<Xcodebuild, "executeCommand">;
  fileExists: (path: string) => boolean;
  readDir: (path: string) => Promise<string[]>;
  homedir: () => string;
  securityClient: SecurityClientApi;
  logger: Logger;
  createSimctlClient: () => SimCtl;
  runnerInspector: IosCtrlProxyRunnerInspector;
  runnerCommandRequirements?: IosRunnerCommandRequirements;
  observeRoundTripInspector: IosObserveRoundTripInspector;
  /**
   * Read-only Network Extension status (#10588). Optional so suites that build
   * their own dependencies skip the check rather than probing the real host.
   */
  networkFilterInspector?: {
    inspect(options?: { timeoutMs?: number }): Promise<NetworkFilterHostStatus>;
  };
  /**
   * Read-only simulator fleet cost / capacity report (#6696). Optional so suites that
   * build their own dependencies skip the check rather than probing the real host.
   */
  simFleet?: IosSimFleetDoctorDependencies;
}

export function createIosDoctorDependencies(
  options: { coreDeviceProbe?: CoreDeviceProbeDiagnostics } = {},
): IosDoctorDependencies {
  const holder = createCoreDeviceProbeHolder();
  return {
    getCoreDeviceProbe: () => options.coreDeviceProbe ?? holder.get(),
    platform: () => process.platform,
    execFile: (file, args, options = {}) =>
      hostCommandExecutor.executeCommand(file, args, {
        timeoutMs: options.timeoutMs ?? DOCTOR_EXEC_TIMEOUT_MS,
        signal: options.signal,
        killSignal: "SIGKILL",
      }),
    xcodebuild: new XcodebuildClient(),
    fileExists: existsSync,
    readDir: async (path) => sortedReaddir(path),
    homedir,
    securityClient: new SecurityClient(),
    logger,
    createSimctlClient: () => new SimCtlClient(),
    runnerInspector: createIosCtrlProxyRunnerInspector(() => new SimCtlClient(), logger),
    observeRoundTripInspector: createIosObserveRoundTripInspector(() => new SimCtlClient(), logger),
    networkFilterInspector: new NetworkFilterStatusInspector(),
    simFleet: createIosSimFleetDoctorDependencies(),
  };
}
