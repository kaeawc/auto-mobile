import { DEFAULT_RUNNER_PROVISION_TIMEOUT_MS } from "./runnerReadinessConfig";

// Cold virtual devices can legitimately need three minutes before OS readiness.
export const DEFAULT_DEVICE_READY_TIMEOUT_MS = 180_000;
// Legacy startDevice shares one budget across boot and automation readiness.
export const DEFAULT_START_DEVICE_TIMEOUT_MS =
  DEFAULT_DEVICE_READY_TIMEOUT_MS + DEFAULT_RUNNER_PROVISION_TIMEOUT_MS;
// A full resource request may verify dozens of native services sequentially.
export const DEFAULT_DEVICE_RESOURCE_TIMEOUT_MS = 300_000;
export const DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS = 60_000;
// Exact virtual-device provisioning can spend up to five minutes in
// `avdmanager create avd` before the regular boot/readiness phases begin.
export const DEFAULT_PROVISION_DEVICE_TIMEOUT_MS = 8 * 60 * 1000;
export const START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS = 5_000;
export const DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DAEMON_RPC_SOCKET_COMPLETION_HEADROOM_MS = 5_000;
// Keep the complete startDevice request (device budget + MCP overhead) below
// the daemon socket's idle timeout, with headroom for response serialization.
export const MAX_DEVICE_READY_TIMEOUT_MS =
  DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS -
  START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS -
  DAEMON_RPC_SOCKET_COMPLETION_HEADROOM_MS;
// Provisioning reserves one bounded teardown window after its own requested
// budget so a failed newly-created device can report verified rollback status.
export const MAX_PROVISION_DEVICE_TIMEOUT_MS =
  MAX_DEVICE_READY_TIMEOUT_MS - DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS;
// A coordinated shutdown must queue behind an in-flight boot without consuming
// the shutdown command's own timeout budget (see SimCtlClient.shutdownSimulatorCoordinated),
// but the queue wait still needs its own ceiling so a caller with no ambient
// abort signal (CI boot recovery, boot-handle cleanup) can't block forever on a
// wedged boot. Bound it by the same allowance a boot itself is granted.
export const SIMULATOR_SHUTDOWN_LEASE_WAIT_TIMEOUT_MS = DEFAULT_DEVICE_READY_TIMEOUT_MS;
