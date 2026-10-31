import { TransientPreSwipeError } from "./TransientPreSwipeError";
import {
  NOTIFICATION_TITLE_FIELD_IDS,
  SYSTEM_TRAY_SCROLL_IDLE_POLL_MS,
  SYSTEM_TRAY_SCROLL_IDLE_TIMEOUT_MS,
  SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS,
} from "./notificationHints";
import type { NotificationUIDetector } from "../../utils/interfaces/NotificationUIDetector";
import type { SystemTrayAdb } from "./systemTrayHelpers";
import type * as TrayHelpers from "./systemTrayHelpers";

import { DUMPSYS_MAX_BUFFER } from "../../utils/android-cmdline-tools/dumpsysLimits";

import { notificationResourceId } from "./notificationHints";

import { waitForScrollIdle } from "../../utils/scrollIdle";

import {
  ActionableError,
  BootedDevice,
  Element,
  ObserveResult,
  ViewHierarchyResult,
  ViewHierarchyNode,
  isTruthy,
} from "../../models";

import { createNotificationUIDetector } from "./createNotificationUIDetector";

import {
  attributeRowByDumpsys,
  intersectDumpsysRecordsForRow,
  parseActiveNotificationKeysForApp,
  parseDumpsysNotificationRecords,
  type DumpsysNotificationRecord,
} from "./notificationDumpsys";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  matchesNotificationResourceId,
  getHierarchyRoots,
  getNodeProperties,
  traverseForHint,
} from "./notificationHints";

import { logger } from "../../utils/logger";

/** Which evidence class attributed a listed row to its app (#6875). */
export type TrayOwnershipEvidence = "header" | "dumpsys";

export interface ListedTrayNotification {
  id: string | null;
  appId: string;
  appLabel: string | null;
  title: string | null;
  body: string | null;
  actions: string[];
  texts: string[];
  inGroup: boolean;
  ownership: TrayOwnershipEvidence;
}

const ACTION_FIELD_IDS = ["action0", "action1", "action2", "action_text"];

// Chrome SystemUI renders around the posted content: action buttons (and their
// container) plus the row's own expand/dismiss/feedback controls. Their labels
// come from the framework or from a `Notification.Action`, never from the
// extras `dumpsys` correlates against, so counting them as correlation content
// only lets an unrelated app whose title happens to read "Reply" make a
// header-less row look ambiguous (#6875).
const NON_CONTENT_ROW_IDS = new Set([
  ...ACTION_FIELD_IDS,
  "actions",
  "action_list_margin_target",
  "smart_reply_container",
  "expand_button",
  "expand_button_touch_container",
  "feedback",
  "close_button",
  "snooze_button",
  // Timer chrome: SystemUI renders the running chronometer value and the post
  // timestamp itself, so neither appears in the extras `dumpsys` correlates
  // against, and the chronometer's value changes between observations.
  "chronometer",
  "time",
  "time_divider",
]);

// Chrome is inherited: everything below an action container or a row control
// is chrome too.
const isRowContent = (parentIsContent: boolean, id: string): boolean =>
  parentIsContent && !NON_CONTENT_ROW_IDS.has(id);

