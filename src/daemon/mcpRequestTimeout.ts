import {
  DEFAULT_VM_SNAPSHOT_TIMEOUT_MS,
  MAX_VM_SNAPSHOT_TIMEOUT_MS,
  SNAPSHOT_MCP_TIMEOUT_HEADROOM_MS,
} from "../features/snapshot/deviceSnapshotTimeout";
import { BARRIER_TIMEOUT_MS } from "../features/action/coordinationTimeout";
import { DEFAULT_EXPLORE_TIMEOUT_MS } from "../features/navigation/exploreTimeout";
import {
  DEFAULT_OVERLAY_EVENT_TIMEOUT_MS,
  MAX_OVERLAY_EVENT_TIMEOUT_MS,
} from "../features/overlay/overlayEventTimeout";
import {
  DEFAULT_OVERLAY_ASSET_TIMEOUT_MS,
  MAX_OVERLAY_ASSET_COUNT,
} from "../features/overlay/overlayAssets";
import { OBSERVATION_SCREENSHOT_CAPTURE_WAIT_TIMEOUT_MS } from "../server/observationResourceUris";
import {
  DEFAULT_WAIT_FOR_TIMEOUT_MS,
  DEFAULT_STABLE_WAIT_FOR_TIMEOUT_MS,
  WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS,
} from "../features/observe/waitForTimeout";
import {
  APP_FILE_PUSH_TIMEOUT_MS,
  FILE_TRANSFER_MCP_TIMEOUT_HEADROOM_MS,
} from "../features/storage/fileTransferTimeout";
export {
  SNAPSHOT_MCP_TIMEOUT_HEADROOM_MS,
  WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS,
  FILE_TRANSFER_MCP_TIMEOUT_HEADROOM_MS,
};
import {
  resolveTextCtrlProxyTimeoutMs,
  TEXT_MCP_REQUEST_HEADROOM_MS,
  DEFAULT_TEXT_REQUEST_TIMEOUT_MS,
} from "../features/action/textTransportTimeout";
import * as yaml from "js-yaml";
import { PLAN_YAML_LOAD_OPTIONS } from "../utils/plan/planYaml";
import { PlanNormalizer } from "../utils/plan/PlanNormalizer";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { DaemonRequest } from "./types";
import {
  DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS,
  DEFAULT_DEVICE_READY_TIMEOUT_MS,
  DEFAULT_START_DEVICE_TIMEOUT_MS,
  DEFAULT_DEVICE_RESOURCE_TIMEOUT_MS,
  DEFAULT_PROVISION_DEVICE_TIMEOUT_MS,
  MAX_PROVISION_DEVICE_TIMEOUT_MS,
  MAX_DEVICE_READY_TIMEOUT_MS,
  START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
} from "../utils/deviceTimeouts";
import { DEFAULT_RUNNER_PROVISION_TIMEOUT_MS } from "../utils/runnerReadinessConfig";
import {
  TAP_ANY_SEARCH_UNTIL_DEFAULT_MS,
  TAP_ANY_LONG_PRESS_DEFAULT_DURATION_MS_IOS,
  TAP_ANY_LONG_PRESS_DEFAULT_DURATION_MS_ANDROID,
  TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS,
  TAP_ANY_ORDINARY_TAP_GESTURE_WORST_CASE_MS,
  LONG_PRESS_TIMEOUT_HEADROOM_MS,
} from "../features/action/TapAnyElement";
import { MAX_SETTIMEOUT_DELAY_MS } from "../utils/SystemTimer";
import { ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS } from "../features/action/installAppTimeout";

export { START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS, MAX_SETTIMEOUT_DELAY_MS };

export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Upper bound on a caller-supplied `DaemonRequest.timeoutMs` (#6385). Clients
 * now send their own deadline, and the daemon honours it -- but a buggy or
 * hostile value (e.g. `Number.MAX_SAFE_INTEGER`) must not pin a request's
 * device lock and queue slot indefinitely, nor overflow `setTimeout` (which
 * fires immediately past `MAX_SETTIMEOUT_DELAY_MS`). Server-derived per-tool
 * floors are applied after this clamp, so a tool whose own floor is larger
 * still gets it.
 */
export const MAX_CALLER_MCP_REQUEST_TIMEOUT_MS = 1_800_000;

/**
 * Clamp a caller-supplied timeout into `(0, MAX_CALLER_MCP_REQUEST_TIMEOUT_MS]`.
 * Returns `undefined` for a missing, non-finite, or non-positive value so the
 * caller falls back to {@link DEFAULT_MCP_REQUEST_TIMEOUT_MS}.
 */
export function clampCallerMcpRequestTimeoutMs(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return undefined;
  }
  return Math.min(raw, MAX_CALLER_MCP_REQUEST_TIMEOUT_MS);
}

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
 * Allowance added on top of a plan's summed step budgets for what runs outside any step: the
 * plan's terminal result, cleanup and session release. Reuses the wait-budget headroom so the
 * plan deadline tracks the same dispatch/report allowance every wait step already carries.
 */
export const EXECUTE_PLAN_BUDGET_HEADROOM_MS = WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS;

