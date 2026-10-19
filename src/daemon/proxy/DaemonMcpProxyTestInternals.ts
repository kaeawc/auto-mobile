import type { ReleaseEpochLedger } from "./ReleaseEpochLedger";

/** Typed view of `DaemonMcpProxy` internals for tests (see `getInternalsForTesting`). */
export interface DaemonMcpProxyTestInternals {
  resetConnection(): Promise<void>;
  readonly resourceSubscriptions: Set<string>;
  readonly releaseLedger: ReleaseEpochLedger;
}
