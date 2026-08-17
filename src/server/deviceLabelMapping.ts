import { DaemonState } from "../daemon/daemonState";
import { ActionableError } from "../models";
import { createToolExecutionContext } from "./ToolExecutionContext";
import type { SessionOptions } from "./ToolExecutionContext";
import type { DeviceLabelMap, SessionExecutionMetadata } from "../daemon/sessionManager";
import { logger } from "../utils/logger";

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
  primaryLabel?: string
): DeviceLabelMap => {
  const uniqueLabels = buildDeviceLabelList(labels);
  if (uniqueLabels.length === 0) {
    return {};
  }

  const resolvedPrimaryLabel =
    (primaryLabel && uniqueLabels.includes(primaryLabel))
      ? primaryLabel
      : (uniqueLabels.includes("A") ? "A" : uniqueLabels[0]);

  const map: DeviceLabelMap = {};
  for (const label of uniqueLabels) {
    map[label] = label === resolvedPrimaryLabel
      ? baseSessionUuid
      : `${baseSessionUuid}:${label}`;
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

export const registerDeviceLabelMap = async (
  baseSessionUuid: string,
  labels: string[],
  primaryLabel?: string,
  sessionOptions: SessionOptions = {},
  execution?: SessionExecutionMetadata,
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
  await createToolExecutionContext(baseSessionUuid, sessionManager, devicePool, sessionOptions, execution);

  const assignedSessions = new Set(Object.values(deviceLabelMap));
  assignedSessions.delete(baseSessionUuid);

  for (const sessionUuid of assignedSessions) {
    await createToolExecutionContext(sessionUuid, sessionManager, devicePool, sessionOptions, execution);
  }

  logger.info(`[DeviceLabelMap] Registered labels for session ${baseSessionUuid}: ${Object.keys(deviceLabelMap).join(", ")}`);
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
    // Await the release so its central onSessionRelease cleanup (CtrlProxy binding +
    // build-context/detector) completes BEFORE the device is returned to the pool and
    // possibly reassigned — otherwise hierarchy/nav broadcasts during the release get
    // recorded under the ended session's uuid. Mirrors the base-session path (#4984).
    await sessionManager.releaseSession(sessionUuid);
    await devicePool.releaseDevice(deviceId, sessionUuid);
    released.push(sessionUuid);
  }

  if (released.length > 0) {
    logger.info(`[DeviceLabelMap] Released label sessions for base ${baseSessionUuid}: ${released.join(", ")}`);
  }

  return released;
};
