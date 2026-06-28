import type { DaemonRequest } from "./types";

export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Floor for `executePlan` when forwarding socket requests to the in-daemon MCP HTTP client.
 * Short timeouts abort the inner `callTool`, which drops the Streamable HTTP session and
 * cancels in-flight plan execution (`Operation cancelled`).
 *
 * Keep in sync with `MIN_EXECUTE_PLAN_TIMEOUT_MS` in
 * `android/junit-runner/.../AutoMobilePlanTypes.kt`.
 */
export const MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS = 600_000;

/**
 * Floor for `startDevice` — cold-booting an emulator can take 45-90s depending on
 * host performance (especially under emulation/Rosetta).
 */
export const MIN_START_DEVICE_MCP_TIMEOUT_MS = 180_000;

/**
 * Floor for `launchApp` — an iOS cold launch waits for CtrlProxy to deliver the
 * first hierarchy (`waitForIosHierarchyReady`, up to 60s), and with
 * `clearAppData` the app is wiped and relaunched fresh. Either can exceed the
 * default 30s window, so give the request room to finish rather than aborting a
 * launch that actually succeeded on screen.
 */
export const MIN_LAUNCH_APP_MCP_TIMEOUT_MS = 90_000;

/**
 * Floor for `openLink` — deep links can trigger sign-in, onboarding, data sync,
 * or other post-open navigation before the final observation settles. Keep the
 * default at the standard request timeout, while allowing deployments with slow
 * deeplinks to raise it without changing callers.
 */
export const DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS = DEFAULT_MCP_REQUEST_TIMEOUT_MS;
export const OPEN_LINK_MCP_TIMEOUT_ENV_VAR = "AUTOMOBILE_OPEN_LINK_MCP_TIMEOUT_MS";
export const LEGACY_OPEN_LINK_MCP_TIMEOUT_ENV_VAR = "AUTO_MOBILE_OPEN_LINK_MCP_TIMEOUT_MS";

function resolveOpenLinkMcpTimeoutFloorMs(): number {
  const raw = process.env[OPEN_LINK_MCP_TIMEOUT_ENV_VAR] ??
    process.env[LEGACY_OPEN_LINK_MCP_TIMEOUT_ENV_VAR];
  if (!raw) {
    return DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS;
}

/** Per-tool minimum request timeouts. Tools absent here use the default. */
const TOOL_TIMEOUT_FLOORS: Record<string, () => number> = {
  executePlan: () => MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS,
  startDevice: () => MIN_START_DEVICE_MCP_TIMEOUT_MS,
  launchApp: () => MIN_LAUNCH_APP_MCP_TIMEOUT_MS,
  openLink: resolveOpenLinkMcpTimeoutFloorMs,
};

export function resolveMcpRequestTimeoutMs(request: DaemonRequest): number {
  const raw = request.timeoutMs;
  const base =
    typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? raw
      : DEFAULT_MCP_REQUEST_TIMEOUT_MS;
  const resolveFloor = request.method === "tools/call"
    ? TOOL_TIMEOUT_FLOORS[request.params?.name]
    : undefined;
  const floor = resolveFloor?.();
  return floor ? Math.max(base, floor) : base;
}
