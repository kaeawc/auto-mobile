import type { DaemonOptions, DaemonStatus } from "./types";
import type { DaemonExitRecordFileSystem } from "./daemonExitRecord";
import type { IdentityRecoveryIO } from "./identityRecovery";

/** Replaceable collaborators a `DaemonManager` reads on each use. */
export interface DaemonManagerSeams {
  exitRecordFileSystem: DaemonExitRecordFileSystem;
  currentBuildId: () => string;
  nextLaunchNonce: () => string;
  portFreeProbe: (port: number) => Promise<boolean>;
  launchLogFileSystem: {
    openSync(path: string, flags: "w", mode: number): number;
    closeSync(fd: number): void;
  };
  launchWorkingDirectory: () => string;
}

/** Typed view of `DaemonManager` internals for tests (see `getInternalsForTesting`). */
export interface DaemonManagerTestInternals {
  readonly seams: DaemonManagerSeams;
  readonly identityRecoveryIO: IdentityRecoveryIO;
  inheritExitSettings(options: DaemonOptions): Promise<DaemonOptions>;
  recoveryOptions(status: DaemonStatus, options: DaemonOptions): Promise<DaemonOptions>;
  tryJoinPeerDaemonAfterSpawnExit(budgetMs: number): Promise<boolean>;
  isIsolatedSocketNamespace(): boolean;
}
