import type { DaemonMcpProxyCloseOptions } from "../daemon/daemonMcpProxy";
import type { parseArgs } from "../cli/parseArgs";

/** The command-line options `main()` resolved for this process. */
export type ParsedArgs = ReturnType<typeof parseArgs>;

/** Process-wide stdio state that the shutdown handler reads and the server start-up writes. */
export interface StdioRuntimeState {
  stdioProxy: { close(options?: DaemonMcpProxyCloseOptions): Promise<void> } | undefined;
  directModeActive: boolean;
}
