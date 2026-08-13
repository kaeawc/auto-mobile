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
export const START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS = 5_000;

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
 * or other post-open navigation before the final observation settles. A sign-in
 * deeplink that launches the app and performs a backend token exchange was
 * observed taking ~45s end to end (issue #2723), exceeding the 30s standard
 * timeout and aborting a link-open that actually succeeded on screen. Default to
 * the same 90s window as `launchApp` (openLink frequently launches the app too),
 * while allowing deployments with even slower deeplinks to raise it via env var
 * without changing callers.
 */
export const DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS = 90_000;
export const OPEN_LINK_MCP_TIMEOUT_ENV_VAR = "AUTOMOBILE_OPEN_LINK_MCP_TIMEOUT_MS";
export const LEGACY_OPEN_LINK_MCP_TIMEOUT_ENV_VAR = "AUTO_MOBILE_OPEN_LINK_MCP_TIMEOUT_MS";

/**
 * Floor for `observe` — on iOS the first observe after a device becomes active
 * lazily launches the CtrlProxy XCUITest runner and waits for its health endpoint,
 * a cold start that routinely exceeds the default 30s window on a loaded CI machine
 * (#2834). Aborting at 30s fails an observe whose runner is still coming up — and,
 * worse, the retry then reclaims the port and kills the still-starting runner. Give
 * observe the same generous floor as `launchApp` (which shares this dependency), and
 * make it env-overridable so CI — where the health-poll budget is extended — can
 * raise it in lockstep without a code change.
 */
export const DEFAULT_OBSERVE_MCP_TIMEOUT_MS = 90_000;
export const OBSERVE_MCP_TIMEOUT_ENV_VAR = "AUTOMOBILE_OBSERVE_MCP_TIMEOUT_MS";
export const LEGACY_OBSERVE_MCP_TIMEOUT_ENV_VAR = "AUTO_MOBILE_OBSERVE_MCP_TIMEOUT_MS";

function resolveEnvTimeoutFloorMs(
  primaryEnvVar: string,
  legacyEnvVar: string,
  fallbackMs: number
): number {
  const raw = process.env[primaryEnvVar] ?? process.env[legacyEnvVar];
  if (!raw) {
    return fallbackMs;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

function resolveToolTimeoutFloorMs(toolName: string | undefined): number | undefined {
  switch (toolName) {
    case "executePlan":
      return MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS;
    case "startDevice":
      return MIN_START_DEVICE_MCP_TIMEOUT_MS;
    case "launchApp":
      return MIN_LAUNCH_APP_MCP_TIMEOUT_MS;
    case "openLink":
      return resolveEnvTimeoutFloorMs(
        OPEN_LINK_MCP_TIMEOUT_ENV_VAR,
        LEGACY_OPEN_LINK_MCP_TIMEOUT_ENV_VAR,
        DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS
      );
    case "observe":
      return resolveEnvTimeoutFloorMs(
        OBSERVE_MCP_TIMEOUT_ENV_VAR,
        LEGACY_OBSERVE_MCP_TIMEOUT_ENV_VAR,
        DEFAULT_OBSERVE_MCP_TIMEOUT_MS
      );
    default:
      return undefined;
  }
}

function resolveStartDeviceToolBudgetMs(request: DaemonRequest): number | undefined {
  if (request.method !== "tools/call" || request.params?.name !== "startDevice") {
    return undefined;
  }
  const toolArguments = request.params?.arguments;
  if (!toolArguments || typeof toolArguments !== "object" || Array.isArray(toolArguments)) {
    return undefined;
  }
  const timeoutMs = (toolArguments as Record<string, unknown>).timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return timeoutMs + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS;
}

export function resolveMcpRequestTimeoutMs(request: DaemonRequest): number {
  const raw = request.timeoutMs;
  const base =
    typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? raw
      : DEFAULT_MCP_REQUEST_TIMEOUT_MS;
  const floor = request.method === "tools/call"
    ? resolveToolTimeoutFloorMs(request.params?.name)
    : undefined;
  const startDeviceBudget = resolveStartDeviceToolBudgetMs(request);
  return Math.max(base, floor ?? 0, startDeviceBudget ?? 0);
}