/** `planContent` larger than this is not parsed on the request path; it saturates at the cap. */
export const MAX_EXECUTE_PLAN_BUDGET_CONTENT_CHARS = 1_000_000;

/** Steps visited (nested `criticalSection` sub-steps included) before the budget saturates. */
export const MAX_EXECUTE_PLAN_BUDGET_STEPS = 5_000;

/** Nesting depth of `criticalSection` sub-steps visited before the budget saturates. */
const MAX_EXECUTE_PLAN_BUDGET_DEPTH = 8;

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
  DEFAULT_PROVISION_DEVICE_TIMEOUT_MS +
  DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS +
  START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS;

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
export const MIN_CRASH_APP_MCP_TIMEOUT_MS = 90_000;

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

/** Headroom for install inventory, force-stop, user restoration and verification. */
export const INSTALL_APP_MCP_TIMEOUT_HEADROOM_MS = 30_000;

/**
 * Floor for `installApp` — Android downgrade recovery can consume three full
 * transfer budgets: the initial install, package-wide uninstall, and reinstall.
 * Budget the entire chain plus headroom rather than aborting after removal when
 * only one transfer was allowed. Share the action's per-command constant so the
 * outer deadline tracks its budget. Headroom is an allowance, not a bound on
 * arbitrary user counts or transport delays; cancellation can still interrupt
 * recovery after uninstall.
 */
export const MIN_INSTALL_APP_MCP_TIMEOUT_MS =
  3 * ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS + INSTALL_APP_MCP_TIMEOUT_HEADROOM_MS;

/**
 * Floor for preference tools — iOS `setPreference` has a 30s write/read-back
 * deadline and direct `getPreference` permits independently retried value and
 * type reads for up to 40s. The transport budget starts before queueing, so it
 * needs headroom to return the feature's own terminal result.
 */
export const MIN_PREFERENCE_MCP_TIMEOUT_MS = 60_000;

/**
 * Floor for `setUIState` -- a multi-field call chains several fields' apply
 * + verify device round trips sequentially, and on the direct CLI->daemon
 * transport it never carries the MCP `_meta.progressToken` needed for
 * `ProgressExtendableDeadline` to extend this budget (issue #6222 reopen):
 * `runToolViaDaemon` in `src/cli/index.ts` calls `DaemonMcpProxy.callTool`
 * with no progressToken, so `notifications/progress` -- and the deadline
 * extension it drives -- never fires on that path, unlike the MCP-server
 * proxy path (`src/server/proxyServer.ts`) which always forwards the
 * caller's own token. `SetUIState` itself now self-limits to a smaller
 * internal result deadline and returns a structured partial result before
 * this transport-level timeout could fire -- that is the real safety net.
 * This floor is a second line of defense, giving a legitimate multi-field
 * form extra transport headroom even when progress relay never engages.
 */
export const MIN_SET_UI_STATE_MCP_TIMEOUT_MS = 60_000;

/**
 * Headroom added to a `tapAny` longPress duration when sizing the OUTER MCP
 * request deadline. `TapAnyElement` raises the CtrlProxy-level request
 * timeout for a long press to `duration + LONG_PRESS_TIMEOUT_HEADROOM_MS`
 * (src/features/action/TapAnyElement.ts) so CtrlProxy's reply isn't aborted
 * before the on-device press finishes — but that only widens the INNER
 * request. Without a matching floor here, the daemon's outer deadline still
 * defaults to `DEFAULT_MCP_REQUEST_TIMEOUT_MS` (30s) and can kill a
 * legitimately-running long press well before a longer inner timeout expires
 * (issue #6248 review, P2). A direct re-export of `LONG_PRESS_TIMEOUT_HEADROOM_MS`
 * (TapAnyElement.ts's own single source of truth) rather than a duplicated
 * literal, so the two can never drift out of sync.
 */
export const TAP_ANY_LONG_PRESS_MCP_TIMEOUT_HEADROOM_MS = LONG_PRESS_TIMEOUT_HEADROOM_MS;

// `TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS` is now computed once, in
// `TapAnyElement.ts`, alongside `TAP_ANY_LONG_PRESS_MAX_DURATION_MS` (which
// `TapAnyElement.getLongPressDuration` uses to REJECT an absurd `duration` at
// the source rather than merely clamping the derived timers -- issue #6248
// review, P2, fuZRt/fuZRo). Re-exported here so existing importers of this
// module are unaffected.
export { TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS };

/**
 * Effective press duration budgeted when a `tapAny` longPress omits
 * `duration` (or passes a non-positive value). `TapAnyElement.getLongPressDuration`
 * substitutes a real on-device press length in that case rather than a no-op
 * (`TAP_ANY_LONG_PRESS_DEFAULT_DURATION_MS_IOS`/`_ANDROID` in TapAnyElement.ts) --
 * this module budgets the larger of the two platform defaults because a
 * `DaemonRequest` does not carry which platform the target device is (issue
 * #6248 review, P2). Using the larger default only ever over-budgets the
 * outer deadline, never under-budgets it.
 */