// Read semantic Android notification fields, preserving custom-layout text as a
// fallback. A group header must not inherit fields from its sibling child rows.
export const readTrayNotificationFields = (
  root: ViewHierarchyNode,
  context: TrayNotificationListContext,
) => {
  const { collectNotificationCandidates, createSubHierarchy, extractNodeTextCandidates } = context;
  const childRows = new Set(
    collectNotificationCandidates(createSubHierarchy(root)).map((candidate) => candidate.node),
  );
  childRows.delete(root);
  const fields: {
    appLabel: string | null;
    title: string | null;
    bodies: string[];
    actions: string[];
    texts: string[];
    contentTexts: string[];
  } = {
    appLabel: null,
    title: null,
    bodies: [],
    actions: [],
    texts: [],
    // `texts` minus SystemUI's own chrome: what the posting app actually
    // supplied, and the only text ownership correlation may rely on.
    contentTexts: [],
  };
  // Chrome labels stay reported, but never become correlation evidence.
  const recordTexts = (candidates: string[], content: boolean): void => {
    fields.texts.push(...candidates);
    if (content) {
      fields.contentTexts.push(...candidates);
    }
  };
  const assignSemanticField = (id: string, text: string): void => {
    if (["app_name_text", "app_name"].includes(id)) {
      fields.appLabel = text;
    }
    if (NOTIFICATION_TITLE_FIELD_IDS.includes(id)) {
      fields.title = text;
    }
    if (["text", "big_text", "text2", "notification_text"].includes(id)) {
      fields.bodies.push(text);
    }
    if (ACTION_FIELD_IDS.includes(id)) {
      fields.actions.push(text);
    }
  };
  // Each MessagingStyle layout is an alternate rendering of the conversation.
  // Preserve repeated message nodes within one layout; select the fullest
  // layout instead of deduplicating message values across compact/expanded UI.
  const messageLayouts: string[][] = [[]];
  const pending = [{ node: root, messages: messageLayouts[0], content: true }];
  while (pending.length) {
    const entry = pending.shift()!;
    const { node } = entry;
    let { messages } = entry;
    const props = getNodeProperties(node);
    if (!props) {
      continue;
    }
    const id = notificationResourceId(node).split("/").pop() ?? "";
    if (childRows.has(node)) {
      continue;
    }
    if (id === "messaging_linear_layout") {
      messages = [];
      messageLayouts.push(messages);
    }
    // `content-desc` (and the iOS accessibility label) routinely carry text the
    // rendered `text` omits, so keep every candidate rather than the first.
    const candidates = extractNodeTextCandidates(node);
    const content = isRowContent(entry.content, id);
    recordTexts(candidates, content);
    const text = candidates[0];
    if (text) {
      assignSemanticField(id, text);
      if (id === "message_text") {
        messages.push(text);
      }
    }
    const children = [node.node]
      .flat()
      .filter((child): child is ViewHierarchyNode => Boolean(child));
    pending.push(...children.map((node: ViewHierarchyNode) => ({ node, messages, content })));
  }
  const messages = messageLayouts.reduce((fullest, layout) =>
    layout.length > fullest.length ? layout : fullest,
  );
  fields.bodies = messages.length ? messages : [...new Set(fields.bodies)];
  return fields;
};

interface TrayObservedRow {
  // An observed row has no attribution yet: ownership is decided per request.
  notification: Omit<ListedTrayNotification, "appId" | "ownership">;
  // The row's app-supplied text, carried beside the reported fields so
  // correlation never sees SystemUI's chrome (#6875).
  correlationTexts: string[];
  // The app-label text rendered under the row's structural notification-header
  // node (distinct from title/body content), used only as fail-closed evidence
  // for content-less custom layouts; null when no structural header node is present.
  headerAppLabel: string | null;
  bounds?: Element["bounds"];
}

const readTrayNotifications = (
  hierarchy: ViewHierarchyResult,
  context: TrayNotificationListContext,
): TrayObservedRow[] => {
  const { collectNotificationCandidates, findHeaderAppLabel, getNotificationGroupHeader } = context;
  const notifications: TrayObservedRow[] = [];
  for (const candidate of collectNotificationCandidates(hierarchy)) {
    const fields = readTrayNotificationFields(candidate.node, context);
    const label =
      fields.appLabel ||
      (candidate.groupNode
        ? readTrayNotificationFields(candidate.groupNode, context).appLabel
        : null);
    const headerAppLabel =
      findHeaderAppLabel(getNotificationGroupHeader(candidate.groupNode ?? candidate.node)) ?? null;
    const nodeId = getNodeProperties(candidate.node)?.["unique-id"];
    notifications.push({
      bounds: candidate.element?.bounds,
      correlationTexts: [...new Set(fields.contentTexts)],
      headerAppLabel,
      notification: {
        id: typeof nodeId === "string" && nodeId.length > 0 ? nodeId : null,
        appLabel: label,
        title: fields.title,
        body: fields.bodies.join("\n") || null,
        actions: [...new Set(fields.actions)],
        texts: [...new Set(fields.texts)],
        inGroup: Boolean(candidate.groupNode),
      },
    });
  }
  return notifications;
};

