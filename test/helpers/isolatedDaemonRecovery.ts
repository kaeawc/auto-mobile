import * as os from "node:os";
import * as path from "node:path";
import type { DaemonClientRecoveryOptions } from "../../src/daemon/client/client";

/**
 * Recovery options that keep a unit-test DaemonClient off the host's real
 * daemon PID file (/tmp/auto-mobile-daemon-<uid>.pid). Without this, a failed
 * connect appends the "recorded daemon PID ... is not running" hint whenever the
 * host's resident daemon happens to be down, so assertions depend on host state.
 * The path never exists, so the client reads no PID and adds no hint.
 */
export const ISOLATED_DAEMON_RECOVERY: DaemonClientRecoveryOptions = {
  pidFilePath: path.join(os.tmpdir(), "auto-mobile-test-nonexistent-dir", "daemon.pid"),
};
