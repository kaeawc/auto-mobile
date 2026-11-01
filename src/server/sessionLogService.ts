import { tmpdir } from "node:os";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { DefaultHostCommandExecutor } from "../utils/HostCommandExecutor";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import type { AppFileFileSystem } from "./appFileService";
import { nodeAppFileFileSystem } from "./appFileSupport";
import {
  DefaultSessionLogService,
  type SessionLogService,
  type SessionLogServiceDependencies,
} from "./DefaultSessionLogService";
import { AndroidSessionLogProvider } from "./AndroidSessionLogProvider";
import { IosSessionLogProvider } from "./IosSessionLogProvider";
import { IosSimulatorSessionLogProvider } from "./IosSimulatorSessionLogProvider";
import {
  PHYSICAL_UNIFIED_LOG_DEFAULT_TIMEOUT_MS,
  PhysicalIosSessionLogProvider,
} from "./PhysicalIosSessionLogProvider";
export type {
  SessionLogSimctl,
  SessionLogCollectRequest,
  ResetAppLogsRequest,
  SessionLogService,
  SessionLogServiceDependencies,
} from "./DefaultSessionLogService";

export const UNIFIED_LOG_DEFAULT_TIMEOUT_MS = 20_000;

let sessionLogService: SessionLogService | null = null;

export function getSessionLogService(): SessionLogService {
  if (!sessionLogService) {
    sessionLogService = createSessionLogService();
  }
  return sessionLogService;
}

export function createSessionLogService(
  deps: SessionLogServiceDependencies = {},
): SessionLogService {
  const timer = deps.timer ?? defaultTimer;
  const fileSystem = deps.fileSystem ?? nodeAppFileFileSystem;
  const providers = deps.providers ?? [
    new AndroidSessionLogProvider(deps.adbFactory ?? defaultAdbClientFactory),
    new IosSessionLogProvider(
      new IosSimulatorSessionLogProvider(
        deps.simctlFactory ?? ((device) => new SimCtlClient(device)),
        fileSystem,
        timer,
        {
          unifiedLogTimeoutMs: deps.unifiedLogTimeoutMs ?? UNIFIED_LOG_DEFAULT_TIMEOUT_MS,
          ownership: deps.containerOwnership,
        },
      ),
      createPhysicalIosProvider(deps.physicalIos, fileSystem, timer),
    ),
  ];
  return new DefaultSessionLogService(providers);
}

function createPhysicalIosProvider(
  physicalIos: SessionLogServiceDependencies["physicalIos"] = {},
  fileSystem: AppFileFileSystem,
  timer: Timer,
): PhysicalIosSessionLogProvider {
  return new PhysicalIosSessionLogProvider({
    host: physicalIos.host ?? new DefaultHostCommandExecutor(),
    fileSystem,
    timer,
    timeoutMs: physicalIos.timeoutMs ?? PHYSICAL_UNIFIED_LOG_DEFAULT_TIMEOUT_MS,
    hostPlatform: physicalIos.hostPlatform ?? process.platform,
    tempRoot: physicalIos.tempRoot ?? tmpdir(),
  });
}
