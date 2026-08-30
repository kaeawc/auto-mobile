import type { DaemonRequest } from "./types";
import {
  DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS,
  DEFAULT_DEVICE_READY_TIMEOUT_MS,
  DEFAULT_PROVISION_DEVICE_TIMEOUT_MS,
  MAX_DEVICE_READY_TIMEOUT_MS,
  START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
} from "../utils/deviceTimeouts";
import { DEFAULT_RUNNER_READINESS_TIMEOUT_MS } from "../utils/runnerReadinessConfig";

export { START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS };

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
 * Floor for device preparation — cold-booting an emulator can take 45-90s depending on
 * host performance (especially under emulation/Rosetta).
 */
export const MIN_START_DEVICE_MCP_TIMEOUT_MS = 180_000;

/**
 * Floor for exact virtual-device provisioning. Android AVD creation alone
 * permits a five-minute command budget before the shared boot/readiness path,
 * and the transport needs time to persist and return its final result.
 */
export const MIN_PROVISION_DEVICE_MCP_TIMEOUT_MS =
  DEFAULT_PROVISION_DEVICE_TIMEOUT_MS + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS;

export const MIN_TEARDOWN_DEVICE_MCP_TIMEOUT_MS =
  DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS;

/**
 * Floor for `launchApp` — an iOS cold launch waits for CtrlProxy to deliver the
 * first hierarchy (`waitForIosHierarchyReady`, up to 60s), and with
 * `clearAppData` the app is wiped and relaunched fresh. Either can exceed the
 * default 30s window, so give the request room to finish rather than aborting a
 * launch that actually succeeded on screen.
 */
export const MIN_LAUNCH_APP_MCP_TIMEOUT_MS = 90_000;

/**
 * Floor for `crashApp` — Android ActivityManager can take several seconds to
 * deliver the in-process exception, and target-specific process/log evidence is
 * collected afterward. Device readiness also consumes the same request budget.
 * A transport timeout after induction falsely reports failure and makes retrying
 * unsafe because the original crash may already have completed.
 */
export const MIN_CRASH_APP_MCP_TIMEOUT_MS = 60_000;

/**
 * Compatibility floor while video recording startup moves to a strict,
 * backend-owned five-second budget.
 */
export const MIN_VIDEO_RECORDING_MCP_TIMEOUT_MS = 90_000;

/**
 * Floor for `uninstallApp` — the Android command has a 20s local deadline,
 * followed by bounded package-state reconciliation (and, if still installed,
 * one retry). The default 30s MCP deadline can otherwise abort recovery after
 * Android has already removed the package, causing a false failure.
 */
export const MIN_UNINSTALL_APP_MCP_TIMEOUT_MS = 60_000;

/**
 * Floor for preference tools — iOS `setPreference` has a 30s write/read-back
 * deadline and direct `getPreference` permits independently retried value and
 * type reads for up to 40s. The transport budget starts before queueing, so it
 * needs headroom to return the feature's own terminal result.
 */
export const MIN_PREFERENCE_MCP_TIMEOUT_MS = 60_000;

