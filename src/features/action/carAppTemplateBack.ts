import type {
  ObserveResult,
  PressButtonResult,
  TemplateHostBackAffordance,
  ViewHierarchyResult,
} from "../../models";
import type { Element } from "../../models/Element";
import type { TapCoordinatesRequest } from "../../utils/interfaces/TapCoordinatesRequest";
import type { A11yTapCoordinatesResult } from "../observe/android/types";
import { DefaultElementParser } from "../utility/ElementParser";
import { toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { ObservedChangeOptions, ObservedEnvelope } from "./observedInteractionTypes";
import type { DisplayFence } from "./visualChangeDisplayFence";

/** Activity every Car App Library app runs its templates in on Android Automotive. */
export const CAR_APP_ACTIVITY = "androidx.car.app.activity.CarAppActivity";

/** Resource-id prefix of nodes the AAOS templates host renders inside a `CarAppActivity`. */
export const TEMPLATES_HOST_ID_PREFIX = "com.google.android.apps.automotive.templates.host:id/";

/** Host-rendered Back affordances, most specific first (#17498). */
const BACK_AFFORDANCES: ReadonlyArray<{ id: string; affordance: TemplateHostBackAffordance }> = [
  {
    id: `${TEMPLATES_HOST_ID_PREFIX}car_ui_toolbar_nav_icon_container`,
    affordance: "toolbar_nav_icon",
  },
  { id: `${TEMPLATES_HOST_ID_PREFIX}primary_header_action`, affordance: "primary_header_action" },
];

/** A visible Back affordance and the point to tap it. */
export interface TemplateHostBackTarget {
  affordance: TemplateHostBackAffordance;
  resourceId: string;
  x: number;
  y: number;
}

const parser = new DefaultElementParser();

function hostElements(viewHierarchy: ViewHierarchyResult | undefined): Element[] {
  if (!viewHierarchy) {
    return [];
  }
  return parser
    .flattenViewHierarchy(viewHierarchy)
    .map(({ element }) => element)
    .filter((element) => element["resource-id"]?.startsWith(TEMPLATES_HOST_ID_PREFIX) === true);
}

/**
 * True when the observation shows a Car App Library template (#17498): the foreground activity is
 * `CarAppActivity`, or the tree holds templates-host nodes. Local stand-in until observe marks
 * host-rendered UI itself (#17499); switch to that marker once it lands.
 */
export function isCarAppTemplateHost(observation: ObserveResult | undefined): boolean {
  if (!observation) {
    return false;
  }
  if (observation.activeWindow?.activityName === CAR_APP_ACTIVITY) {
    return true;
  }
  return hostElements(observation.viewHierarchy).length > 0;
}

function isClickable(element: Element): boolean {
  return element.clickable === true || element.clickable === "true";
}

function hasArea(element: Element): boolean {
  const { left, top, right, bottom } = element.bounds;
  return right > left && bottom > top;
}

/**
 * The host's visible Back affordance: the toolbar nav icon (content-desc `Back`) on list, grid,
 * pane and detail templates, else the unlabelled `primary_header_action` on the navigation place
 * list. Undefined on a root template, which shows neither.
 */
export function findTemplateHostBackTarget(
  viewHierarchy: ViewHierarchyResult | undefined,
): TemplateHostBackTarget | undefined {
  const candidates = hostElements(viewHierarchy).filter(
    (element) => isClickable(element) && hasArea(element),
  );
  for (const { id, affordance } of BACK_AFFORDANCES) {
    const element = candidates.find((candidate) => candidate["resource-id"] === id);
    if (element) {
      const { left, top, right, bottom } = element.bounds;
      return {
        affordance,
        resourceId: id,
        x: Math.round((left + right) / 2),
        y: Math.round((top + bottom) / 2),
      };
    }
  }
  return undefined;
}

const NO_VISUAL_CHANGE = "No visual change observed";

/** Coordinate tap the fallback dispatches through (CtrlProxy accessibility gesture). */
export interface TemplateHostBackTapClient {
  requestTapCoordinates(request: TapCoordinatesRequest): Promise<A11yTapCoordinatesResult>;
}

/** Runs one observed action, as `BaseVisualChange.observedInteraction` does. */
export type ObservedInteractionRunner = (
  block: (observation: ObserveResult, fence?: DisplayFence) => Promise<PressButtonResult>,
  options: ObservedChangeOptions,
) => Promise<PressButtonResult & ObservedEnvelope>;

/** What the Back press saw and did before the fallback decides. */
export interface TemplateHostBackContext {
  platform: string;
  button: string;
  /** The key dispatch itself reported success; only "nothing changed" earns the fallback. */
  pressSucceeded: boolean;
  prePress?: ObserveResult;
  options: ObservedChangeOptions;
}

/** Only an Android Back that dispatched but changed nothing on a template host qualifies. */
function qualifiesForTemplateHostBack(
  result: PressButtonResult & ObservedEnvelope,
  context: TemplateHostBackContext,
): boolean {
  if (context.platform !== "android" || context.button.toLowerCase() !== "back") {
    return false;
  }
  if (!context.pressSucceeded || result.success || result.error !== NO_VISUAL_CHANGE) {
    return false;
  }
  return isCarAppTemplateHost(result.observation) || isCarAppTemplateHost(context.prePress);
}

/**
 * Android BACK is a no-op on Car App Library templates (#16744; root cause in #17501): when an
 * Android Back press dispatched but changed nothing on a template host, tap the host's own Back
 * affordance and report it in `backFallback`. Every other result is returned unchanged.
 */
export async function retryBackOnTemplateHost(
  result: PressButtonResult & ObservedEnvelope,
  context: TemplateHostBackContext,
  deps: {
    /** Resolved only once the fallback applies, so iOS and non-template presses never build it. */
    tapClient: () => TemplateHostBackTapClient;
    observedInteraction: ObservedInteractionRunner;
  },
): Promise<PressButtonResult & ObservedEnvelope> {
  if (!qualifiesForTemplateHostBack(result, context)) {
    return result;
  }
  if (
    !findTemplateHostBackTarget(result.observation?.viewHierarchy) &&
    !findTemplateHostBackTarget(context.prePress?.viewHierarchy)
  ) {
    return result;
  }
  const { button, keyCode } = result;
  const signal = context.options.signal;
  return deps.observedInteraction(
    (observation, fence) =>
      tapHostBack(observation, { button, keyCode, signal, fence, tapClient: deps.tapClient }),
    { ...context.options, changeExpected: true },
  );
}

interface HostBackTapInputs {
  button: string;
  keyCode: number;
  signal?: AbortSignal;
  fence?: DisplayFence;
  tapClient: () => TemplateHostBackTapClient;
}

/**
 * Taps the Back affordance resolved from the fallback's own fresh observation, bound to that
 * frame (`frameContext`) and the display fence, so a screen that moved on is never tapped blind.
 */
async function tapHostBack(
  observation: ObserveResult,
  inputs: HostBackTapInputs,
): Promise<PressButtonResult> {
  const { button, keyCode } = inputs;
  const target = findTemplateHostBackTarget(observation.viewHierarchy);
  if (!target) {
    return {
      success: false,
      button,
      keyCode,
      error: `${NO_VISUAL_CHANGE}: the Car App Library template host Back affordance was gone before the fallback tap`,
    };
  }
  let dispatched = false;
  let tap: A11yTapCoordinatesResult;
  try {
    tap = await inputs.tapClient().requestTapCoordinates({
      x: target.x,
      y: target.y,
      signal: inputs.signal,
      frameContext: observation.viewHierarchy?.frameContext,
      beforeSend: () => inputs.fence?.assertCurrent(),
      onDispatch: () => {
        dispatched = true;
      },
    });
  } catch (error) {
    if (!dispatched) {
      throw toActionableError(error, "Failed to tap the Car App Library template host Back");
    }
    logger.warn(`[PRESS_BUTTON] host Back tap lost after dispatch: ${errorMessage(error)}`, error);
    return indeterminateHostBack(inputs, target, errorMessage(error));
  }
  if (tap.success) {
    return { success: true, button, keyCode, backFallback: target.affordance };
  }
  if (dispatched && tap.acknowledged !== true) {
    return indeterminateHostBack(inputs, target, tap.error);
  }
  return {
    success: false,
    button,
    keyCode,
    backFallback: target.affordance,
    error: `BACK changed nothing on the Car App Library template and tapping the host Back affordance (${target.resourceId}) failed: ${tap.error ?? "unknown error"}`,
  };
}

/** A dispatched host Back tap whose reply never came: it may have navigated, so never replay it. */
function indeterminateHostBack(
  inputs: HostBackTapInputs,
  target: TemplateHostBackTarget,
  reason: string | undefined,
): PressButtonResult {
  return {
    success: false,
    button: inputs.button,
    keyCode: inputs.keyCode,
    backFallback: target.affordance,
    code: "indeterminate_outcome",
    retryable: false,
    error: `Host Back tap outcome is indeterminate: the tap on ${target.resourceId} was dispatched but no result was confirmed (${reason ?? "unknown error"}). It may have navigated back. Do not retry automatically. Observe before retrying.`,
  };
}
