/** Adapt hierarchy and observation helpers for notification listing. */

import { BootedDevice, ViewHierarchyNode } from "../../../models";
import type { ProgressCallback } from "../../action/BaseVisualChange";
import {
  type TrayNotificationListContext,
  listSystemTrayNotifications as listNotifications,
  readActiveNotificationKeysForApp as readActiveKeys,
  readTrayNotificationFields as readNotificationFields,
} from "../systemTrayNotificationList";
import { getSystemTrayDependencies } from "./dependencies";
import {
  collectNotificationCandidates,
  createSubHierarchy,
  extractNodeTextCandidates,
  findHeaderAppLabel,
  getNotificationGroupHeader,
} from "./hierarchy";
import { observeSystemTray, waitForSystemTrayOpen } from "./runtime";

const trayListingContext: TrayNotificationListContext = {
  collectNotificationCandidates,
  createSubHierarchy,
  extractNodeTextCandidates,
  getNotificationGroupHeader,
  findHeaderAppLabel,
  observeSystemTray,
  waitForSystemTrayOpen,
  getSystemTrayDependencies,
};

export const readTrayNotificationFields = (node: ViewHierarchyNode) =>
  readNotificationFields(node, trayListingContext);

export const listSystemTrayNotifications = (
  device: BootedDevice,
  appId: string,
  appLabel: string | null,
  awaitTimeoutMs: number,
  _progress?: ProgressCallback,
  signal?: AbortSignal,
) => listNotifications({ device, appId, appLabel, awaitTimeoutMs, signal }, trayListingContext);

/**
 * The pass clearAll takes before swiping: it ends with the shade collapsed and no read of it,
 * since the drain opens and reads the shade itself.
 */
export const listSystemTrayNotificationsForClear = (
  device: BootedDevice,
  appId: string,
  appLabel: string | null,
  awaitTimeoutMs: number,
  signal?: AbortSignal,
) =>
  listNotifications(
    { device, appId, appLabel, awaitTimeoutMs, signal, skipTerminalObservation: true },
    trayListingContext,
  );

export const readActiveNotificationKeysForApp = (
  device: BootedDevice,
  appId: string,
  signal?: AbortSignal,
): Promise<string[] | undefined> =>
  readActiveKeys(getSystemTrayDependencies().adbFactory(device), appId, signal);
