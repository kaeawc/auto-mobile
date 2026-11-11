import { ActionableError, toActionableError } from "../../models/ActionableError";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { errorMessage } from "../../models/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  parseWatchClockFaceDump,
  readSmartStackEditTap,
  readSmartStackWidgetCells,
  type SmartStackWidgetCellReading,
} from "./WatchSmartStack";
import type { WatchCommand, WatchRunnerClient } from "./WatchRunnerClient";

export interface WatchSmartStackWidgetOptions {
  appName: string;
  widgetName: string;
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
  reason: string;
}

export const GALLERY_SCROLL_SETTLE_MS = 1500;

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

/** Exact names identify the widget; a nameless cell counts only as the one just added. */
export function verifySmartStackWidget(
  dump: string,
  baselineDump: string,
  appName: string,
  widgetName: string,
): boolean {
  return (
    hasSmartStackWidget(dump, appName, widgetName) ||
    findUnnamedAddedWidget(dump, baselineDump, appName) !== undefined
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
  validateMaxAttempts(options.maxAttempts);
  validateRetryDelay(options.retryDelayMs);
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
  const poll = async (
    phase: "headerAttempts" | "verificationAttempts",
    matches: (dump: string) => boolean,
    limit: number,
  ) => {
    for (let attempt = 0; attempt < limit; attempt++) {
      result[phase]++;
      const dump = await request({ type: "face", op: "dump" });
      if (typeof dump !== "string") {
        throw new ActionableError(
          "Clockface dump was not text; update or reconnect the watch runner.",
        );
      }
      if (matches(dump)) {
        return dump;
      }
      if (attempt < limit - 1) {
        await settle();
      }
    }
    return undefined;
  };
  return { gesture, poll, settle };
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

async function selectGalleryWidget(
  { gesture }: WidgetActions,
  galleryStepsFromBottom: number,
  editTap: { x: number; y: number },
) {
  await gesture({ type: "face", op: "tap", ...editTap });
  await gesture({ type: "face", op: "tap", x: 0.5, y: 0.44 });
  await gesture({ type: "face", op: "swipe", direction: "up" }, GALLERY_SCROLL_SETTLE_MS);
  for (let step = 0; step < galleryStepsFromBottom; step++) {
    await gesture(
      { type: "face", op: "drag", fromX: 0.5, fromY: 0.5, toX: 0.5, toY: 0.6 },
      GALLERY_SCROLL_SETTLE_MS,
    );
  }
  await gesture({ type: "face", op: "tap", x: 0.5, y: 0.65 });
  await gesture({ type: "face", op: "tap", x: 0.5, y: 0.5 });
  await gesture({ type: "face", op: "tap", x: 0.16, y: 0.14 });
}

/** Drives the calibrated first-widget gallery path; success requires a clockface cell readback. */
export async function addWatchSmartStackWidget(
  client: Pick<WatchRunnerClient, "request">,
  options: WatchSmartStackWidgetOptions,
  deps: { timer?: Timer } = {},
): Promise<WatchSmartStackWidgetResult> {
  const {
    appName,
    widgetName,
    signal,
    galleryStepsFromBottom = 1,
    maxAttempts = 3,
    retryDelayMs = 20000,
  } = options;
  validateWidgetOptions(options);
  const result: WatchSmartStackWidgetResult = {
    success: false,
    steps: 0,
    attempts: 0,
    headerAttempts: 0,
    verificationAttempts: 0,
    reason: "",
  };
  const actions = createWidgetActions(client, result, deps.timer ?? defaultTimer, signal);
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      signal?.throwIfAborted();
      result.attempts++;
      const editableStack = await openSmartStack(actions);
      if (editableStack === undefined) {
        return {
          ...result,
          reason:
            "Smart Stack header and Edit button did not appear after 3 home/swipe rounds; start from the watch face and retry.",
        };
      }
      await selectGalleryWidget(actions, galleryStepsFromBottom, editableStack.editTap);
      result.success =
        (await actions.poll(
          "verificationAttempts",
          (dump) => verifySmartStackWidget(dump, editableStack.dump, appName, widgetName),
          10,
        )) !== undefined;
      if (result.success) {
        result.reason = "The requested widget cell is present in the Smart Stack.";
        return result;
      }
      if (attempt < maxAttempts - 1) {
        await actions.settle(retryDelayMs);
      }
    }
    result.reason =
      "Widget cell did not appear; check the display names and galleryStepsFromBottom before retrying.";
    return result;
  } catch (error) {
    const failure = toActionableError(error, "Failed to add watch Smart Stack widget");
    logger.warn(failure.message, error);
    return { ...result, reason: failure.message };
  }
}
