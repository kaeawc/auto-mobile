import { ActionableError, toActionableError } from "../../models/ActionableError";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { errorMessage } from "../../models/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  parseWatchClockFaceDump,
  readSmartStackEditTap,
  readSmartStackWidgetCells,
  WATCH_CLOCK_FACE_BUNDLE_ID,
  type SmartStackWidgetCellReading,
} from "./WatchSmartStack";
import type { WatchCommand, WatchRunnerClient } from "./WatchRunnerClient";
import type { WatchHierarchyNode } from "./WatchHierarchy";
import {
  parseXcuiDebugDescription,
  parseXcuiDebugLine,
  type XcuiDebugLine,
} from "./WatchXcuiDebugDescription";

export interface WatchSmartStackWidgetOptions {
  appName: string;
  widgetName: string;
  /**
   * Host app bundle id and widget kind from the cell descriptor; together they identify a cell
   * whose identifier lost its app and widget names (#17793).
   */
  hostBundleId?: string;
  widgetKind?: string;
  galleryStepsFromBottom?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
}

export interface WatchSmartStackWidgetResult {
  success: boolean;
  steps: number;
  attempts: number;
  headerAttempts: number;
  verificationAttempts: number;
  galleryRowMisses: number;
  /** True when a matching cell was on the stack before an edit, so no widget was added. */
  alreadyPresent: boolean;
  reason: string;
}

/** The widget to find: display names, plus the descriptor identity for a nameless cell. */
export interface SmartStackWidgetTarget {
  appName: string;
  widgetName: string;
  hostBundleId?: string;
  widgetKind?: string;
}

export const GALLERY_SCROLL_SETTLE_MS = 1500;
export const CLOCKFACE_RELAUNCH_SETTLE_MS = 3000;
const MAX_GALLERY_SEARCH_STEPS = 8;
const MAX_GALLERY_CORRECTIVE_DRAGS = 3;
const MIN_GALLERY_VISIBLE_HEIGHT = 24;
const GALLERY_ROW_PREFIX = "AppGroupCell -- ";

function readGalleryRows(dump: string): Map<string, XcuiDebugLine> {
  const rows = new Map<string, XcuiDebugLine>();
  for (const line of dump.split("\n")) {
    if (!line.trimStart().startsWith("Cell,")) {
      continue;
    }
    const row = parseXcuiDebugLine(line);
    if (row?.identifier?.startsWith(GALLERY_ROW_PREFIX)) {
      rows.set(row.identifier, row);
    }
  }
  return rows;
}

/** Exact gallery cell identifier match; undefined means no readable gallery rows. */
export function hasGalleryAppRow(dump: string, appName: string): boolean | undefined {
  const rows = readGalleryRows(dump);
  return rows.size > 0 ? rows.has(`${GALLERY_ROW_PREFIX}${appName}`) : undefined;
}

function hasEditableSmartStack(dump: string): boolean {
  try {
    return (
      parseWatchClockFaceDump(dump, { timestamp: 0 }).smartStack.header !== undefined &&
      readSmartStackEditTap(dump) !== undefined
    );
  } catch (error) {
    // A dump without a window frame mid-transition has no Edit button.
    logger.debug(`Smart Stack edit availability check skipped: ${errorMessage(error)}`);
    return false;
  }
}

/** XCUI debugDescription is text; match only a cell identifier with exact name fields. */
export function hasSmartStackWidget(dump: string, appName: string, widgetName: string): boolean {
  return dump.split("\n").some((line) => {
    if (!line.trimStart().startsWith("Cell,")) {
      return false;
    }
    const identifier = line.split("identifier: 'StackCollectionViewComplicationCell -- ")[1];
    const fields = identifier?.split(" -- ");
    return (
      fields !== undefined &&
      fields.length >= 4 &&
      fields[1] === appName &&
      fields[2] === widgetName
    );
  });
}

function readWidgetCells(dump: string): SmartStackWidgetCellReading[] | undefined {
  try {
    return readSmartStackWidgetCells(dump);
  } catch (error) {
    // A dump without a window frame (the face mid-transition) has no cells to compare.
    logger.debug(`Smart Stack cell readback skipped: ${errorMessage(error)}`);
    return undefined;
  }
}