const TAP_ANY_LONG_PRESS_DEFAULT_DURATION_MS = Math.max(
  TAP_ANY_LONG_PRESS_DEFAULT_DURATION_MS_IOS,
  TAP_ANY_LONG_PRESS_DEFAULT_DURATION_MS_ANDROID,
);

// A Map, not a plain object: the tool name is client-supplied, and an index such
// as `table["constructor"]` would reach inherited `Object.prototype` members.
const TOOL_TIMEOUT_FLOORS: ReadonlyMap<string, number> = new Map(
  Object.entries({
    deviceSnapshot: DEFAULT_VM_SNAPSHOT_TIMEOUT_MS + SNAPSHOT_MCP_TIMEOUT_HEADROOM_MS,
    barrier: BARRIER_TIMEOUT_MS + WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS,
    criticalSection: BARRIER_TIMEOUT_MS + WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS,
    explore: DEFAULT_EXPLORE_TIMEOUT_MS + WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS,
    putAppFile: APP_FILE_PUSH_TIMEOUT_MS + FILE_TRANSFER_MCP_TIMEOUT_HEADROOM_MS,
    setDeviceResources: DEFAULT_DEVICE_RESOURCE_TIMEOUT_MS + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS,
    uninstallApp: MIN_UNINSTALL_APP_MCP_TIMEOUT_MS,
    crashApp: MIN_CRASH_APP_MCP_TIMEOUT_MS,
    getPreference: MIN_PREFERENCE_MCP_TIMEOUT_MS,
    setPreference: MIN_PREFERENCE_MCP_TIMEOUT_MS,
    setUIState: MIN_SET_UI_STATE_MCP_TIMEOUT_MS,
  }),
);

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

