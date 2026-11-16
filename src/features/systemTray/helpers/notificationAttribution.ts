/** Refresh the synchronous matching evidence once for the observation being examined. */
import type { BootedDevice, ViewHierarchyResult } from "../../../models";
import { awaitWhileRequestIsLive } from "../../../utils/toolUtils";
import { readDumpsysNotificationRecords } from "../systemTrayNotificationList";
import type { SystemTrayNotificationArgs } from "../systemTrayTypes";
import { getSystemTrayDependencies } from "./dependencies";
import {
  collectNotificationAttributions,
  collectNotificationCandidates,
  getNotificationGroupHeader,
  nodeHasIosShortLook,
} from "./hierarchy";

export const refreshNotificationDumpsys = async (
  device: BootedDevice,
  hierarchy: ViewHierarchyResult | undefined,
  criteria: SystemTrayNotificationArgs,
  signal?: AbortSignal,
): Promise<void> => {
  if (device.platform !== "android" || !criteria.appId) {
    return;
  }
  // Replace the previous observation's provider even when this read needs no dump.
  // A later header-less row must never inherit stale ownership evidence.
  criteria.dumpsysRecords = () => undefined;
  const needsEvidence =
    hierarchy &&
    collectNotificationCandidates(hierarchy).some(
      ({ node, groupNode }) =>
        !nodeHasIosShortLook(node) &&
        collectNotificationAttributions(node).length === 0 &&
        collectNotificationAttributions(groupNode ? getNotificationGroupHeader(groupNode) : null)
          .length === 0,
    );
  if (!needsEvidence) {
    return;
  }
  const records = await awaitWhileRequestIsLive(
    readDumpsysNotificationRecords(getSystemTrayDependencies().adbFactory(device), signal),
    signal,
  );
  criteria.dumpsysRecords = () => records;
};