/**
 * The widget cell added since `baselineDump` when its identifier's app and widget names are both
 * empty (#17793). It must be the only new cell id, every baseline widget cell must still be
 * there, the widget cell count must have gone up by exactly one, and the cell's own labels must
 * hold `appName`; otherwise the cell cannot be told apart from what was already on the stack.
 */
export function findUnnamedAddedWidget(
  dump: string,
  baselineDump: string,
  appName: string,
): SmartStackWidgetCellReading | undefined {
  const before = readWidgetCells(baselineDump);
  const after = readWidgetCells(dump);
  if (!before || !after) {
    return undefined;
  }
  const afterIds = new Set(after.map(({ card }) => card.cellId));
  const beforeIds = new Set(before.map(({ card }) => card.cellId));
  const added = after.filter(({ card }) => !beforeIds.has(card.cellId));
  const [cell] = added;
  if (
    added.length !== 1 ||
    afterIds.size !== after.length ||
    after.length !== before.length + 1 ||
    ![...beforeIds].every((id) => afterIds.has(id))
  ) {
    return undefined;
  }
  return cell.card.appName === "" && cell.card.widgetName === "" && cell.labels.includes(appName)
    ? cell
    : undefined;
}

/**
 * A cell whose app and widget names are both empty but whose host bundle id and widget kind
 * equal the target's. Needs both identity fields; without them a nameless cell is not matched.
 */
export function hasNamelessSmartStackWidget(
  dump: string,
  { hostBundleId, widgetKind }: Pick<SmartStackWidgetTarget, "hostBundleId" | "widgetKind">,
): boolean {
  if (hostBundleId === undefined || widgetKind === undefined) {
    return false;
  }
  return (readWidgetCells(dump) ?? []).some(
    ({ card }) =>
      card.appName === "" &&
      card.widgetName === "" &&
      card.hostBundleId === hostBundleId &&
      card.widgetKind === widgetKind,
  );
}

/** The target is on the stack by exact names or, for a nameless cell, by descriptor identity. */
export function isSmartStackWidgetPresent(dump: string, target: SmartStackWidgetTarget): boolean {
  return (
    hasSmartStackWidget(dump, target.appName, target.widgetName) ||
    hasNamelessSmartStackWidget(dump, target)
  );
}

/** A present target verifies; otherwise a nameless cell counts only as the one just added. */
export function verifySmartStackWidget(
  dump: string,
  baselineDump: string,
  target: SmartStackWidgetTarget,
): boolean {
  return (
    isSmartStackWidgetPresent(dump, target) ||
    findUnnamedAddedWidget(dump, baselineDump, target.appName) !== undefined
  );
}

/**
 * Before an edit: the target is already on the stack, or (on a retry) an earlier attempt's
 * nameless cell is the one cell added since the first attempt's header dump.
 */
function isAlreadyOnStack(
  headerDump: string,
  firstHeaderDump: string,
  target: SmartStackWidgetTarget,
): boolean {
  return (
    isSmartStackWidgetPresent(headerDump, target) ||
    (headerDump !== firstHeaderDump &&
      findUnnamedAddedWidget(headerDump, firstHeaderDump, target.appName) !== undefined)
  );
}

function validateWidgetOptions(options: WatchSmartStackWidgetOptions): void {
  const { appName, widgetName, galleryStepsFromBottom = 1 } = options;
  if (
    typeof appName !== "string" ||
    !appName.trim() ||
    typeof widgetName !== "string" ||
    !widgetName.trim()
  ) {
    throw new ActionableError("Provide non-empty appName and widgetName display names.");
  }
  if (
    !Number.isInteger(galleryStepsFromBottom) ||
    galleryStepsFromBottom < 0 ||
    galleryStepsFromBottom > 100
  ) {
    throw new ActionableError("galleryStepsFromBottom must be an integer from 0 to 100.");
  }
  validateIdentity(options);
  validateMaxAttempts(options.maxAttempts);
  validateRetryDelay(options.retryDelayMs);
}