function resolveFixedToolTimeoutFloorMs(toolName: unknown): number | undefined {
  return typeof toolName === "string" ? TOOL_TIMEOUT_FLOORS.get(toolName) : undefined;
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
    case "installApp":
      return MIN_INSTALL_APP_MCP_TIMEOUT_MS;
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

/**
 * Invalid/non-positive/non-finite budgets use the tool default, matching device
 * preparation. Oversized finite values (including budget + headroom) saturate at
 * the caller cap; no transport headroom can be guaranteed at that ceiling.
 */
function resolveArgumentTimeoutBudgetMs(
  raw: unknown,
  defaultMs: number,
  headroomMs: number,
): number {
  return Math.min(
    (positiveFiniteNumber(raw) ?? defaultMs) + headroomMs,
    MAX_CALLER_MCP_REQUEST_TIMEOUT_MS,
    MAX_SETTIMEOUT_DELAY_MS,
  );
}

function resolveObserveWaitBudgetMs(args: Record<string, unknown>): number {
  const waitFor = asRecord(args.waitFor);
  if (!waitFor) {
    return 0;
  }
  const defaultMs =
    waitFor.for === "stable" ? DEFAULT_STABLE_WAIT_FOR_TIMEOUT_MS : DEFAULT_WAIT_FOR_TIMEOUT_MS;
  // Both legacy predicates and the `for` DSL read these nested aliases in this
  // order. Top-level timeoutMs is not a wait budget; schema validation owns it.
  return resolveArgumentTimeoutBudgetMs(
    waitFor.timeout ?? waitFor.timeoutMs,
    defaultMs,
    WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS,
  );
}

function resolveFileTransferBudgetMs(args: Record<string, unknown>, pushMs: number): number {
  // Canonical putAppFile uses files[]; its legacy flat
  // single-file shape, missing/invalid arrays, and empty arrays get one push.
  // Count without visiting entries, so even an enormous sparse array is cheap.
  const count = Array.isArray(args.files) ? Math.max(1, args.files.length) : 1;
  return resolveArgumentTimeoutBudgetMs(
    count * pushMs,
    pushMs,
    FILE_TRANSFER_MCP_TIMEOUT_HEADROOM_MS,
  );
}

/** Default device request timeout of a show/update, mirrored from the overlay tool. */
const OVERLAY_MUTATION_DEFAULT_TIMEOUT_MS = 5_000;

function countObservationAssets(assets: readonly unknown[], count: number): number {
  let observations = 0;
  for (let index = 0; index < count; index += 1) {
    const entry = asRecord(assets[index]);
    if (entry !== undefined && typeof entry.observation === "string") {
      observations += 1;
    }
  }
  return observations;
}

/**
 * Worst-case time of a show/update before any wait: the asset uploads and the send, or the send
 * alone. Uploads run one at a time, each with its own transport timeout, before the show/update
 * request itself. `assetCount` is the number of entries the tool will process (<= its maximum).
 */
function resolveOverlayStageBudgetMs(args: Record<string, unknown>, assetCount: number): number {
  const mutationMs = positiveFiniteNumber(args.timeoutMs) ?? OVERLAY_MUTATION_DEFAULT_TIMEOUT_MS;
  if (assetCount === 0) {
    return mutationMs;
  }
  // An observation source may wait for its screenshot capture before anything is uploaded.
  const captureWaitMs =
    countObservationAssets(Array.isArray(args.assets) ? args.assets : [], assetCount) *
    OBSERVATION_SCREENSHOT_CAPTURE_WAIT_TIMEOUT_MS;
  // The tool re-uploads assets the device reports missing and re-sends the overlay once, so the
  // upload-and-send pair is budgeted twice (the retry uploads at most the same assets).
  return captureWaitMs + 2 * (assetCount * DEFAULT_OVERLAY_ASSET_TIMEOUT_MS + mutationMs);
}

function overlayAssetCount(args: Record<string, unknown>): number {
  // Count entries without visiting more than the tool's maximum.
  return Array.isArray(args.assets) ? Math.min(args.assets.length, MAX_OVERLAY_ASSET_COUNT) : 0;
}

function resolveOverlayAssetUploadBudgetMs(args: Record<string, unknown>): number {
  const count = overlayAssetCount(args);
  return count === 0
    ? 0
    : resolveArgumentTimeoutBudgetMs(
        resolveOverlayStageBudgetMs(args, count),
        DEFAULT_OVERLAY_ASSET_TIMEOUT_MS,
        WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS,
      );
}

/**
 * showVariants is a show followed by an optional selection wait: the show stage (uploads, send
 * and the single missing-asset retry, as for `show`) plus the default event wait, plus headroom.
 * The wait is always the default one, independent of the show's `timeoutMs`.
 */
function resolveOverlayVariantsBudgetMs(args: Record<string, unknown>): number {
  const count = overlayAssetCount(args);
  const waitMs = args.waitForSelection === true ? DEFAULT_OVERLAY_EVENT_TIMEOUT_MS : 0;
  if (count === 0 && waitMs === 0) {
    return 0;
  }
  return resolveArgumentTimeoutBudgetMs(
    resolveOverlayStageBudgetMs(args, count) + waitMs,
    DEFAULT_OVERLAY_EVENT_TIMEOUT_MS,
    WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS,
  );
}

function resolveOverlayAwaitBudgetMs(args: Record<string, unknown>): number {
  // Only `awaitEvent` waits, `showVariants` with `waitForSelection: true` waits after its show,
  // and only `show`/`update`/`showVariants` with `assets` upload; every other overlay action
  // keeps the default deadline. The tool's own maximum bounds the wait, so a larger value
  // (rejected by its schema anyway) cannot inflate the deadline past that maximum plus headroom.
  if (args.action === "show" || args.action === "update") {
    return resolveOverlayAssetUploadBudgetMs(args);
  }
  if (args.action === "showVariants") {
    return resolveOverlayVariantsBudgetMs(args);
  }
  if (args.action !== "awaitEvent") {
    return 0;
  }
  return resolveArgumentTimeoutBudgetMs(
    Math.min(
      positiveFiniteNumber(args.timeoutMs) ?? DEFAULT_OVERLAY_EVENT_TIMEOUT_MS,
      MAX_OVERLAY_EVENT_TIMEOUT_MS,
    ),
    DEFAULT_OVERLAY_EVENT_TIMEOUT_MS,
    WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS,
  );
}

const ARGUMENT_BUDGET_RESOLVERS: ReadonlyMap<string, (args: Record<string, unknown>) => number> =
  new Map([
    [
      "deviceSnapshot",
      (args) =>
        resolveArgumentTimeoutBudgetMs(
          Math.min(
            positiveFiniteNumber(args.vmSnapshotTimeoutMs) ?? DEFAULT_VM_SNAPSHOT_TIMEOUT_MS,
            MAX_VM_SNAPSHOT_TIMEOUT_MS,
          ),
          DEFAULT_VM_SNAPSHOT_TIMEOUT_MS,
          SNAPSHOT_MCP_TIMEOUT_HEADROOM_MS,
        ),
    ],
    ["observe", resolveObserveWaitBudgetMs],
    [
      "barrier",
      (args) =>
        resolveArgumentTimeoutBudgetMs(
          args.timeout,
          BARRIER_TIMEOUT_MS,
          WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS,
        ),
    ],
    [
      "criticalSection",
      (args) =>
        resolveArgumentTimeoutBudgetMs(
          args.timeout,
          BARRIER_TIMEOUT_MS,
          WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS,
        ),
    ],
    [
      "explore",
      (args) =>
        resolveArgumentTimeoutBudgetMs(
          args.timeoutMs,
          DEFAULT_EXPLORE_TIMEOUT_MS,
          WAIT_BUDGET_MCP_TIMEOUT_HEADROOM_MS,
        ),
    ],
    ["putAppFile", (args) => resolveFileTransferBudgetMs(args, APP_FILE_PUSH_TIMEOUT_MS)],
    ["overlay", resolveOverlayAwaitBudgetMs],
  ]);

function resolveArgumentBudgetToolBudgetMs(request: DaemonRequest): number {
  if (request.method !== "tools/call") {
    return 0;
  }
  const toolName: unknown = request.params?.name;
  const resolver =
    typeof toolName === "string" ? ARGUMENT_BUDGET_RESOLVERS.get(toolName) : undefined;
  return typeof resolver === "function" ? resolver(asRecord(request.params?.arguments) ?? {}) : 0;
}

function resolveNamedDevicePreparationBudgetMs(argumentsRecord: Record<string, unknown>): number {
  const bootTimeoutMs =
    positiveFiniteNumber(argumentsRecord.bootTimeoutMs) ?? DEFAULT_DEVICE_READY_TIMEOUT_MS;
  const automationReadyTimeoutMs =
    positiveFiniteNumber(argumentsRecord.automationReadyTimeoutMs) ??
    DEFAULT_RUNNER_PROVISION_TIMEOUT_MS;
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
  return (
    Math.min(timeoutMs ?? DEFAULT_START_DEVICE_TIMEOUT_MS, MAX_DEVICE_READY_TIMEOUT_MS) +
    START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS
  );
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
    case "provisionDevice":
      return resolveProvisionDeviceBudgetMs(argumentsRecord);
    case "deleteDevice": {
      const timeoutMs =
        positiveFiniteNumber(argumentsRecord.timeoutMs) ?? DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS;
      return (
        Math.min(timeoutMs, MAX_DEVICE_READY_TIMEOUT_MS) + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS
      );
    }
    case "setDeviceResources":
      return resolveDeviceResourceBudgetMs(argumentsRecord);
    default:
      return undefined;
  }
}

