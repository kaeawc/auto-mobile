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

/** The virtual device inputs `tapOn` and `sendKeys` drive in headless mode. */
export type HeadlessPrototypeInputs = Pick<
  VirtualPrototypeInputs,
  "tap" | "typeText" | "clearText"
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
  if ((args.action ?? "tap") !== "tap") {
    return `tapOn action ${args.action}`;
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

/** Tries each `textAny` variant in order; the first that matches a node wins, as on a device. */
function tapSelector(
  inputs: HeadlessPrototypeInputs,
  selector: HeadlessSelector,
  exactText: boolean,
): VirtualPrototypeInputOutcome {
  if (!("textAny" in selector) || selector.textAny === undefined) {
    return inputs.tap({ ...selector, exactText });
  }
  let outcome: VirtualPrototypeInputOutcome = { success: false, events: [] };
  for (const text of selector.textAny) {
    outcome = inputs.tap({ text, exactText });
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
  const outcome = tapSelector(inputsOrThrow(deps), args.selector, args.exactText === true);
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
  const inputs = inputsOrThrow(deps);
  const outcomes: VirtualPrototypeInputOutcome[] = [];
  if (args.selector !== undefined) {
    outcomes.push(tapSelector(inputs, args.selector, false));
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