function validateIdentity({ hostBundleId, widgetKind }: WatchSmartStackWidgetOptions): void {
  const isBlank = (value: unknown) => typeof value !== "string" || !value.trim();
  if (
    (hostBundleId !== undefined || widgetKind !== undefined) &&
    (isBlank(hostBundleId) || isBlank(widgetKind))
  ) {
    throw new ActionableError(
      "Provide both hostBundleId and widgetKind as non-empty strings, or neither.",
    );
  }
}

function validateMaxAttempts(maxAttempts = 3): void {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new ActionableError("maxAttempts must be an integer from 1 to 5.");
  }
}

function validateRetryDelay(retryDelayMs = 20000): void {
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 120000) {
    throw new ActionableError("retryDelayMs must be an integer from 0 to 120000.");
  }
}

function createWidgetActions(
  client: Pick<WatchRunnerClient, "request">,
  result: WatchSmartStackWidgetResult,
  timer: Timer,
  signal?: AbortSignal,
) {
  const request = async (command: WatchCommand) => {
    signal?.throwIfAborted();
    result.steps++;
    return client.request(command, signal);
  };
  const settle = async (delayMs = 250) => {
    signal?.throwIfAborted();
    if (delayMs > 0) {
      await timer.sleep(delayMs);
    }
    signal?.throwIfAborted();
  };
  const gesture = async (command: WatchCommand, delayMs = 250) => {
    await request(command);
    await settle(delayMs);
  };
  const readDump = async () => {
    const dump = await request({ type: "face", op: "dump" });
    if (typeof dump !== "string") {
      throw new ActionableError(
        "Clockface dump was not text; update or reconnect the watch runner.",
      );
    }
    return dump;
  };
  const poll = async (
    phase: "headerAttempts" | "verificationAttempts",
    matches: (dump: string) => boolean,
    limit: number,
  ) => {
    for (let attempt = 0; attempt < limit; attempt++) {
      result[phase]++;
      const dump = await readDump();
      if (matches(dump)) {
        return dump;
      }
      if (attempt < limit - 1) {
        await settle();
      }
    }
    return undefined;
  };
  return { gesture, poll, settle, readDump };
}

type WidgetActions = ReturnType<typeof createWidgetActions>;

interface EditableStack {
  dump: string;
  editTap: { x: number; y: number };
}

async function findEditableStackAfterSwipe({
  gesture,
  poll,
}: WidgetActions): Promise<EditableStack | undefined> {
  let header = await poll("headerAttempts", hasEditableSmartStack, 2);
  if (header !== undefined) {
    const editTap = readSmartStackEditTap(header);
    if (editTap) {
      return { dump: header, editTap };
    }
  }
  for (let extraSwipe = 0; extraSwipe < 3; extraSwipe++) {
    await gesture({ type: "face", op: "swipe", direction: "up" });
    header = await poll("headerAttempts", hasEditableSmartStack, 2);
    if (header !== undefined) {
      const editTap = readSmartStackEditTap(header);
      if (editTap) {
        return { dump: header, editTap };
      }
    }
  }
  return undefined;
}

/** Returns the dump that showed the header: the stack as it was before this attempt's edit. */
async function openSmartStack(actions: WidgetActions): Promise<EditableStack | undefined> {
  // Home can be swallowed or toggle the face and app grid; verify each home/swipe round.
  for (let round = 0; round < 3; round++) {
    await actions.gesture({ type: "home" });
    await actions.gesture({ type: "face", op: "swipe", direction: "up" });
    const editableStack = await findEditableStackAfterSwipe(actions);
    if (editableStack !== undefined) {
      return editableStack;
    }
  }
  return undefined;
}

function readGalleryNavigationBottom(root: WatchHierarchyNode): number {
  let bottom = 0;
  const nodes = [root];
  for (const node of nodes) {
    if (node.className === "NavigationBar") {
      bottom = Math.max(bottom, node.bounds.bottom);
    }
    nodes.push(...(node.children ?? []));
  }
  return bottom;
}

