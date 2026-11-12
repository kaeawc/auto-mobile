import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { Element } from "../../models/Element";
import type { TapOnElementOptions, TapOnElementResult } from "../../models";
import type {
  SendKeysCommand,
  SendKeysSelector,
  SendKeysFocusOptions,
  SendKeysResult,
} from "../action/SendKeys";
import { DefaultElementParser } from "../utility/ElementParser";
import { normalizeVisionosHierarchy } from "./VisionosHierarchy";
import { requireVisionosRunner, withVisionosHostRecovery } from "./VisionosRunnerLifecycle";
import { logger } from "../../utils/logger";

/** XCUIKeyboardKey.delete (U+0008 on iOS-family, U+007F on macOS) and forwardDelete (U+F728). */
const DELETE_KEY_CHARACTERS = new Set(["\u0008", "\u007f", ""]);

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

// The shared iOS resolver also ranks geometry, windows and ancestry. Here only the runner's
// explicit clickable flag and identifier are relevant; preserve capture order within each tier.
function tapCandidateRank(element: Element): number {
  if (element.enabled === "false") {
    return 4;
  }
  if (element["resource-id"]) {
    return element.clickable === "true" ? 0 : 1;
  }
  return element.clickable === "true" ? 2 : 3;
}

function assertVisionosTapTarget(target: Element): void {
  if (!target["resource-id"] && !target.text) {
    throw new ActionableError(
      "The matched visionOS element has no accessibility identifier or text; add an accessibility label or identifier to the control, then observe again.",
    );
  }
  if (target.enabled === "false") {
    throw new ActionableError(
      "The matched visionOS element is disabled; observe and select an enabled control.",
    );
  }
}

/** Ornament frames are scene-local. Resolve by identifier or exact type and label. */
export async function visionosTapOn(
  deviceId: string,
  options: TapOnElementOptions,
  signal?: AbortSignal,
): Promise<TapOnElementResult> {
  assertVisionosTapOptions(options);
  // A tap refused because the host app is gone was never applied, so one retry is safe.
  return withVisionosHostRecovery(deviceId, signal, () => tapOnce(deviceId, options, signal));
}

async function tapOnce(
  deviceId: string,
  options: TapOnElementOptions,
  signal?: AbortSignal,
): Promise<TapOnElementResult> {
  const client = await requireVisionosRunner(deviceId, signal);
  const tree = normalizeVisionosHierarchy(await client.hierarchy(signal));
  const all = new DefaultElementParser().flattenViewHierarchy(tree).map(({ element }) => element);
  const candidates = all
    .filter(
      (element) =>
        (options.elementId === undefined ||
          element["resource-id"] === options.elementId ||
          element["view-id"] === options.elementId) &&
        (options.text === undefined || element.text === options.text),
    )
    .sort((a, b) => tapCandidateRank(a) - tapCandidateRank(b));
  const target = candidates[options.index ?? 0];
  if (!target) {
    throw new ActionableError(
      "No visionOS element matched the selector and index; observe and use its identifier or exact text.",
    );
  }
  assertVisionosTapTarget(target);
  const identifier = target["resource-id"] ?? "";
  const label = target.text ?? "";
  const sharers = all.filter((element) => (element["resource-id"] ?? "") === identifier);
  // The runner resolves only enabled elements, so a disabled twin never makes a tap ambiguous.
  // It still makes the identifier shared: send type and label so a twin enabled after capture
  // cannot take the tap.
  const narrowed = sharers.filter(
    (element) =>
      element.enabled !== "false" &&
      element.class === target.class &&
      (element.text ?? "") === label,
  );
  if (narrowed.length > 1) {
    const details = narrowed.map(
      (element) =>
        `className=${element.class}, text=${JSON.stringify(element.text ?? "")}, bounds=${JSON.stringify(element.bounds)}`,
    );
    throw new ActionableError(
      identifier
        ? `The visionOS match was ambiguous for identifier '${identifier}'; candidates: ${details.join("; ")}. Pass index or a distinct text/elementId to select a distinguishable target.`
        : `The visionOS match was ambiguous for type ${target.class} and label ${JSON.stringify(label)}; candidates: ${details.join("; ")}. Pass index to select a distinguishable type/label or add an accessibility identifier; identical type/label matches cannot be distinguished by index.`,
    );
  }
  signal?.throwIfAborted();
  await client.request(
    {
      type: "request_tap_element",
      identifier,
      ...(!identifier || sharers.length > 1 ? { label, elementType: Number(target.class) } : {}),
    },
    signal,
  );
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
    if ([...command.text].some((char) => DELETE_KEY_CHARACTERS.has(char))) {
      throw new ActionableError(
        "visionOS sendKeys appends text only; text containing a delete key would erase existing content.",
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
