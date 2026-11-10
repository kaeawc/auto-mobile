/**
 * Stuck-result messages for a D-pad walk trapped by the on-screen keyboard or a text field: what
 * holds focus, which keys were tried, and what the caller can press instead.
 */
import type { Element } from "../../models/Element";
import { isEditableElementProperties } from "../utility/elementProperties";
import type {
  FocusNavigateBlocker,
  FocusPathEntry,
  FocusScreen,
  FocusTrapEscape,
} from "./FocusNavigate";
import { FOCUS_NAVIGATE_DIRECTIONS, type FocusNavigateDirection } from "./FocusNavigateDirections";
import { textFieldToolkit } from "./textFieldToolkit";

export function describeEntry(entry: FocusPathEntry | undefined): string {
  if (!entry) {
    return "";
  }
  const name = entry.resourceId ?? entry.text ?? entry.contentDesc ?? entry.descendantLabel;
  if (name) {
    return ` ${JSON.stringify(name)}`;
  }
  const { left, top, right, bottom } = entry.bounds;
  return ` at [${left},${top}][${right},${bottom}]`;
}

/**
 * Whether the focused editable field is a classic View `EditText` (see {@link textFieldToolkit}).
 * A Compose `TextField` on Android TV keeps focus on every D-pad direction even with the keyboard
 * hidden; only tab moves it out (#17441). A View field takes back then an arrow, and tab could
 * type a tab character into it, so tab is never pressed there.
 */
export function isViewTextField(screen: FocusScreen, focused: Element): boolean {
  return textFieldToolkit(focused, screen.hierarchy) === "view";
}

/** Where a caller goes once no key leaves a View field: off the screen, not another arrow. */
const LEAVE_SCREEN_ADVICE =
  "press pressButton back to leave the screen and reach the target from another route, observe, then retry";

/** What a stuck walk tried: the escape keys pressed and the arrows refused since the last one. */
interface TrapAttempt {
  escapes: readonly FocusTrapEscape[];
  /**
   * Arrows pressed from the trapped element that left focus on it, since the last escape. A
   * fixed-direction walk, or one whose target is not in the read, can stop after one refusal.
   */
  refused: ReadonlySet<FocusNavigateDirection>;
}

/** `a`, `a or b`, `a, b or c`: the arrows a caller has yet to press. */
function joinDirections(directions: readonly FocusNavigateDirection[], last: string): string {
  return directions.length < 2
    ? directions.join("")
    : `${directions.slice(0, -1).join(", ")} ${last} ${directions.at(-1)}`;
}

/** The arrows of a trap walk that no read has refused yet, in D-pad order. */
function untriedDirections(attempt: TrapAttempt): FocusNavigateDirection[] {
  return FOCUS_NAVIGATE_DIRECTIONS.filter((direction) => !attempt.refused.has(direction));
}

/**
 * What a caller does next: tab for a Compose field, and for a View field only keys no read has
 * already shown to fail. A View `EditText` on Android TV keeps focus on every direction even with
 * the keyboard hidden (#17741), so leaving the screen is advised only once all four arrows were
 * refused since the last escape; before that, the arrows not yet pressed are named first (a
 * fixed-direction walk, or one whose target is not in the read, can stop after one refusal).
 */
function trapAdvice(
  blocker: FocusNavigateBlocker,
  viewField: boolean,
  attempt: TrapAttempt,
): string {
  const { escapes } = attempt;
  // An IME action (sendKeys next/done) does not move D-pad focus out of a TV text field (#17378).
  if (viewField) {
    const hide =
      blocker === "ime" && !escapes.includes("back")
        ? "Hide the keyboard with pressButton back and observe; "
        : "";
    const untried = untriedDirections(attempt);
    if (untried.length > 0) {
      return `${hide}${hide ? "then " : ""}press pressButton ${joinDirections(untried, "or")} (not yet pressed from this field) and observe; if focus still does not leave it, ${LEAVE_SCREEN_ADVICE}`;
    }
    return hide
      ? `${hide}if no D-pad direction then moves focus out of the field, ${LEAVE_SCREEN_ADVICE}`
      : `No D-pad direction moves focus out of this field; ${LEAVE_SCREEN_ADVICE}`;
  }
  if (escapes.includes("tab")) {
    return "Focus did not leave the field with back, the D-pad or tab; observe, then retry from another route";
  }
  return "Hide the keyboard with pressButton back, press sendKeys key tab to move focus out of the field (D-pad arrows do not leave a Compose text field), observe, then retry";
}

/** The stuck message naming the trap, the escapes tried and what the caller can do instead. */
export function trapMessage(
  blocker: FocusNavigateBlocker,
  screen: FocusScreen,
  focusedElement: FocusPathEntry | undefined,
  attempt: TrapAttempt,
): string {
  const { escapes, refused } = attempt;
  const { focused } = screen;
  const editable = focused !== null && isEditableElementProperties(focused);
  const holder = editable
    ? `the editable text field${describeEntry(focusedElement)}`
    : `the focused element${describeEntry(focusedElement)}`;
  const trap =
    blocker === "ime"
      ? `D-pad focus is trapped by the on-screen keyboard over ${holder}`
      : `D-pad focus is trapped in ${holder}`;
  const viewField = editable && isViewTextField(screen, focused);
  const every = untriedDirections(attempt).length === 0;
  const pressed = joinDirections(
    FOCUS_NAVIGATE_DIRECTIONS.filter((direction) => refused.has(direction)),
    "and",
  );
  const refusal =
    every || !pressed ? "arrow keys do not leave it" : `pressing ${pressed} does not leave it`;
  const tried =
    escapes.length > 0
      ? `; pressing ${escapes.join(" then ")} and ${every || !pressed ? "every direction" : pressed} again did not move focus`
      : viewField
        ? `; ${refusal} and tab would type into it`
        : `; ${refusal}`;
  const advice = trapAdvice(blocker, viewField, attempt);
  return `${trap}${tried}. ${advice.charAt(0).toUpperCase()}${advice.slice(1)}`;
}
