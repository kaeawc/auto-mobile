import { DaemonState } from "../daemon/daemonState";
import { releaseSessionAndDevice } from "../daemon/releaseSessionAndDevice";
import { ActionableError } from "../models";
import { createToolExecutionContext } from "./ToolExecutionContext";
import type { SessionOptions } from "./ToolExecutionContext";
import {
  PLAN_AUTO_RELEASE_REASON,
  type DeviceLabelMap,
  type SessionExecutionMetadata,
} from "../daemon/sessionManager";
import { logger } from "../utils/logger";
import { combineAbortSignals } from "../utils/AbortContext";

const buildDeviceLabelList = (labels: string[]): string[] => {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const label of labels) {
    if (typeof label !== "string") {
      continue;
    }
    const trimmed = label.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
};

export const buildDeviceLabelMap = (
  labels: string[],
  baseSessionUuid: string,
  primaryLabel?: string,
): DeviceLabelMap => {
  const uniqueLabels = buildDeviceLabelList(labels);
  if (uniqueLabels.length === 0) {
    return {};
  }

  const resolvedPrimaryLabel =
    primaryLabel && uniqueLabels.includes(primaryLabel)
      ? primaryLabel
      : uniqueLabels.includes("A")
        ? "A"
        : uniqueLabels[0];

  const map: DeviceLabelMap = {};
  for (const label of uniqueLabels) {
    map[label] = label === resolvedPrimaryLabel ? baseSessionUuid : `${baseSessionUuid}:${label}`;
  }

  return map;
};

export const getDeviceLabelMap = (baseSessionUuid: string): DeviceLabelMap | null => {
  if (!DaemonState.getInstance().isInitialized()) {
    return null;
  }

  const sessionManager = DaemonState.getInstance().getSessionManager();
  return sessionManager.getDeviceLabels(baseSessionUuid) ?? null;
};

/**
 * Whether a plan's label map gives it sessions other than its base. `buildDeviceLabelMap` maps the
 * primary label to the base itself, so a single-label plan (`devices: [A]`) has none: its only
 * session is the caller's own (#11091).
 */
export const labelMapHasDerivedSessions = (
  map: DeviceLabelMap | null | undefined,
  baseSessionUuid: string,
): boolean => Object.values(map ?? {}).some((sessionUuid) => sessionUuid !== baseSessionUuid);

/**
 * Whether a failed executePlan that asked to hold its session (`holdSessionOnFailure`) keeps it for
 * the caller's recovery (#10834). A plan whose label map has derived sessions is always released:
 * those sessions have no caller-side owner. The executePlan result reports this decision as
 * `sessionHeld` and the plan lifecycle acts on it, so both read this one predicate.
 */
export const failedPlanSessionHoldable = (baseSessionUuid: string): boolean =>
  !labelMapHasDerivedSessions(getDeviceLabelMap(baseSessionUuid), baseSessionUuid);

/**
 * The base session the plan lifecycle releases for an executePlan: the registry hands handlers the
 * resolved label session as `sessionUuid`, while the lifecycle decides from the caller's base
 * (`baseSessionUuid ?? sessionUuid`). A derived label session maps back to its base so the
 * reported `sessionHeld` comes from the same id as the release (#11111).
 */
export const planLifecycleSessionUuid = (sessionUuid: string): string =>
  (DaemonState.getInstance().isInitialized()
    ? DaemonState.getInstance().getSessionManager().getBaseSessionOfDerivedLabel(sessionUuid)
    : undefined) ?? sessionUuid;

/**
 * No general pool/boot parallel-start limit exists in devicePool.ts. Its
 * assignmentMutex serializes assignment, preventing two labels from receiving
 * the same device, before this readiness setup runs. This bound only caps
 * concurrent CtrlProxy/accessibility-service readiness bring-up.
 */
export const MAX_CONCURRENT_LABEL_SESSION_SETUPS = 4;