function readGalleryRowTap(dump: string, row?: XcuiDebugLine) {
  if (!row?.frame) {
    return undefined;
  }
  try {
    const tree = parseXcuiDebugDescription(dump, {
      bundleId: WATCH_CLOCK_FACE_BUNDLE_ID,
      timestamp: 0,
    });
    if (tree.screenWidth <= 0 || tree.screenHeight <= 0) {
      return undefined;
    }
    const { left, right, top, bottom } = row.frame;
    const navBottom = readGalleryNavigationBottom(tree.root);
    const visibleTop = Math.max(top, navBottom);
    const visibleBottom = Math.min(bottom, tree.screenHeight);
    if (visibleBottom - visibleTop < MIN_GALLERY_VISIBLE_HEIGHT) {
      return { needsEarlierDrag: top < navBottom, tap: undefined };
    }
    const x = (left + right) / 2 / tree.screenWidth;
    const y = (visibleTop + visibleBottom) / 2 / tree.screenHeight;
    return { needsEarlierDrag: false, tap: x > 0 && x < 1 ? { x, y } : undefined };
  } catch (error) {
    // A transitional dump without a window cannot supply a safe row tap.
    logger.debug(`Smart Stack gallery row tap skipped: ${errorMessage(error)}`);
    return undefined;
  }
}

interface GallerySearch {
  appName: string;
  direction: "later" | "earlier";
  correctiveDrags: number;
}

function gallerySearchDrag(
  search: GallerySearch,
  needsEarlierDrag = false,
): WatchCommand | undefined {
  if (needsEarlierDrag && search.correctiveDrags >= MAX_GALLERY_CORRECTIVE_DRAGS) {
    return undefined;
  }
  search.correctiveDrags += Number(needsEarlierDrag);
  const earlier = needsEarlierDrag || search.direction === "earlier";
  return {
    type: "face",
    op: "drag",
    fromX: 0.5,
    toX: 0.5,
    fromY: earlier ? 0.5 : 0.6,
    toY: earlier ? 0.6 : 0.4,
  };
}

/** Row frames may jitter by a fraction of a point between dumps of a settled list. */
const GALLERY_FRAME_TOLERANCE = 1;

function sameGalleryFrame(a: XcuiDebugLine["frame"], b: XcuiDebugLine["frame"]): boolean {
  if (!a || !b) {
    return a === b;
  }
  return (["left", "top", "right", "bottom"] as const).every(
    (edge) => Math.abs(a[edge] - b[edge]) <= GALLERY_FRAME_TOLERANCE,
  );
}

/** A drag reached a list boundary only when the same rows sit at the same frames. */
function galleryRowsUnchanged(
  rows: Map<string, XcuiDebugLine>,
  nextRows: Map<string, XcuiDebugLine>,
): boolean {
  return (
    rows.size === nextRows.size &&
    [...rows].every(([id, row]) => {
      const next = nextRows.get(id);
      return next !== undefined && sameGalleryFrame(row.frame, next.frame);
    })
  );
}

async function searchGalleryDirection(
  { gesture, readDump }: WidgetActions,
  dump: string,
  search: GallerySearch,
) {
  const identifier = `${GALLERY_ROW_PREFIX}${search.appName}`;
  let rows = readGalleryRows(dump);
  let reading = readGalleryRowTap(dump, rows.get(identifier));
  for (let step = 0; step < MAX_GALLERY_SEARCH_STEPS; step++) {
    const drag = gallerySearchDrag(search, reading?.needsEarlierDrag);
    if (!drag) {
      break;
    }
    await gesture(drag, GALLERY_SCROLL_SETTLE_MS);
    dump = await readDump();
    const nextRows = readGalleryRows(dump);
    const row = nextRows.get(identifier);
    reading = readGalleryRowTap(dump, row);
    if (reading?.tap) {
      return { dump, tap: reading.tap };
    }
    if (nextRows.size === 0 || (!row && galleryRowsUnchanged(rows, nextRows))) {
      break;
    }
    // A listed row needs at least 24 points clear of the navigation bar and window edges.
    rows = nextRows;
  }
  return { dump, tap: undefined };
}

