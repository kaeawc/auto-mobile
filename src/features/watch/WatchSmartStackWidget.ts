import { ActionableError, toActionableError } from "../../models/ActionableError";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import type { WatchCommand, WatchRunnerClient } from "./WatchRunnerClient";

export interface WatchSmartStackWidgetOptions {
  appName: string;
  widgetName: string;
  galleryStepsFromBottom?: number;
  signal?: AbortSignal;
}

export interface WatchSmartStackWidgetResult {
  success: boolean;
  steps: number;
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
}

/** Drives the calibrated first-widget gallery path; success requires a clockface cell readback. */
export async function addWatchSmartStackWidget(
  client: Pick<WatchRunnerClient, "request">,
  options: WatchSmartStackWidgetOptions,
  deps: { timer?: Timer } = {},
): Promise<WatchSmartStackWidgetResult> {
  const { appName, widgetName, signal, galleryStepsFromBottom = 1 } = options;
  validateWidgetOptions(options);
  const timer = deps.timer ?? defaultTimer;
  const result: WatchSmartStackWidgetResult = {
    success: false,
    steps: 0,
    headerAttempts: 0,
    verificationAttempts: 0,
    reason: "",
  };
  const request = async (command: WatchCommand) => {
    signal?.throwIfAborted();
    result.steps++;
    return client.request(command, signal);
  };
  const settle = async () => {
    signal?.throwIfAborted();
    await timer.sleep(250);
    signal?.throwIfAborted();
  };
  const gesture = async (command: WatchCommand) => {
    await request(command);
    await settle();
  };
  const poll = async (
    phase: "headerAttempts" | "verificationAttempts",
    matches: (dump: string) => boolean,
  ) => {
    for (let attempt = 0; attempt < 10; attempt++) {
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
      if (attempt < 9) {
        await settle();
      }
    }
    return false;
  };
  try {
    // The runner's own app is foreground at start; the face must be showing for the swipe.
    await gesture({ type: "home" });
    await gesture({ type: "face", op: "swipe", direction: "up" });
    if (
      !(await poll("headerAttempts", (dump) => dump.includes("identifier: 'Smart Stack Header'")))
    ) {
      return {
        ...result,
        reason: "Smart Stack header did not appear; start from the watch face and retry.",
      };
    }
    await gesture({ type: "face", op: "tap", x: 0.5, y: 0.92 });
    await gesture({ type: "face", op: "tap", x: 0.5, y: 0.44 });
    await gesture({ type: "face", op: "swipe", direction: "up" });
    for (let step = 0; step < galleryStepsFromBottom; step++) {
      await gesture({ type: "face", op: "drag", fromX: 0.5, fromY: 0.5, toX: 0.5, toY: 0.6 });
    }
    await gesture({ type: "face", op: "tap", x: 0.5, y: 0.65 });
    await gesture({ type: "face", op: "tap", x: 0.5, y: 0.5 });
    await gesture({ type: "face", op: "tap", x: 0.16, y: 0.14 });
    result.success = await poll("verificationAttempts", (dump) =>
      hasSmartStackWidget(dump, appName, widgetName),
    );
    result.reason = result.success
      ? "The requested widget cell is present in the Smart Stack."
      : "Widget cell did not appear; check the display names and galleryStepsFromBottom before retrying.";
    return result;
  } catch (error) {
    const failure = toActionableError(error, "Failed to add watch Smart Stack widget");
    logger.warn(failure.message, error);
    return { ...result, reason: failure.message };
  }
}