function resolveProvisionDeviceBudgetMs(args: Record<string, unknown>): number {
  const timeoutMs = positiveFiniteNumber(args.timeoutMs) ?? DEFAULT_PROVISION_DEVICE_TIMEOUT_MS;
  return (
    Math.min(timeoutMs, MAX_PROVISION_DEVICE_TIMEOUT_MS) +
    DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS +
    START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS
  );
}

function resolveDeviceResourceBudgetMs(args: Record<string, unknown>): number {
  const timeoutMs = positiveFiniteNumber(args.timeoutMs) ?? DEFAULT_DEVICE_RESOURCE_TIMEOUT_MS;
  return Math.min(timeoutMs, MAX_DEVICE_READY_TIMEOUT_MS) + START_DEVICE_MCP_TIMEOUT_OVERHEAD_MS;
}

/**
 * Floor for a `tapAny` longPress derived from its `duration` argument. A
 * plain tap/doubleTap (no `action: "longPress"`) or a longPress with no
 * positive `duration` still budgets the EFFECTIVE press duration --
 * `TapAnyElement.getLongPressDuration` substitutes a real default press
 * (`TAP_ANY_LONG_PRESS_DEFAULT_DURATION_MS`, the larger of the iOS/Android
 * defaults) in that case rather than performing no press at all, so an
 * omitted/zero `duration` must not budget zero press time either (issue
 * #6248 review, P2). A plain tap/doubleTap (no `action: "longPress"`) keeps
 * the standard floor/default -- only a longPress is raised.
 *
 * The outer MCP deadline must cover every phase of the call, not just the
 * press itself (issue #6248 review, P2):
 *   - The press itself, sized by the effective duration (the explicit
 *     `duration` argument, or `TAP_ANY_LONG_PRESS_DEFAULT_DURATION_MS` when
 *     omitted/zero).
 *   - PRE-GESTURE element discovery, sized by the effective
 *     `searchUntil.duration` -- when `searchUntil` is omitted entirely,
 *     `TapAnyElement.getSearchUntilDuration` still defaults every call to
 *     `TAP_ANY_SEARCH_UNTIL_DEFAULT_MS` (1500ms) of polling, so this budgets
 *     that implicit default too rather than leaving it unaccounted for.
 *   - The VoiceOver-detection probe and the final post-gesture observation,
 *     both budgeted via the single consolidated
 *     `TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS` constant (which also
 *     includes the fixed headroom) rather than as separate itemized terms --
 *     see that constant's doc for what it covers.
 *
 * So the floor is `effectivePressDuration + effectiveSearchWindow +
 * nonPressOverhead`. The result is clamped to `MAX_SETTIMEOUT_DELAY_MS`
 * because internal requests are budgeted before schema validation and
 * a large-enough `duration` would otherwise push this past `setTimeout`'s
 * 32-bit ceiling, which Bun/Node
 * silently normalize to 1ms rather than honoring -- timing the request out
 * almost immediately instead of running for the intended duration.
 */
function resolveTapAnyLongPressBudgetMs(request: DaemonRequest): number | undefined {
  if (request.method !== "tools/call" || request.params?.name !== "tapAny") {
    return undefined;
  }
  const argumentsRecord = asRecord(request.params?.arguments);
  if (!argumentsRecord || argumentsRecord.action !== "longPress") {
    return undefined;
  }
  const duration =
    positiveFiniteNumber(argumentsRecord.duration) ?? TAP_ANY_LONG_PRESS_DEFAULT_DURATION_MS;
  return resolveLongPressBudgetMs(
    argumentsRecord,
    duration,
    TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS,
  );
}