async function findGalleryRowTap(actions: WidgetActions, dump: string, appName: string) {
  const search: GallerySearch = { appName, direction: "later", correctiveDrags: 0 };
  const later = await searchGalleryDirection(actions, dump, search);
  if (later.tap) {
    return later.tap;
  }
  search.direction = "earlier";
  return (await searchGalleryDirection(actions, later.dump, search)).tap;
}

async function tapCalibratedGalleryRow({ gesture }: WidgetActions, galleryStepsFromBottom: number) {
  for (let step = 0; step < galleryStepsFromBottom; step++) {
    await gesture(
      { type: "face", op: "drag", fromX: 0.5, fromY: 0.5, toX: 0.5, toY: 0.6 },
      GALLERY_SCROLL_SETTLE_MS,
    );
  }
  await gesture({ type: "face", op: "tap", x: 0.5, y: 0.65 });
}

async function selectGalleryWidget(
  actions: WidgetActions,
  galleryStepsFromBottom: number,
  editTap: { x: number; y: number },
  appName: string,
) {
  const { gesture, readDump } = actions;
  await gesture({ type: "face", op: "tap", ...editTap });
  await gesture({ type: "face", op: "tap", x: 0.5, y: 0.44 });
  await gesture({ type: "face", op: "swipe", direction: "up" }, GALLERY_SCROLL_SETTLE_MS);
  const dump = await readDump();
  if (hasGalleryAppRow(dump, appName) === false) {
    const tap = await findGalleryRowTap(actions, dump, appName);
    if (!tap) {
      return "gallery-row-missing";
    }
    await gesture({ type: "face", op: "tap", ...tap });
  } else {
    await tapCalibratedGalleryRow(actions, galleryStepsFromBottom);
  }
  await gesture({ type: "face", op: "tap", x: 0.5, y: 0.5 });
  await gesture({ type: "face", op: "tap", x: 0.16, y: 0.14 });
  return "selected";
}

interface WidgetAttempt {
  /** Set when the flow ends with this attempt. */
  final?: WatchSmartStackWidgetResult;
  headerDump?: string;
  galleryRowMissing?: boolean;
}

/** One open, check and add round; `firstHeaderDump` is the first attempt's header dump. */
async function runWidgetAttempt(
  actions: WidgetActions,
  result: WatchSmartStackWidgetResult,
  target: SmartStackWidgetTarget & { galleryStepsFromBottom: number },
  firstHeaderDump: string | undefined,
): Promise<WidgetAttempt> {
  const editableStack = await openSmartStack(actions);
  if (editableStack === undefined) {
    return {
      final: {
        ...result,
        reason:
          "Smart Stack header and Edit button did not appear after 3 home/swipe rounds; start from the watch face and retry.",
      },
    };
  }
  const headerDump = editableStack.dump;
  // A retry after a failed readback must not add a duplicate of a widget that did land.
  if (isAlreadyOnStack(headerDump, firstHeaderDump ?? headerDump, target)) {
    return {
      headerDump,
      final: {
        ...result,
        success: true,
        alreadyPresent: true,
        reason: "The requested widget cell is already in the Smart Stack; no widget was added.",
      },
    };
  }
  const selection = await selectGalleryWidget(
    actions,
    target.galleryStepsFromBottom,
    editableStack.editTap,
    target.appName,
  );
  if (selection === "gallery-row-missing") {
    return { headerDump, galleryRowMissing: true };
  }
  const readback = await actions.poll(
    "verificationAttempts",
    (dump) => verifySmartStackWidget(dump, headerDump, target),
    10,
  );
  if (readback === undefined) {
    return { headerDump };
  }
  return {
    headerDump,
    final: {
      ...result,
      success: true,
      reason: "The requested widget cell is present in the Smart Stack.",
    },
  };
}