// Unchanged neighbors can measure the viewport's movement. Their text is only
// an alignment anchor: an updated row need not have equal text to reconcile.
const trayRowAnchor = (row: TrayObservedRow): string => {
  const notification = row.notification;
  return (
    notification.id ??
    JSON.stringify([
      notification.appLabel,
      notification.title,
      notification.body,
      notification.actions,
    ])
  );
};

const trayRowsAlign = (
  previous: TrayObservedRow,
  current: TrayObservedRow,
  deltaY: number,
): boolean => {
  if (previous.notification.id !== null || current.notification.id !== null) {
    return (
      previous.notification.id !== null && previous.notification.id === current.notification.id
    );
  }
  const left = previous.bounds;
  const right = current.bounds;
  if (!left || !right) {
    return false;
  }
  return (
    previous.notification.appLabel === current.notification.appLabel &&
    previous.notification.inGroup === current.notification.inGroup &&
    left.left === right.left &&
    left.right === right.right &&
    Math.abs(left.top - right.top - deltaY) <= 1
  );
};

// Prefer stable node IDs. Otherwise reconcile ordered row positions after
// accounting for scroll translation, rather than using changing row contents
// as identity. Without continuity evidence, retain rows conservatively.
const trayPageOverlap = (previous: TrayObservedRow[], current: TrayObservedRow[]): number => {
  for (let count = Math.min(previous.length, current.length); count > 0; count--) {
    const left = previous.slice(-count);
    const right = current.slice(0, count);
    const anchor = left.findIndex(
      (row, index) =>
        row.bounds &&
        right[index].bounds &&
        // A semantic match alone cannot prove that a repeated notification is
        // the same row. Require another aligned row or a native identity.
        (count > 1 || row.notification.id !== null) &&
        trayRowAnchor(row) === trayRowAnchor(right[index]),
    );
    if (anchor < 0) {
      if (
        left.every(
          (row, index) =>
            row.notification.id !== null && row.notification.id === right[index].notification.id,
        )
      ) {
        return count;
      }
      continue;
    }
    const deltaY = left[anchor].bounds!.top - right[anchor].bounds!.top;
    if (left.every((row, index) => trayRowsAlign(row, right[index], deltaY))) {
      return count;
    }
  }
  return 0;
};

// SystemUI reports the tray's scroll boundary through the existing hierarchy.
// `true` means examine actions; `false` and omitted (pre-API-33) both mean end.
const trayAtScrollEnd = (hierarchy: ViewHierarchyResult): boolean =>
  getHierarchyRoots(hierarchy).some((root) =>
    traverseForHint(root, (node) => {
      const props = getNodeProperties(node);
      if (!props) {
        return false;
      }
      const resourceId = notificationResourceId(node);
      if (!matchesNotificationResourceId(resourceId, "notification_stack_scroller")) {
        return false;
      }
      if (!isTruthy(props.scrollable)) {
        return true;
      }
      return Array.isArray(props.actions) && !props.actions.includes("scroll_forward");
    }),
  );

// SystemUI omits the per-row app-name header for the Silent (low-importance)
// section, so those rows carry no ownership evidence in the shade at all. The
// notification service does know who posted them; `--noredact` is what exposes
// the extras values the rendered row can be correlated against. A redacted or
// unavailable dump yields no records, which leaves such rows unattributed
// rather than attributed by guess.
// The aggregate unredacted dump of every posted notification routinely exceeds
// the child process's 1 MiB default stdout buffer, which rejects the read
// outright and leaves every header-less row unattributed.

const readDumpsysNotificationOutput = async (
  adb: SystemTrayAdb,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  try {
    const result = await adb.executeCommand("shell dumpsys notification --noredact", {
      maxBuffer: DUMPSYS_MAX_BUFFER,
      noRetry: true,
      signal,
    });
    return result.stdout;
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(
      `[systemTray] could not read dumpsys notification evidence: ${errorMessage(error)}`,
      error,
    );
    return undefined;
  }
};

const readDumpsysNotificationRecords = async (
  adb: SystemTrayAdb,
  signal?: AbortSignal,
): Promise<DumpsysNotificationRecord[] | undefined> => {
  const output = await readDumpsysNotificationOutput(adb, signal);
  return output === undefined ? undefined : parseDumpsysNotificationRecords(output);
};