/** Shared outer budget arithmetic; admission reserves only the smaller dispatch headroom. */
function resolveLongPressBudgetMs(
  args: Record<string, unknown>,
  durationMs: number,
  nonPressOverheadMs: number,
): number {
  const searchUntilDuration =
    positiveFiniteNumber(asRecord(args.searchUntil)?.duration) ?? TAP_ANY_SEARCH_UNTIL_DEFAULT_MS;
  return Math.min(
    Math.round(durationMs) + Math.round(searchUntilDuration) + nonPressOverheadMs,
    MAX_SETTIMEOUT_DELAY_MS,
  );
}

/** tapOn extends its existing 30 s non-press allowance only for an explicit positive duration. */
function resolveTapOnLongPressBudgetMs(request: DaemonRequest): number | undefined {
  if (request.method !== "tools/call" || request.params?.name !== "tapOn") {
    return undefined;
  }
  const args = asRecord(request.params?.arguments);
  if (args?.action !== "longPress") {
    return undefined;
  }
  const duration = positiveFiniteNumber(args.duration);
  return duration === undefined
    ? undefined
    : resolveLongPressBudgetMs(args, duration, DEFAULT_MCP_REQUEST_TIMEOUT_MS);
}

/**
 * Floor for a `tapAny` ordinary `tap`/`doubleTap` (i.e. any call that is NOT
 * `action: "longPress"`, including an omitted `action`, which the schema
 * defaults to `"tap"`). Mirrors `resolveTapAnyLongPressBudgetMs` above: the
 * outer MCP deadline must cover every phase of the call, not just the
 * gesture itself (issue #6276, follow-up to #6248 review thread funaf) --
 * `TapAnyElement.executeIosTapWithCoordinates` previously passed
 * `timeoutMs: undefined` for ordinary tap/doubleTap, leaving the daemon's
 * outer deadline to fall through to the generic `DEFAULT_MCP_REQUEST_TIMEOUT_MS`
 * (30s) with no tapAny-specific floor tailored to the call's real worst case.
 *
 * So the floor is `gestureWorstCase + effectiveSearchWindow +
 * nonPressOverhead`, the same shape `resolveTapAnyLongPressBudgetMs` uses --
 * `TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS` is action-agnostic (every tapAny
 * action runs the same pre/post-action observation pipeline), so it applies
 * here unchanged. Clamped to `MAX_SETTIMEOUT_DELAY_MS` for the same reason as
 * the longPress floor, even though the fixed inputs here can never actually
 * reach that ceiling -- kept for structural symmetry with the longPress
 * resolver and to stay correct if a future change makes any term variable.
 */
function resolveTapAnyOrdinaryTapBudgetMs(request: DaemonRequest): number | undefined {
  if (request.method !== "tools/call" || request.params?.name !== "tapAny") {
    return undefined;
  }
  const argumentsRecord = asRecord(request.params?.arguments);
  if (argumentsRecord?.action === "longPress") {
    return undefined;
  }
  const searchUntilDuration =
    positiveFiniteNumber(asRecord(argumentsRecord?.searchUntil)?.duration) ??
    TAP_ANY_SEARCH_UNTIL_DEFAULT_MS;
  const budget =
    TAP_ANY_ORDINARY_TAP_GESTURE_WORST_CASE_MS +
    Math.round(searchUntilDuration) +
    TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS;
  return Math.min(budget, MAX_SETTIMEOUT_DELAY_MS);
}

/** Platform is unavailable here: budget iOS conservatively, only raising existing floors. */
function resolveTextToolBudgetMs(
  request: DaemonRequest,
  existingFloorMs = DEFAULT_MCP_REQUEST_TIMEOUT_MS,
): number {
  if (request.method !== "tools/call") {
    return 0;
  }
  const args = asRecord(request.params?.arguments);
  const entries =
    request.params?.name === "sendKeys"
      ? args?.commands
      : request.params?.name === "setUIState"
        ? args?.fields
        : undefined;
  if (!Array.isArray(entries)) {
    return 0;
  }
  const timeouts = entries.map((entry: unknown) => {
    const record = asRecord(entry);
    const text =
      request.params?.name === "sendKeys"
        ? record?.action === "type"
          ? record.text
          : undefined
        : record?.value;
    return typeof text === "string" ? resolveTextCtrlProxyTimeoutMs(text) : 0;
  });
  const excessMs = timeouts.reduce(
    (budget, timeout) => budget + Math.max(0, timeout - DEFAULT_TEXT_REQUEST_TIMEOUT_MS),
    0,
  );
  // Keep compatibility for short text, including caller-supplied request budgets.
  if (excessMs === 0) {
    return 0;
  }
  return Math.min(
    MAX_CALLER_MCP_REQUEST_TIMEOUT_MS,
    existingFloorMs + excessMs + TEXT_MCP_REQUEST_HEADROOM_MS,
  );
}

/**
 * The budget one plan step asks for, from the SAME resolution a standalone call gets: the
 * argument-driven wait budget for tools that have one (`observe` waitFor, `barrier`,
 * `criticalSection`, `explore`, `deviceSnapshot`, the file-push tools), otherwise the tool's own
 * fixed floor, device-preparation budget or long-press budget (`installApp`, `launchApp`, ...).
 * The generic 30 s default and `observe`'s cold-start floor are deliberately NOT counted: they
 * are deadlines for ordinary calls, not waits the plan asks for, and counting them per step would
 * stretch every plain plan to the global cap. Steps with no known budget contribute 0; the
 * `executePlan` floor remains their safety net. A nested `executePlan` is not a plan step.
 */
