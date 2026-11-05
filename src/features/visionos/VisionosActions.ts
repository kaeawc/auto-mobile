import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { TapOnElementOptions, TapOnElementResult } from "../../models";
import type {
  SendKeysCommand,
  SendKeysSelector,
  SendKeysFocusOptions,
  SendKeysResult,
} from "../action/SendKeys";
import { DefaultElementParser } from "../utility/ElementParser";
import { normalizeVisionosHierarchy } from "./VisionosHierarchy";
import { requireVisionosRunner } from "./VisionosRunnerLifecycle";
import { logger } from "../../utils/logger";

function assertVisionosTapOptions(options: TapOnElementOptions): void {
  const refused = Object.entries(options).filter(
    ([key, value]) =>
      value !== undefined &&
      (value !== false || key === "ensureChecked") &&
      !["action", "elementId", "text", "index"].includes(key),
  );
  if (
    options.action !== "tap" ||
    refused.length ||
    (options.elementId === undefined && options.text === undefined)
  ) {
    throw new ActionableError(
      "visionOS tapOn supports only action tap with elementId, exact text and optional index in a window or ornament.",
    );
  }
  if (options.index !== undefined && (!Number.isInteger(options.index) || options.index < 0)) {
    throw new ActionableError("visionOS tap index must be a non-negative integer.");
  }
}

/** Ornament frames are scene-local. Resolve a match, then dispatch its unique identifier. */
export async function visionosTapOn(
  deviceId: string,
  options: TapOnElementOptions,
  signal?: AbortSignal,
): Promise<TapOnElementResult> {
  assertVisionosTapOptions(options);
  const client = await requireVisionosRunner(deviceId, signal);
  const tree = normalizeVisionosHierarchy(await client.hierarchy(signal));
  const all = new DefaultElementParser().flattenViewHierarchy(tree).map(({ element }) => element);
  const candidates = all.filter(
    (element) =>
      (options.elementId === undefined ||
        element["resource-id"] === options.elementId ||
        element["view-id"] === options.elementId) &&
      (options.text === undefined || element.text === options.text),
  );
  const target = candidates[options.index ?? 0];
  const identifier = target?.["resource-id"];
  if (
    !target ||
    !identifier ||
    target.enabled === "false" ||
    all.filter((element) => element["resource-id"] === identifier).length !== 1
  ) {
    throw new ActionableError(
      "No uniquely identified enabled visionOS element matched; observe and use its identifier or exact text.",
    );
  }
  signal?.throwIfAborted();
  await client.request({ type: "request_tap_element", identifier }, signal);
  return { success: true, action: "tap", element: target };
}

/** Append only: the runner refuses input unless a text field already has focus. */
export async function visionosSendKeys(
  deviceId: string,
  commands: SendKeysCommand[],
  selector?: SendKeysSelector,
  options: SendKeysFocusOptions & { display?: string; signal?: AbortSignal } = {},
): Promise<SendKeysResult> {
  if (
    selector !== undefined ||
    options.container !== undefined ||
    options.selectionStrategy !== undefined ||
    options.layer !== undefined ||
    options.display !== undefined ||
    commands.length === 0
  ) {
    throw new ActionableError(
      "visionOS sendKeys supports only type commands into the focused field; focus it with tapOn first.",
    );
  }
  // Validate the complete batch before issuing any input.
  const typing = commands.map((command) => {
    if (command.action !== "type" || !command.text || command.operation === "replace") {
      throw new ActionableError(
        "visionOS sendKeys supports only non-empty append type commands; focus the field with tapOn first.",
      );
    }
    return command;
  });
  const { signal } = options;
  const client = await requireVisionosRunner(deviceId, signal);
  const results: SendKeysResult["commands"] = [];
  for (const [index, command] of typing.entries()) {
    signal?.throwIfAborted();
    try {
      await client.request({ type: "request_append_text", text: command.text }, signal);
    } catch (error) {
      signal?.throwIfAborted();
      const failure = toActionableError(
        error,
        "visionOS text entry failed; focus a text field with tapOn first",
      );
      logger.warn(failure.message, error);
      results.push({ index, action: "type", success: false, error: failure.message });
      return {
        success: false,
        completedCommands: index,
        failedIndex: index,
        commands: results,
        error: failure.message,
      };
    }
    results.push({ index, action: "type", success: true, textLength: [...command.text].length });
  }
  return { success: true, completedCommands: results.length, commands: results };
}