/** Read stable active notification identities for one Android package. */
export const readActiveNotificationKeysForApp = async (
  adb: SystemTrayAdb,
  appId: string,
  signal?: AbortSignal,
): Promise<string[] | undefined> => {
  const output = await readDumpsysNotificationOutput(adb, signal);
  return output === undefined ? undefined : parseActiveNotificationKeysForApp(output, appId);
};

type TrayRowAttribution = TrayOwnershipEvidence | "other" | "unknown";

const isContentlessCustomLayout = (record: DumpsysNotificationRecord): boolean =>
  record.hasCustomLayout && record.titles.length === 0 && record.bodies.length === 0;

// The before snapshot is only evidence when it precedes every swipe. Once a
// read fails, a later page must not retry it: a post-swipe dump stored as
// "before" would present the requested package as the stable owner of a row
// retained from an earlier page after a competitor left during the swipe.
type TrayBeforeSnapshot =
  | { status: "not-attempted" }
  | { status: "unavailable" }
  | { status: "records"; records: DumpsysNotificationRecord[] };

const attributeTrayRow = (
  row: TrayObservedRow,
  appId: string,
  appLabel: string | null,
  {
    beforeRecords,
    afterRecords,
  }: {
    beforeRecords?: readonly DumpsysNotificationRecord[];
    afterRecords: readonly DumpsysNotificationRecord[];
  },
): TrayRowAttribution => {
  if (row.notification.appLabel !== null) {
    return appLabel && row.notification.appLabel === appLabel ? "header" : "other";
  }
  const requestedRecords = afterRecords.filter((record) => record.pkg === appId);
  // Some custom RemoteViews (for example Clock timers) expose neither title
  // nor text extras, but render their app label in the row's own notification
  // header chrome. That structural label cannot be spoofed by same-named
  // title/body content elsewhere in the row, and is evidence when a requested
  // record is content-less custom layout; absent header evidence
  // remains fail-closed for ambiguous or opaque records (#6875).
  if (
    appLabel !== null &&
    row.headerAppLabel === appLabel &&
    requestedRecords.length > 0 &&
    requestedRecords.some(isContentlessCustomLayout)
  ) {
    return "header";
  }
  const owner = attributeRowByDumpsys(
    intersectDumpsysRecordsForRow(beforeRecords, afterRecords, new Set(row.correlationTexts)),
    new Set(row.correlationTexts),
  );
  if (owner === null) {
    return "unknown";
  }
  return owner === appId ? "dumpsys" : "other";
};

// Keep every app's rows available to align pages, then expose only rows an
// evidence class actually attributes. Message text is not ownership evidence,
// so a row nothing can attribute is counted rather than claimed or hidden:
// "0 notifications" must stay distinguishable from "0 rows we could not read".
const attributeTrayRows = (
  rows: TrayObservedRow[],
  appId: string,
  appLabel: string | null,
  {
    beforeRecords,
    afterRecords,
  }: {
    beforeRecords?: readonly DumpsysNotificationRecord[];
    afterRecords: readonly DumpsysNotificationRecord[];
  },
): { notifications: ListedTrayNotification[]; unattributedRows: number } => {
  const notifications: ListedTrayNotification[] = [];
  const nativeIds = new Map<string, number>();
  let unattributedRows = 0;
  for (const row of rows) {
    const attribution = attributeTrayRow(row, appId, appLabel, { beforeRecords, afterRecords });
    if (attribution === "unknown") {
      unattributedRows++;
      continue;
    }
    if (attribution === "other") {
      continue;
    }
    const notification = { ...row.notification, appId, ownership: attribution };
    const previousIndex = notification.id === null ? undefined : nativeIds.get(notification.id);
    if (previousIndex !== undefined) {
      notifications[previousIndex] = notification;
    } else {
      if (notification.id !== null) {
        nativeIds.set(notification.id, notifications.length);
      }
      notifications.push(notification);
    }
  }
  return { notifications, unattributedRows };
};

/** The list pass cannot read an open notification shade. */
export class NotificationShadeNotOpenError extends ActionableError {}