function resolvePlanStepBudgetMs(tool: string, params: Record<string, unknown>): number {
  if (tool === "executePlan") {
    return 0;
  }
  const argumentResolver = ARGUMENT_BUDGET_RESOLVERS.get(tool);
  if (argumentResolver) {
    return argumentResolver(params);
  }
  const request: DaemonRequest = {
    id: "plan-step",
    type: "mcp_request",
    method: "tools/call",
    params: { name: tool, arguments: params },
  };
  return Math.max(
    resolveToolTimeoutFloorMs(tool) ?? 0,
    resolveDevicePreparationToolBudgetMs(request) ?? 0,
    resolveTapOnLongPressBudgetMs(request) ?? 0,
    resolveTapAnyLongPressBudgetMs(request) ?? 0,
  );
}

interface PlanBudgetAccumulator {
  /** Summed step budgets per execution track; sequential plans use the single "" track. */
  readonly tracks: Map<string, number>;
  stepsLeft: number;
  /** A bound was hit, so the budget is unknown rather than small. */
  saturated: boolean;
}

function addPlanStepBudgets(
  steps: unknown,
  multiDevice: boolean,
  parentTrack: string | undefined,
  accumulator: PlanBudgetAccumulator,
  depth: number,
): void {
  if (!Array.isArray(steps)) {
    return;
  }
  if (depth > MAX_EXECUTE_PLAN_BUDGET_DEPTH) {
    accumulator.saturated = true;
    return;
  }
  // Iterate the array, not an index range, but still stop at the visit bound: a
  // sparse/huge array must cost O(bound), not O(length).
  for (const raw of steps) {
    if (accumulator.stepsLeft <= 0) {
      accumulator.saturated = true;
      return;
    }
    accumulator.stepsLeft -= 1;
    const step = PlanNormalizer.toolAndParams(raw);
    if (!step) {
      continue;
    }
    // Multi-device plans run one parallel track per `params.device`; sub-steps of a
    // criticalSection run serially on the section owner's device, so they stay on its track.
    const track =
      parentTrack ??
      (multiDevice && typeof step.params.device === "string" ? step.params.device : "");
    accumulator.tracks.set(
      track,
      (accumulator.tracks.get(track) ?? 0) + resolvePlanStepBudgetMs(step.tool, step.params),
    );
    if (step.tool === "criticalSection") {
      addPlanStepBudgets(step.params.steps, multiDevice, track, accumulator, depth + 1);
    }
  }
}

function parsePlanContentForBudget(planContent: string): Record<string, unknown> | undefined {
  try {
    return asRecord(yaml.load(planContent, PLAN_YAML_LOAD_OPTIONS));
  } catch (error) {
    // Invalid YAML is surfaced by executePlan itself as a structured error; the request
    // deadline just falls back to the floor.
    logger.debug(`executePlan budget: plan content is not parseable YAML: ${errorMessage(error)}`);
    return undefined;
  }
}

/**
 * Deadline an `executePlan` call needs for its steps, or 0 when it cannot be derived. Steps run
 * under the plan's inherited signal with no per-step transport deadline, so a plan whose steps
 * ask for long waits must be budgeted as a whole (#9882). Sequential steps SUM; the per-device
 * tracks of a multi-device plan run in parallel, so the longest track's sum applies (this does
 * not model barrier synchronization, where a track also waits for the slowest peer). Pure and
 * bounded: it never throws, and a plan too large to walk saturates at the global cap, where such
 * a plan can still hit the transport timeout.
 */
function resolveExecutePlanStepsBudgetMs(planContent: unknown): number {
  if (typeof planContent !== "string") {
    return 0;
  }
  if (planContent.length > MAX_EXECUTE_PLAN_BUDGET_CONTENT_CHARS) {
    return MAX_CALLER_MCP_REQUEST_TIMEOUT_MS;
  }
  const plan = parsePlanContentForBudget(planContent);
  if (!plan) {
    return 0;
  }
  const accumulator: PlanBudgetAccumulator = {
    tracks: new Map(),
    stepsLeft: MAX_EXECUTE_PLAN_BUDGET_STEPS,
    saturated: false,
  };
  const multiDevice = Array.isArray(plan.devices) && plan.devices.length > 0;
  addPlanStepBudgets(plan.steps, multiDevice, undefined, accumulator, 0);
  if (accumulator.saturated) {
    return MAX_CALLER_MCP_REQUEST_TIMEOUT_MS;
  }
  const longestTrackMs = [...accumulator.tracks.values()].reduce(
    (longest, track) => Math.max(longest, track),
    0,
  );
  return Math.min(
    longestTrackMs + EXECUTE_PLAN_BUDGET_HEADROOM_MS,
    MAX_CALLER_MCP_REQUEST_TIMEOUT_MS,
    MAX_SETTIMEOUT_DELAY_MS,
  );
}

