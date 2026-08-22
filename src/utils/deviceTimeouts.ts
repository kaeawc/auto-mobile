export const DEFAULT_DEVICE_READY_TIMEOUT_MS = 120000;
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