/** Bounded UI inventory, in encounter order, with no inferred posting times. */
export const listSystemTrayNotifications = async (
  options: {
    device: BootedDevice;
    appId: string;
    appLabel: string | null;
    awaitTimeoutMs: number;
    signal?: AbortSignal;
    /**
     * Skip the read of the collapsed shade that only exists to report the final screen. A caller
     * that goes on to open the shade itself (clearAll) has no use for it.
     */
    skipTerminalObservation?: boolean;
  },
  context: TrayNotificationListContext,
): Promise<{
  notifications: ListedTrayNotification[];
  unattributedRows: number;
  observation: ObserveResult;
  swipes: number;
  order: "encounter";
}> => {
  const { device, appId, appLabel, awaitTimeoutMs, signal, skipTerminalObservation } = options;
  const { getSystemTrayDependencies, waitForSystemTrayOpen, observeSystemTray } = context;

  if (device.platform !== "android") {
    throw new ActionableError("systemTray list is supported only on Android.");
  }
  signal?.throwIfAborted();
  const detector = createNotificationUIDetector(device, getSystemTrayDependencies, signal);
  const { observeScreenFactory } = getSystemTrayDependencies();
  // Collapsing resets SystemUI's scroll position; every bounded scan starts at
  // the top even when a previous list left the shade open at its tail.
  await detector.collapseTray();
  signal?.throwIfAborted();
  await detector.expandTray();
  let observation = await waitForSystemTrayOpen(
    detector,
    observeScreenFactory(device),
    await detector.getObservationTimestamp(),
    { awaitTimeoutMs, signal },
  );
  const pageScan = await scanTrayNotificationPages(
    { device, detector, observation, signal },
    context,
  );
  const { rows, beforeSnapshot, swipes } = pageScan;
  observation = pageScan.observation;
  signal?.throwIfAborted();
  // Only pay for the dump when the shade actually rendered a row the header
  // rule cannot attribute.
  const { notifications, unattributedRows, requestedRecords, hasUnmatchedRequestedRecords } =
    await resolveTrayListingAttribution(
      { rows, beforeSnapshot, device, appId, appLabel, signal },
      context,
    );
  signal?.throwIfAborted();
  await detector.collapseTray();
  signal?.throwIfAborted();
  if (!skipTerminalObservation) {
    observation = await observeSystemTray(
      observeScreenFactory(device),
      await detector.getObservationTimestamp(),
      signal,
    );
  }
  if (hasUnmatchedRequestedRecords) {
    if (requestedRecords.every(isContentlessCustomLayout)) {
      throw new ActionableError(
        `Notification records for ${appId} have no title/text extras to correlate with shade rows (custom layout).`,
      );
    }
    // Records exist for the app but no row explains any: a shade read mid-render looks like this.
    throw new TransientPreSwipeError(
      `Notification records for ${appId} could not be correlated with shade rows.`,
    );
  }
  return { notifications, unattributedRows, observation, swipes, order: "encounter" };
};

