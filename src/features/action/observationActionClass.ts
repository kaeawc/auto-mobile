import { isInPlacePressButton, isNavigationPressButton } from "./pressButtonPolicy";
import { isSubmitImeAction } from "../../models/ImeActionResult";

/**
 * How an action tool's effect on the screen is classified for observation
 * policy. Two consumers share this single classifier so they can never
 * disagree about what "navigation" means:
 *
 *  - `finalizeToolResponse` (#2761/#6221) picks the diff-vs-full wire shape.
 *  - The embedded-observation settle gate (#6866) decides whether the capture
 *    handed back with the action must first pass a hierarchy-stability check.
 */
export type ObservationActionClass = "navigation" | "inPlace" | "scroll" | "unknown";

/** Tools whose class is fixed regardless of arguments. */
const FIXED_OBSERVATION_ACTION_CLASSES: Readonly<Record<string, ObservationActionClass>> = {
  tapOn: "navigation",
  tapAny: "navigation",
  homeScreen: "navigation",
  recentApps: "navigation",
  openLink: "navigation",
  clearText: "inPlace",
  selectAllText: "inPlace",
  keyboard: "inPlace",
  clipboard: "inPlace",
  swipeOn: "scroll",
  dragAndDrop: "scroll",
};

/** `sendKeys` key names that submit the field, and so may navigate. */
const SUBMITTING_KEY_NAMES: ReadonlySet<string> = new Set([
  "enter",
  "done",
  "go",
  "search",
  "send",
]);

function classifyPressButton(args?: Record<string, unknown>): ObservationActionClass {
  if (isNavigationPressButton(args?.button)) {
    return "navigation";
  }
  return isInPlacePressButton(args?.button) ? "inPlace" : "unknown";
}

function classifySendKeys(args?: Record<string, unknown>): ObservationActionClass {
  const commands = Array.isArray(args?.commands) ? args.commands : [];
  const maySubmit = commands.some((command) => {
    if (!command || typeof command !== "object") {
      return false;
    }
    const value = command as Record<string, unknown>;
    return value.action === "key" && SUBMITTING_KEY_NAMES.has(String(value.key));
  });
  return maySubmit ? "navigation" : "inPlace";
}

export function classifyObservationAction(
  name: string,
  args?: Record<string, unknown>,
): ObservationActionClass {
  const fixed = FIXED_OBSERVATION_ACTION_CLASSES[name];
  if (fixed) {
    return fixed;
  }
  switch (name) {
    case "pressButton":
      return classifyPressButton(args);
    case "sendKeys":
      return classifySendKeys(args);
    case "inputText":
      return isSubmitImeAction(args?.imeAction) ? "navigation" : "inPlace";
    case "imeAction":
      return isSubmitImeAction(args?.action) ? "navigation" : "inPlace";
    default:
      return "unknown";
  }
}

/**
 * Whether an action of this class has its embedded observation gated on
 * hierarchy stability before it is handed to the client (issue #6866).
 *
 * A tool the classifier does not recognise (`"unknown"`) is NOT thereby
 * declared unsettled: a handler that ran its own stability wait —
 * `systemTray({action: "tap"})` waits for a changed hierarchy to stay
 * structurally stable — publishes `settled` at its payload top level, and
 * `settleEmbeddedObservationInResponse` carries that verdict onto the embedded
 * observation instead of overwriting it (#6890 review). Classification decides
 * whether the gate RE-OBSERVES, not what the response may claim.
 *
 * Only `"navigation"` is gated: those are the actions that replace the screen,
 * and a capture taken mid-inflation is the one that drops a not-yet-attached
 * child (the Settings `switchWidget` of #6257) and re-hashes its parent's
 * content-derived `s2-…` id. In-place, scroll and unknown actions keep the
 * current single capture so their latency is unchanged.
 */
export function isSettleGatedActionClass(actionClass: ObservationActionClass): boolean {
  return actionClass === "navigation";
}
