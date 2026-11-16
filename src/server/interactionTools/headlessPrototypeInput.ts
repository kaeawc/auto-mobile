import {
  isHeadlessPrototypeMode,
  virtualPrototypeDeviceReport,
} from "../../features/prototype/headless/headlessPrototypeMode";
import type {
  VirtualPrototypeInputOutcome,
  VirtualPrototypeInputs,
} from "../../features/prototype/headless/VirtualPrototypeInputs";
import { ActionableError } from "../../models/ActionableError";
import { createStructuredToolResponse } from "../../utils/toolUtils";
import { daemonVirtualPrototypeInputs } from "../prototypeTools/daemonSpecRevisions";
import type { SendKeysArgs, TapOnArgs } from "../interactionToolTypes";
import { resolveTapOnAction } from "./tapHandlers";

/** The virtual device inputs `tapOn` and `sendKeys` drive in headless mode. */
export type HeadlessPrototypeInputs = Pick<
  VirtualPrototypeInputs,
  "tap" | "focusOn" | "typeText" | "clearText"
>;

/** Where the handlers find the inputs and whether headless mode is on; tests inject both. */
export interface HeadlessPrototypeInputDependencies {
  env?: NodeJS.ProcessEnv;
  virtualPrototypeInputs?: () => HeadlessPrototypeInputs | undefined;
}

/** True when `tapOn` and `sendKeys` run on the virtual device instead of resolving a device. */
export function isHeadlessInput(deps: HeadlessPrototypeInputDependencies): boolean {
  return isHeadlessPrototypeMode(deps.env);
}

const UNSUPPORTED_TAP_ON_OPTIONS = [
  "sibling",
  "container",
  "index",
  "subtext",
  "ensureChecked",
  "display",
] as const;

/**
 * `layer: "app"` excludes the prototype's nodes, as on a device. The virtual device shows only the
 * prototype, with no app below it, so nothing can match.
 */
function refuseAppLayer(layer: string | undefined, tool: "tapOn" | "sendKeys"): void {
  if (layer === "app") {
    throw new ActionableError(
      `No element matches ${tool} with layer "app" on the headless virtual device: it shows only the prototype, with no app below it. Omit layer or pass layer: "prototype".`,
    );
  }
}

function inputsOrThrow(deps: HeadlessPrototypeInputDependencies): HeadlessPrototypeInputs {
  const inputs = (deps.virtualPrototypeInputs ?? daemonVirtualPrototypeInputs)();
  if (!inputs) {
    throw new ActionableError(
      "Headless mode has no prototype to act on: call prototype show first. tapOn and sendKeys reach only the prototype on the headless virtual device.",
    );
  }
  return inputs;
}

function tapOnRefusal(args: TapOnArgs): string | undefined {
  const option = UNSUPPORTED_TAP_ON_OPTIONS.find((name) => args[name] !== undefined);
  if (option) {
    return `tapOn ${option}`;
  }
  // A positive duration without an action is a longPress, as on a device; tap with one throws.
  const action = resolveTapOnAction(args);
  if (action !== "tap") {
    return `tapOn action ${action}`;
  }
  if (args.selectionStrategy !== undefined && args.selectionStrategy !== "first") {
    return `tapOn selectionStrategy ${args.selectionStrategy}`;
  }
  return args.selector.accessibilityLink === undefined
    ? undefined
    : "tapOn selector accessibilityLink";
}

function responseFor(outcome: VirtualPrototypeInputOutcome, message: string) {
  if (!outcome.success) {
    throw new ActionableError(outcome.error ?? "The headless virtual device refused the input.");
  }
  return createStructuredToolResponse({
    ...outcome,
    message,
    virtualDevice: virtualPrototypeDeviceReport(),
  });
}

type HeadlessSelector = TapOnArgs["selector"] | NonNullable<SendKeysArgs["selector"]>;

type SelectorInput = (
  selector: Parameters<HeadlessPrototypeInputs["tap"]>[0],
) => VirtualPrototypeInputOutcome;

/** Tries each `textAny` variant in order; the first that matches a node wins, as on a device. */
function withSelector(
  input: SelectorInput,
  selector: HeadlessSelector,
  exactText: boolean,
): VirtualPrototypeInputOutcome {
  if (!("textAny" in selector) || selector.textAny === undefined) {
    return input({ ...selector, exactText });
  }
  let outcome: VirtualPrototypeInputOutcome = { success: false, events: [] };
  for (const text of selector.textAny) {
    outcome = input({ text, exactText });
    if (outcome.target !== undefined) {
      break;
    }
  }
  return outcome;
}

/** `tapOn` on the headless virtual device (#18360). */
export async function headlessTapOnHandler(
  args: TapOnArgs,
  deps: HeadlessPrototypeInputDependencies,
) {
  const refusal = tapOnRefusal(args);
  if (refusal) {
    throw new ActionableError(
      `The headless virtual device does not support ${refusal}; tap with a plain text, elementId or testTag selector, or run on a device.`,
    );
  }
  refuseAppLayer(args.layer, "tapOn");
  const inputs = inputsOrThrow(deps);
  const outcome = withSelector(
    (selector) => inputs.tap(selector),
    args.selector,
    args.exactText === true,
  );
  return responseFor(
    outcome,
    outcome.handled === false
      ? "Tapped the virtual device; nothing handles a tap on that node."
      : `Tapped the virtual device; ${outcome.events.length} prototype event(s) raised.`,
  );
}

type SendKeysCommand = SendKeysArgs["commands"][number];

function runCommand(
  inputs: HeadlessPrototypeInputs,
  command: SendKeysCommand,
): VirtualPrototypeInputOutcome {
  if (command.action === "type") {
    return inputs.typeText(command.text, command.operation === "replace" ? "replace" : "insert");
  }
  if (command.action === "clear") {
    return inputs.clearText();
  }
  return {
    success: false,
    error: `The headless virtual device does not support sendKeys ${command.action} commands; use type or clear.`,
    events: [],
  };
}

/** `sendKeys` type and clear commands into the virtual device's focused text field (#18360). */
export async function headlessSendKeysHandler(
  args: SendKeysArgs,
  deps: HeadlessPrototypeInputDependencies,
) {
  if (args.container !== undefined || args.display !== undefined) {
    throw new ActionableError(
      "The headless virtual device does not support sendKeys container or display; pass a plain selector.",
    );
  }
  if (args.selectionStrategy !== undefined && args.selectionStrategy !== "first") {
    throw new ActionableError(
      `The headless virtual device does not support sendKeys selectionStrategy ${args.selectionStrategy}; it focuses the first match. Pass a selector that names one field, or run on a device.`,
    );
  }
  // Only a selector names a field; without one, sendKeys types into the focused field.
  if (args.selector !== undefined) {
    refuseAppLayer(args.layer, "sendKeys");
  }
  const inputs = inputsOrThrow(deps);
  const outcomes: VirtualPrototypeInputOutcome[] = [];
  if (args.selector !== undefined) {
    // Focus, not tap: a selector naming a button must not run its handlers (#18360).
    outcomes.push(withSelector((selector) => inputs.focusOn(selector), args.selector, false));
  }
  for (const command of args.commands) {
    if (outcomes.some((outcome) => !outcome.success)) {
      break;
    }
    outcomes.push(runCommand(inputs, command));
  }
  const failed = outcomes.find((outcome) => !outcome.success);
  const last = outcomes.at(-1)!;
  return responseFor(
    failed ?? { ...last, events: outcomes.flatMap((outcome) => outcome.events) },
    `Executed ${args.commands.length} sendKeys command(s) on the virtual device.`,
  );
}