const TOOL_TIMEOUT_FLOORS: Readonly<Record<string, number>> = {
  crashApp: MIN_CRASH_APP_MCP_TIMEOUT_MS,
  getPreference: MIN_PREFERENCE_MCP_TIMEOUT_MS,
  setPreference: MIN_PREFERENCE_MCP_TIMEOUT_MS,
};

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
  fallbackMs: number,
): number {
  const raw = process.env[primaryEnvVar] ?? process.env[legacyEnvVar];
  if (!raw) {
    return fallbackMs;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

function resolveFixedToolTimeoutFloorMs(toolName: string | undefined): number | undefined {
  return TOOL_TIMEOUT_FLOORS[toolName ?? ""];
}

function resolveToolTimeoutFloorMs(toolName: string | undefined): number | undefined {
  switch (toolName) {
    case "executePlan":
      return MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS;
    case "getAndroid":
    case "getApple":
    case "startDevice":
      return MIN_START_DEVICE_MCP_TIMEOUT_MS;
    case "provisionDevice":
      return MIN_PROVISION_DEVICE_MCP_TIMEOUT_MS;
    case "deleteDevice":
      return MIN_TEARDOWN_DEVICE_MCP_TIMEOUT_MS;
    case "launchApp":
      return MIN_LAUNCH_APP_MCP_TIMEOUT_MS;
    case "videoRecording":
      return MIN_VIDEO_RECORDING_MCP_TIMEOUT_MS;
    case "uninstallApp":
      return MIN_UNINSTALL_APP_MCP_TIMEOUT_MS;
    case "openLink":
      return resolveEnvTimeoutFloorMs(
        OPEN_LINK_MCP_TIMEOUT_ENV_VAR,
        LEGACY_OPEN_LINK_MCP_TIMEOUT_ENV_VAR,
        DEFAULT_OPEN_LINK_MCP_TIMEOUT_MS,
      );
    case "observe":
      return resolveEnvTimeoutFloorMs(
        OBSERVE_MCP_TIMEOUT_ENV_VAR,
        LEGACY_OBSERVE_MCP_TIMEOUT_ENV_VAR,
        DEFAULT_OBSERVE_MCP_TIMEOUT_MS,
      );
    default:
      return resolveFixedToolTimeoutFloorMs(toolName);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveNamedDevicePreparationBudgetMs(argumentsRecord: Record<string, unknown>): number {
  const bootTimeoutMs =
    positiveFiniteNumber(argumentsRecord.bootTimeoutMs) ?? DEFAULT_DEVICE_READY_TIMEOUT_MS;
  const automationReadyTimeoutMs =
    positiveFiniteNumber(argumentsRecord.automationReadyTimeoutMs) ??
    DEFAULT_RUNNER_READINESS_TIMEOUT_MS;
  return (
    Math.min(bootTimeoutMs + automationReadyTimeoutMs, MAX_DEVICE_READY_TIMEOUT_MS) +
    START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS
  );
}

function resolveLegacyStartDeviceBudgetMs(
  argumentsRecord: Record<string, unknown>,
): number | undefined {
  const legacyTimeoutMs = asRecord(argumentsRecord.device)?.timeoutMs;
  // Match startDeviceSchema's legacy normalization: an explicit top-level value
  // wins over the nested device payload.
  const timeoutMs = positiveFiniteNumber(argumentsRecord.timeoutMs ?? legacyTimeoutMs);
  if (timeoutMs === undefined) {
    return undefined;
  }
  return Math.min(timeoutMs, MAX_DEVICE_READY_TIMEOUT_MS) + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS;
}

function resolveDevicePreparationToolBudgetMs(request: DaemonRequest): number | undefined {
  if (request.method !== "tools/call") {
    return undefined;
  }
  const argumentsRecord = asRecord(request.params?.arguments);
  if (!argumentsRecord) {
    return undefined;
  }
  switch (request.params?.name) {
    case "getAndroid":
    case "getApple":
      return resolveNamedDevicePreparationBudgetMs(argumentsRecord);
    case "startDevice":
      return resolveLegacyStartDeviceBudgetMs(argumentsRecord);
    case "provisionDevice": {
      const timeoutMs =
        positiveFiniteNumber(argumentsRecord.timeoutMs) ?? DEFAULT_PROVISION_DEVICE_TIMEOUT_MS;
      return (
        Math.min(timeoutMs, MAX_DEVICE_READY_TIMEOUT_MS) + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS
      );
    }
    case "deleteDevice": {
      const timeoutMs =
        positiveFiniteNumber(argumentsRecord.timeoutMs) ?? DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS;
      return (
        Math.min(timeoutMs, MAX_DEVICE_READY_TIMEOUT_MS) + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS
      );
    }
    default:
      return undefined;
  }
}

export function resolveMcpRequestTimeoutMs(request: DaemonRequest): number {
  const raw = request.timeoutMs;
  const base =
    typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? raw
      : DEFAULT_MCP_REQUEST_TIMEOUT_MS;
  const floor =
    request.method === "tools/call" ? resolveToolTimeoutFloorMs(request.params?.name) : undefined;
  const devicePreparationBudget = resolveDevicePreparationToolBudgetMs(request);
  return Math.max(base, floor ?? 0, devicePreparationBudget ?? 0);
}