async function recoverMissingGalleryRow(
  actions: WidgetActions,
  result: WatchSmartStackWidgetResult,
  { appName, signal, maxAttempts = 3 }: WatchSmartStackWidgetOptions,
  relaunchClockface?: () => Promise<void>,
): Promise<WatchSmartStackWidgetResult | undefined> {
  result.galleryRowMisses++;
  signal?.throwIfAborted();
  if (!relaunchClockface) {
    return {
      ...result,
      reason: `Smart Stack gallery has no row for ${appName}. Relaunch com.apple.clockface (xcrun simctl terminate <udid> com.apple.clockface) and retry.`,
    };
  }
  if (result.attempts === maxAttempts) {
    return undefined;
  }
  await relaunchClockface();
  await actions.settle(CLOCKFACE_RELAUNCH_SETTLE_MS);
  return undefined;
}

function withDefaultFlowLimits({
  galleryStepsFromBottom = 1,
  maxAttempts = 3,
  retryDelayMs = 20000,
}: WatchSmartStackWidgetOptions) {
  return { galleryStepsFromBottom, maxAttempts, retryDelayMs };
}

interface RecoveryContext {
  options: WatchSmartStackWidgetOptions;
  firstHeaderDump: string | undefined;
  relaunchClockface?: () => Promise<void>;
}

/** One attempt; a gallery without the app row relaunches clockface instead of tapping blindly. */
async function runAttemptWithRecovery(
  actions: WidgetActions,
  result: WatchSmartStackWidgetResult,
  target: SmartStackWidgetTarget & { galleryStepsFromBottom: number },
  { options, firstHeaderDump, relaunchClockface }: RecoveryContext,
): Promise<WidgetAttempt & { missed: boolean }> {
  const attempt = await runWidgetAttempt(actions, result, target, firstHeaderDump);
  if (attempt.final !== undefined || !attempt.galleryRowMissing) {
    return { ...attempt, missed: false };
  }
  const failure = await recoverMissingGalleryRow(actions, result, options, relaunchClockface);
  return { headerDump: attempt.headerDump, final: failure, missed: true };
}

/** Drives the calibrated first-widget gallery path; success requires a clockface cell readback. */
export async function addWatchSmartStackWidget(
  client: Pick<WatchRunnerClient, "request">,
  options: WatchSmartStackWidgetOptions,
  deps: { timer?: Timer; relaunchClockface?: () => Promise<void> } = {},
): Promise<WatchSmartStackWidgetResult> {
  const { appName, widgetName, hostBundleId, widgetKind, signal } = options;
  const { galleryStepsFromBottom, maxAttempts, retryDelayMs } = withDefaultFlowLimits(options);
  validateWidgetOptions(options);
  const result: WatchSmartStackWidgetResult = {
    success: false,
    steps: 0,
    attempts: 0,
    headerAttempts: 0,
    verificationAttempts: 0,
    galleryRowMisses: 0,
    alreadyPresent: false,
    reason: "",
  };
  const target: SmartStackWidgetTarget = { appName, widgetName, hostBundleId, widgetKind };
  let firstHeaderDump: string | undefined;
  const actions = createWidgetActions(client, result, deps.timer ?? defaultTimer, signal);
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      signal?.throwIfAborted();
      result.attempts++;
      const { final, headerDump, missed } = await runAttemptWithRecovery(
        actions,
        result,
        { ...target, galleryStepsFromBottom },
        { options, firstHeaderDump, relaunchClockface: deps.relaunchClockface },
      );
      if (final !== undefined) {
        return final;
      }
      firstHeaderDump ??= headerDump;
      // A relaunch already waited for clockface to respawn; only gallery indexing needs the delay.
      if (!missed && attempt < maxAttempts - 1) {
        await actions.settle(retryDelayMs);
      }
    }
    result.reason =
      result.galleryRowMisses > 0
        ? `Smart Stack gallery row for ${appName} never appeared during ${result.galleryRowMisses} of ${result.attempts} attempts; widget cell was not verified. Check widget availability, relaunch com.apple.clockface (xcrun simctl terminate <udid> com.apple.clockface), and retry.`
        : "Widget cell did not appear; check the display names and galleryStepsFromBottom before retrying.";
    return result;
  } catch (error) {
    const failure = toActionableError(error, "Failed to add watch Smart Stack widget");
    logger.warn(failure.message, error);
    return { ...result, reason: failure.message };
  }
}
