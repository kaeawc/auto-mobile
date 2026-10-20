import { BootedDevice, ViewHierarchyResult } from "../../models";
import { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { ViewHierarchy } from "../observe/ViewHierarchy";

/** Injected chooser label and fresh-hierarchy lookups used by paging and fallback matching. */
export interface ChooserAppMetadata {
  getLabel(device: BootedDevice, packageName: string, signal?: AbortSignal): Promise<string | null>;
  getActivityLabel?(
    device: BootedDevice,
    packageName: string,
    url: string,
    adb: AdbExecutor,
    signal?: AbortSignal,
  ): Promise<ChooserActivityLabelResult>;
  getFreshHierarchy(
    device: BootedDevice,
    adbFactory: AdbClientFactory,
    minTimestamp: number,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ViewHierarchyResult>;
}

export type ChooserActivityLabelResult =
  | { kind: "literal"; label: string }
  | { kind: "resource" }
  | { kind: "none" };

function parseDumpLabel(fields: RegExpExecArray | null): ChooserActivityLabelResult {
  const labelRes = fields?.[1];
  const literal = fields?.[2]?.trim();
  if (literal !== undefined && literal !== "null") {
    return { kind: "literal", label: literal };
  }
  return labelRes && !/^(?:0x0+|0+)$/i.test(labelRes) ? { kind: "resource" } : { kind: "none" };
}

/** ADB can read literal activity labels, but cannot dereference labelRes. */
export async function resolveChooserActivityLabel(
  adb: AdbExecutor,
  packageName: string,
  url: string,
  signal?: AbortSignal,
): Promise<ChooserActivityLabelResult> {
  // Match OpenURL's VIEW action and data; adding a category would change the
  // query from the intent that `am start -a VIEW -d <url>` actually launched.
  try {
    throwIfAborted(signal);
    const query = await awaitWhileRequestIsLive(
      adb.executeCommand(
        `shell cmd package query-activities -a android.intent.action.VIEW -d ${shellQuote(url)}`,
        { signal },
      ),
      signal,
    );
    if (query.stderr.trim()) {
      return { kind: "none" };
    }
    const activities = query.stdout
      .split(/^  Activity #\d+:\s*$/m)
      .slice(1)
      .map(parseQueryActivity)
      .filter((activity) => activity?.packageName === packageName);
    // Several matching activities can carry different labels. Without the
    // resolver's chosen component, claiming one would risk selecting a peer row.
    if (activities.length !== 1) {
      return { kind: "none" };
    }
    return activities[0]?.label ?? { kind: "none" };
  } catch (error) {
    throwIfAborted(signal);
    // This optional ADB enrichment can be absent on older devices; use the
    // existing application-label lookup when the shell query is unavailable.
    logger.debug(`[DeepLinkManager] Activity-label probe unavailable: ${errorMessage(error)}`);
    return { kind: "none" };
  }
}

export const defaultChooserAppMetadata: ChooserAppMetadata = {
  async getLabel(device, packageName, signal) {
    const { resolveAppLabel } = await import("../systemTray/systemTrayHelpers");
    throwIfAborted(signal);
    return resolveAppLabel(device, packageName, signal);
  },
  async getActivityLabel(_device, packageName, url, adb, signal) {
    return resolveChooserActivityLabel(adb, packageName, url, signal);
  },
  async getFreshHierarchy(device, adbFactory, minTimestamp, timeoutMs, signal) {
    return new ViewHierarchy(device, adbFactory).getViewHierarchy(undefined, {
      skipWaitForFresh: true,
      minTimestamp,
      signal,
      timeoutMs: timeoutMs,
    });
  },
};

function parseQueryActivity(
  block: string,
): { packageName: string; label: ChooserActivityLabelResult } | null {
  const activityInfo = /^    ActivityInfo:\s*$/m.exec(block);
  if (!activityInfo) {
    return null;
  }
  const resolveInfoFields = block.slice(0, activityInfo.index);
  const resolveInfoLabel = parseDumpLabel(
    /^    labelRes=(\S+)\s+nonLocalizedLabel=(.*?)(?:\s+(?:icon|banner)=|$)/m.exec(
      resolveInfoFields,
    ),
  );
  // ApplicationInfo is nested in ActivityInfo's dump but describes the app,
  // not this intent-resolving activity. Its label must never stand in for one.
  const fields = block
    .slice(activityInfo.index + activityInfo[0].length)
    .split(/^      ApplicationInfo:\s*$/m, 1)[0];
  const name = /^      name=(\S+)\s*$/m.exec(fields)?.[1];
  const packageName = /^      packageName=(\S+)\s*$/m.exec(fields)?.[1];
  if (!name || !packageName) {
    return null;
  }
  const activityLabel = parseDumpLabel(
    /^      labelRes=(\S+)\s+nonLocalizedLabel=(.*?)(?:\s+(?:icon|banner)=|$)/m.exec(fields),
  );
  const label = resolveInfoLabel.kind !== "none" ? resolveInfoLabel : activityLabel;
  return { packageName, label };
}