export const setUpLabelSessionsConcurrently = async (options: {
  sessionUuids: readonly string[];
  setup: (sessionUuid: string, signal: AbortSignal | undefined) => Promise<unknown>;
  signal?: AbortSignal;
  maxConcurrency?: number;
}): Promise<void> => {
  const {
    sessionUuids,
    setup,
    signal,
    maxConcurrency = MAX_CONCURRENT_LABEL_SESSION_SETUPS,
  } = options;
  if (sessionUuids.length === 0) {
    return;
  }
  signal?.throwIfAborted();
  if (sessionUuids.length === 1) {
    await setup(sessionUuids[0], signal);
    return;
  }
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new RangeError("maxConcurrency must be a positive integer");
  }

  const controller = new AbortController();
  const siblingAbortReason = new DOMException(
    "Another label's readiness setup failed",
    "AbortError",
  );
  const setupSignal = combineAbortSignals(signal, controller.signal);
  const failures: Array<{ error: unknown } | undefined> = [];
  let nextIndex = 0;

  const isSiblingAbort = (error: unknown): boolean => {
    if (!controller.signal.aborted || signal?.aborted) {
      return false;
    }
    return (
      error === siblingAbortReason ||
      (typeof error === "object" &&
        error !== null &&
        (("name" in error && error.name === "AbortError") ||
          ("code" in error && error.code === "ABORT_ERR")))
    );
  };

  const runSetup = async (index: number): Promise<void> => {
    try {
      await setup(sessionUuids[index], setupSignal);
    } catch (error) {
      // A prior genuine failure cancels siblings. Ignore only our own abort
      // reason/abort-shaped fallout while the caller has not cancelled, so a
      // lower-index sibling cancellation cannot replace the real cause.
      if (isSiblingAbort(error)) {
        logger.debug("[DeviceLabelMap] Sibling readiness setup cancelled", { error });
        return;
      }
      logger.warn("[DeviceLabelMap] Label readiness setup failed", {
        sessionUuid: sessionUuids[index],
        error,
      });
      failures[index] = { error };
      controller.abort(siblingAbortReason);
    }
  };

  const worker = async (): Promise<void> => {
    while (nextIndex < sessionUuids.length && !setupSignal?.aborted) {
      const index = nextIndex++;
      await runSetup(index);
    }
  };

  // Drain every started setup before returning or throwing. Sessions remain
  // owned by the published map; releaseDeviceLabelSessions/expiry releases them.
  await Promise.all(Array.from({ length: Math.min(maxConcurrency, sessionUuids.length) }, worker));
  const failure = failures.find((entry) => entry !== undefined);
  if (failure) {
    throw failure.error;
  }
  signal?.throwIfAborted();
};

export const registerDeviceLabelMap = async (
  baseSessionUuid: string,
  labels: string[],
  primaryLabel?: string,
  sessionOptions: SessionOptions = {},
  execution?: SessionExecutionMetadata,
  signal?: AbortSignal,
): Promise<DeviceLabelMap> => {
  if (!DaemonState.getInstance().isInitialized()) {
    throw new ActionableError("Device labels require an active daemon session.");
  }

  const devicePool = DaemonState.getInstance().getDevicePool();
  const sessionManager = DaemonState.getInstance().getSessionManager();
  const deviceLabelMap = buildDeviceLabelMap(labels, baseSessionUuid, primaryLabel);

  if (Object.keys(deviceLabelMap).length === 0) {
    return deviceLabelMap;
  }

  // Publish the base-to-derived relationship before the first setup await. The
  // expiry checker uses it to keep every labeled session alive for the active
  // base-plan execution while allocation/setup crosses an idle deadline.
  sessionManager.setDeviceLabels(baseSessionUuid, deviceLabelMap);
  await createToolExecutionContext(
    baseSessionUuid,
    sessionManager,
    devicePool,
    sessionOptions,
    execution,
    undefined,
    false,
    signal,
  );

  const assignedSessions = new Set(Object.values(deviceLabelMap));
  assignedSessions.delete(baseSessionUuid);

  await setUpLabelSessionsConcurrently({
    sessionUuids: [...assignedSessions],
    signal,
    setup: (sessionUuid, setupSignal) =>
      createToolExecutionContext(
        sessionUuid,
        sessionManager,
        devicePool,
        sessionOptions,
        execution,
        undefined,
        false,
        setupSignal,
      ),
  });

  logger.info(
    `[DeviceLabelMap] Registered labels for session ${baseSessionUuid}: ${Object.keys(deviceLabelMap).join(", ")}`,
  );
  return deviceLabelMap;
};

export const releaseDeviceLabelSessions = async (baseSessionUuid: string): Promise<string[]> => {
  if (!DaemonState.getInstance().isInitialized()) {
    return [];
  }

  const map = getDeviceLabelMap(baseSessionUuid);
  if (!map) {
    return [];
  }

  const devicePool = DaemonState.getInstance().getDevicePool();
  const sessionManager = DaemonState.getInstance().getSessionManager();
  const sessions = new Set(Object.values(map));
  const released: string[] = [];

  sessions.delete(baseSessionUuid);

  for (const sessionUuid of sessions) {
    const session = sessionManager.getSession(sessionUuid);
    if (!session) {
      continue;
    }
    const deviceId = session.assignedDevice;
    try {
      // Await the release so its central onSessionRelease cleanup (CtrlProxy binding +
      // build-context/detector) completes BEFORE the device is returned to the pool and
      // possibly reassigned — otherwise hierarchy/nav broadcasts during the release get
      // recorded under the ended session's uuid. Mirrors the base-session path (#4984).
      await releaseSessionAndDevice(
        sessionManager,
        devicePool,
        deviceId,
        sessionUuid,
        PLAN_AUTO_RELEASE_REASON,
      );
    } catch (error) {
      // Each label session is released on its own: one failed release must not leave the
      // remaining sessions holding their devices (#11091). releaseSessionAndDevice already
      // freed the device when the session was removed before the rejection.
      logger.warn(
        `[DeviceLabelMap] Failed to release label session ${sessionUuid} on ${deviceId} for base ${baseSessionUuid}`,
        error,
      );
      if (sessionManager.hasSession(sessionUuid)) {
        continue;
      }
    }
    released.push(sessionUuid);
  }

  if (released.length > 0) {
    logger.info(
      `[DeviceLabelMap] Released label sessions for base ${baseSessionUuid}: ${released.join(", ")}`,
    );
  }

  return released;
};