function resolveExecutePlanBudgetMs(request: DaemonRequest): number {
  if (request.method !== "tools/call" || request.params?.name !== "executePlan") {
    return 0;
  }
  return resolveExecutePlanStepsBudgetMs(asRecord(request.params?.arguments)?.planContent);
}

export function resolveMcpRequestTimeoutMs(request: DaemonRequest): number {
  const base = clampCallerMcpRequestTimeoutMs(request.timeoutMs) ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS;
  const floor =
    request.method === "tools/call" ? resolveToolTimeoutFloorMs(request.params?.name) : undefined;
  const devicePreparationBudget = resolveDevicePreparationToolBudgetMs(request);
  const tapOnLongPressBudget = resolveTapOnLongPressBudgetMs(request);
  const tapAnyLongPressBudget = resolveTapAnyLongPressBudgetMs(request);
  const tapAnyOrdinaryTapBudget = resolveTapAnyOrdinaryTapBudgetMs(request);
  return Math.max(
    base,
    resolveArgumentBudgetToolBudgetMs(request),
    resolveExecutePlanBudgetMs(request),
    resolveTextToolBudgetMs(request, floor),
    floor ?? 0,
    devicePreparationBudget ?? 0,
    tapOnLongPressBudget ?? 0,
    tapAnyLongPressBudget ?? 0,
    tapAnyOrdinaryTapBudget ?? 0,
  );
}

/**
 * Hard ceiling on how far a progress-emitting request's deadline can be
 * pushed out by its own progress notifications (issue #6222 review, P1). A
 * multi-field `setUIState` (or any other progress-emitting tool) that applies
 * work successfully but keeps progressing past the tool's normal deadline
 * must not time out mid-flight and strand the client unable to tell success
 * from failure -- but a genuinely hung tool that STOPS progressing must still
 * be killed, not run forever. Chosen to comfortably cover a large multi-field
 * form (each field costs at most a handful of seconds of real device work)
 * while staying well short of "effectively unbounded".
 */
export const MAX_PROGRESS_EXTENDED_MCP_REQUEST_TIMEOUT_MS = 300_000;

/**
 * A per-request deadline that a progress notification can push forward, up to
 * a fixed ceiling measured from when the request was first received. Nothing
 * in this class evaluates progress itself -- callers extend the deadline only
 * when they actually observe a progress notification for this request, so a
 * tool that emits none never has its deadline touched and keeps its exact
 * original timeout (issue #6222 review, P1: `resetTimeoutOnProgress` for the
 * daemon's own request-deadline bookkeeping, mirroring the MCP SDK option of
 * the same name used for the inner MCP client call).
 *
 * Deliberately timer-agnostic: every method takes the caller's own `nowMs`
 * (from whatever `Timer` it holds) rather than reading a clock itself, so
 * this composes with the existing `FakeTimer` seams used throughout the
 * daemon and its tests.
 */
export class ProgressExtendableDeadline {
  private currentMs: number;
  private readonly ceilingMs: number;
  private readonly extensionListeners = new Set<() => void>();

  constructor(
    receivedAtMs: number,
    initialTimeoutMs: number,
    maxTotalTimeoutMs: number = MAX_PROGRESS_EXTENDED_MCP_REQUEST_TIMEOUT_MS,
  ) {
    this.currentMs = receivedAtMs + initialTimeoutMs;
    // A tool floor already larger than the default progress ceiling (e.g.
    // executePlan's 10-minute floor) keeps its own, larger ceiling -- the
    // progress ceiling only ever extends a request, never shortens one.
    this.ceilingMs = receivedAtMs + Math.max(initialTimeoutMs, maxTotalTimeoutMs);
  }

  /** Current absolute deadline, in the same clock the constructor's `receivedAtMs` came from. */
  get value(): number {
    return this.currentMs;
  }

  /** Absolute hard ceiling this deadline can never be pushed past. */
  get ceiling(): number {
    return this.ceilingMs;
  }

  /**
   * Push the deadline forward to `nowMs + extensionMs`, capped at the hard
   * ceiling. A proposal at or behind the current deadline is a no-op --
   * progress only ever extends a deadline, never shortens it.
   */
  extendOnProgress(nowMs: number, extensionMs: number): void {
    const proposed = Math.min(nowMs + extensionMs, this.ceilingMs);
    if (proposed <= this.currentMs) {
      return;
    }
    this.currentMs = proposed;
    // Snapshot so a listener that unsubscribes itself mid-notify is safe.
    for (const listener of [...this.extensionListeners]) {
      listener();
    }
  }

  /**
   * Subscribe to extensions: `listener` runs synchronously each time
   * `extendOnProgress` actually moves the deadline forward (never on a
   * no-op proposal). Lets a consumer holding a timer armed against an
   * earlier `value` re-arm the moment the extension lands, rather than only
   * when it next happens to re-read (issue #6283). Returns an unsubscribe
   * function that is safe to call more than once.
   */
  onExtended(listener: () => void): () => void {
    this.extensionListeners.add(listener);
    return () => {
      this.extensionListeners.delete(listener);
    };
  }
}
