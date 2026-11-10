import { ActionableError, toActionableError } from "../../models/ActionableError";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
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
  const gesture = async (command: WatchCommand) => {
    await request(command);
    await settle();
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
        return true;
      }
      if (attempt < limit - 1) {
        await settle();
      }
    }
    return false;
  };
  return { gesture, poll, settle };
}

type WidgetActions = ReturnType<typeof createWidgetActions>;

async function openSmartStack({ gesture, poll }: WidgetActions): Promise<boolean> {
  // Home can be swallowed or toggle the face and app grid; verify each home/swipe round.
  for (let round = 0; round < 3; round++) {
    await gesture({ type: "home" });
    await gesture({ type: "face", op: "swipe", direction: "up" });
    if (
      await poll("headerAttempts", (dump) => dump.includes("identifier: 'Smart Stack Header'"), 4)
    ) {
      return true;
    }
  }
  return false;
}

async function selectGalleryWidget({ gesture }: WidgetActions, galleryStepsFromBottom: number) {
  await gesture({ type: "face", op: "tap", x: 0.5, y: 0.92 });
  await gesture({ type: "face", op: "tap", x: 0.5, y: 0.44 });
  await gesture({ type: "face", op: "swipe", direction: "up" });
  for (let step = 0; step < galleryStepsFromBottom; step++) {
    await gesture({ type: "face", op: "drag", fromX: 0.5, fromY: 0.5, toX: 0.5, toY: 0.6 });
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
      if (!(await openSmartStack(actions))) {
        return {
          ...result,
          reason:
            "Smart Stack header did not appear after 3 home/swipe rounds; start from the watch face and retry.",
        };
      }
      await selectGalleryWidget(actions, galleryStepsFromBottom);
      result.success = await actions.poll(
        "verificationAttempts",
        (dump) => hasSmartStackWidget(dump, appName, widgetName),
        10,
      );
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