async function scanTrayNotificationPages(
  options: {
    device: BootedDevice;
    detector: NotificationUIDetector;
    observation: ObserveResult;
    signal?: AbortSignal;
  },
  context: TrayNotificationListContext,
): Promise<{
  rows: TrayObservedRow[];
  beforeSnapshot: TrayBeforeSnapshot;
  swipes: number;
  observation: ObserveResult;
}> {
  const { getSystemTrayDependencies, observeSystemTray } = context;
  const { device, detector, signal } = options;
  let { observation } = options;
  const { adbFactory, observeScreenFactory, timer } = getSystemTrayDependencies();
  const rows: TrayObservedRow[] = [];
  let previousNotifications: TrayObservedRow[] = [];
  let beforeSnapshot: TrayBeforeSnapshot = { status: "not-attempted" };
  let swipes = 0;
  while (true) {
    signal?.throwIfAborted();
    if (!observation?.viewHierarchy || !detector.isTrayOpen(observation.viewHierarchy)) {
      throw new NotificationShadeNotOpenError(
        "Notification shade is not open; cannot list notifications.",
      );
    }
    const pageNotifications = readTrayNotifications(observation.viewHierarchy, context);
    const overlap = trayPageOverlap(previousNotifications, pageNotifications);
    rows.splice(rows.length - overlap, overlap, ...pageNotifications);
    previousNotifications = pageNotifications;
    // Capture as soon as a page needs correlation, before another swipe can
    // remove a competing notification from the authoritative snapshot (#6921).
    // Attempt it at most once: a failed read stays unavailable for the scan.
    if (
      beforeSnapshot.status === "not-attempted" &&
      pageNotifications.some((row) => row.notification.appLabel === null)
    ) {
      const records = await readDumpsysNotificationRecords(adbFactory(device), signal);
      beforeSnapshot =
        records === undefined ? { status: "unavailable" } : { status: "records", records };
    }
    if (swipes === 3 || trayAtScrollEnd(observation.viewHierarchy)) {
      break;
    }
    const { width, height } = observation.screenSize;
    const x = Math.floor(width / 2);
    const startY = Math.floor((height - observation.systemInsets.bottom) * 0.85);
    const endY = Math.floor(Math.max(observation.systemInsets.top, height * 0.35));
    await adbFactory(device).executeCommand(
      `shell input swipe ${x} ${startY} ${x} ${endY} ${SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS}`,
      { signal },
    );
    swipes++;
    // Reconcile pages against a settled viewport: a mid-fling frame has not
    // translated its rows by a single consistent offset yet, so overlap
    // detection against it duplicates or drops notifications.
    observation = await waitForScrollIdle(
      await observeSystemTray(
        observeScreenFactory(device),
        await detector.getObservationTimestamp(),
        signal,
      ),
      {
        observe: async () =>
          observeSystemTray(
            observeScreenFactory(device),
            await detector.getObservationTimestamp(),
            signal,
          ),
        timer,
        maxWaitMs: SYSTEM_TRAY_SCROLL_IDLE_TIMEOUT_MS,
        pollIntervalMs: SYSTEM_TRAY_SCROLL_IDLE_POLL_MS,
        logPrefix: "[systemTray]",
        signal,
      },
    );
  }

  return { rows, beforeSnapshot, swipes, observation };
}

async function resolveTrayListingAttribution(
  options: {
    rows: TrayObservedRow[];
    beforeSnapshot: TrayBeforeSnapshot;
    device: BootedDevice;
    appId: string;
    appLabel: string | null;
    signal?: AbortSignal;
  },
  context: TrayNotificationListContext,
) {
  const { getSystemTrayDependencies } = context;
  const { rows, beforeSnapshot, device, appId, appLabel, signal } = options;
  const { adbFactory } = getSystemTrayDependencies();
  const hasHeaderlessRows = rows.some((row) => row.notification.appLabel === null);
  const beforeRecords = beforeSnapshot.status === "records" ? beforeSnapshot.records : undefined;
  if (hasHeaderlessRows && beforeRecords === undefined) {
    logger.debug(
      "[systemTray] before dumpsys snapshot unavailable; falling back to after-only evidence.",
    );
  }
  const afterRecords = hasHeaderlessRows
    ? ((await readDumpsysNotificationRecords(adbFactory(device), signal)) ?? [])
    : [];
  const { notifications, unattributedRows } = attributeTrayRows(rows, appId, appLabel, {
    beforeRecords,
    afterRecords,
  });
  // Partial attribution stays useful; only zero attributed rows plus positive
  // posting evidence is unsafe to present as a confident empty list (#6875).
  const requestedRecords = afterRecords.filter((record) => record.pkg === appId);
  const hasUnmatchedRequestedRecords =
    beforeRecords !== undefined && requestedRecords.length > 0 && notifications.length === 0;

  return { notifications, unattributedRows, requestedRecords, hasUnmatchedRequestedRecords };
}

export interface TrayNotificationListContext {
  collectNotificationCandidates: typeof TrayHelpers.collectNotificationCandidates;
  createSubHierarchy: typeof TrayHelpers.createSubHierarchy;
  extractNodeTextCandidates: typeof TrayHelpers.extractNodeTextCandidates;
  getNotificationGroupHeader: typeof TrayHelpers.getNotificationGroupHeader;
  findHeaderAppLabel: typeof TrayHelpers.findHeaderAppLabel;
  observeSystemTray: typeof TrayHelpers.observeSystemTray;
  waitForSystemTrayOpen: typeof TrayHelpers.waitForSystemTrayOpen;
  getSystemTrayDependencies: typeof TrayHelpers.getSystemTrayDependencies;
}
