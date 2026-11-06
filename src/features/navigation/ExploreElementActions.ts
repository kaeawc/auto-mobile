import { BootedDevice, Element, ObserveResult } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { ProgressCallback } from "../action/BaseVisualChange";
import { logger } from "../../utils/logger";
import { SwipeOnElement } from "../action/SwipeOnElement";
import { TapAtCoordinate } from "../action/TapAtCoordinate";
import { TapOnElement } from "../action/TapOnElement";
import { Timer } from "../../utils/SystemTimer";
import {
  FocusNavigate,
  type FocusKeyPresser,
  type FocusNavigateTarget,
} from "../action/FocusNavigate";
import { FocusListAdvance } from "../action/FocusListAdvance";
import type { RevealedListRows } from "./RevealedListRows";
import {
  pinnedFocusOptions,
  SelectorDpadTargetResolver,
  type DpadTargetResolver,
} from "../action/DpadTargetResolver";
import { ResolverElementSelector } from "../utility/ResolverElementSelector";
import type { ToolCallInteraction } from "../../utils/interfaces/NavigationGraph";
import { recordedFocusTarget, recordedFocusWalkOptions } from "./ExploreValidateMode";
import { createFocusNavigateObserver } from "../action/FocusNavigateObserver";
import { InputKey } from "../action/InputKey";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { isTruthy } from "../../models";
import { beginPostActionCaptureAction } from "../../utils/PostActionCaptureContext";
import { awaitWhileRequestIsLive } from "../../utils/toolUtils";
import { publicTapOnArgs, tapCoordinatesFor, tapSelectorFor } from "./ExploreElementExtraction";
import { focusSelectArgs, focusTargetForElement } from "./focusDrivenInput";

/** Resolves `label`/`elementId` focus targets with tapOn's own selector. */
const defaultTargetResolver = new SelectorDpadTargetResolver(new ResolverElementSelector());

/** How long explore waits after a D-pad select for the screen to change, like a tap's settle. */
const FOCUS_SELECT_SETTLE_MS = 1000;

/** The D-pad focus walk explore drives on a TV. */
export type FocusSelectNavigator = Pick<FocusNavigate, "execute">;

/** The bounded D-pad advance explore drives through a scrollable list on a TV. */
export type FocusListAdvancer = Pick<FocusListAdvance, "execute">;

/** Android key presses that carry the request signal, so a cancelled walk sends no more keys. */
function androidFocusKeys(
  device: BootedDevice,
  adbFactory: AdbClientFactory,
  timer: Timer,
): FocusKeyPresser {
  const keys = new InputKey(device, { adbFactory, timer });
  return { press: (key, signal) => keys.press(key, undefined, undefined, { signal }) };
}

/** The production D-pad walk: fresh hierarchy reads and Android key presses. */
export function defaultFocusSelectNavigator(
  device: BootedDevice,
  observeScreen: Pick<ObserveScreen, "execute">,
  adbFactory: AdbClientFactory,
  timer: Timer,
): FocusSelectNavigator {
  return new FocusNavigate(
    createFocusNavigateObserver(observeScreen),
    androidFocusKeys(device, adbFactory, timer),
    timer,
  );
}

/** The production list advance: fresh hierarchy reads and Android key presses. */
export function defaultFocusListAdvancer(
  device: BootedDevice,
  observeScreen: Pick<ObserveScreen, "execute">,
  adbFactory: AdbClientFactory,
  timer: Timer,
): FocusListAdvancer {
  return new FocusListAdvance(
    createFocusNavigateObserver(observeScreen),
    androidFocusKeys(device, adbFactory, timer),
    timer,
  );
}

/** The D-pad walk and list advance explore drives on a TV. */
export interface FocusDrivenActions {
  focusNavigator: () => FocusSelectNavigator;
  /** Advances D-pad focus through a scrollable list to reveal rows beyond the visible ones. */
  focusListAdvancer: () => FocusListAdvancer;
}

/**
 * Explore's D-pad actions: the given factories (fakes in tests), else the production ones, which
 * read `observeScreen()` when they run so a replaced observer is the one they use.
 */
export function focusDrivenActions(
  device: BootedDevice,
  timer: Timer,
  overrides: {
    observeScreen: () => Pick<ObserveScreen, "execute">;
    adbFactory: AdbClientFactory;
    focusNavigatorFactory?: () => FocusSelectNavigator;
    focusListAdvancerFactory?: () => FocusListAdvancer;
  },
): FocusDrivenActions {
  const { observeScreen, adbFactory } = overrides;
  return {
    focusNavigator:
      overrides.focusNavigatorFactory ??
      (() => defaultFocusSelectNavigator(device, observeScreen(), adbFactory, timer)),
    focusListAdvancer:
      overrides.focusListAdvancerFactory ??
      (() => defaultFocusListAdvancer(device, observeScreen(), adbFactory, timer)),
  };
}

interface ExplorationActionContext extends FocusDrivenActions {
  device: BootedDevice;
  adb: AdbExecutor | undefined;
  timer: Timer;
  /** Rows this exploration's list advances revealed; outlives each actions instance. */
  revealedRows: RevealedListRows;
  /** Pins `label`/`elementId` targets to the element tapOn would tap; tapOn's resolver by default. */
  focusTargetResolver?: DpadTargetResolver;
  runRecorded<T extends { success: boolean }>(
    toolName: string | null,
    args: Record<string, unknown>,
    observation: ObserveResult | undefined,
    run: () => Promise<T>,
  ): Promise<T>;
}
/** Tap/swipe construction with the exploration's recorded-dispatch boundary. */
export class ExploreElementActions {
  constructor(private readonly context: ExplorationActionContext) {}

  /** Swipe a scrollable container; the swipeOn record needs a selector to replay it. */
  async swipeContainer(
    element: Element,
    observation: ObserveResult,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<boolean> {
    logger.info(
      `[Explore] Swiping on scrollable container: ${element["resource-id"] || element["class"]}`,
    );
    const swipeOn = new SwipeOnElement(this.context.device, this.context.adb);
    const container = observation.viewHierarchy
      ? tapSelectorFor(element, observation.viewHierarchy)
      : null;
    const result = await this.context.runRecorded(
      container ? "swipeOn" : null,
      container ? { container, direction: "up", speed: "slow" } : {},
      observation,
      () => swipeOn.execute(element, "up", { duration: 600 }, { progress, signal }),
    );
    return result.success;
  }

  /** Tap an element by selector, else its centre; null when it has no tap target. */
  async tapElement(
    element: Element,
    observation: ObserveResult,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<boolean | null> {
    const selector = observation.viewHierarchy
      ? tapSelectorFor(element, observation.viewHierarchy)
      : null;
    const coordinates = selector ? null : tapCoordinatesFor(element);
    if (!selector && !coordinates) {
      logger.warn(
        `[Explore] Element has no tap target: missing resource-id, text/content-desc (including descendants), and usable bounds; class=${element["class"] || "<empty>"}; bounds=${JSON.stringify(element.bounds)}`,
      );
      return null;
    }
    const result = selector
      ? await this.context.runRecorded("tapOn", publicTapOnArgs(selector), observation, () =>
          new TapOnElement(this.context.device, this.context.adb).execute(
            { ...selector, action: "tap" },
            { progress, signal },
          ),
        )
      : await this.context.runRecorded(
          "tapAt",
          { ...coordinates!, action: "tap" },
          observation,
          () =>
            new TapAtCoordinate(this.context.device, this.context.adb, {
              timer: this.context.timer,
            }).execute({ ...coordinates!, action: "tap" }, { progress, signal }),
        );
    return result.success;
  }

  /**
   * Move D-pad focus to the element and select it, recorded as `focusNavigate` with
   * `select: true` so navigateTo replays the same D-pad walk; null when nothing names it.
   * A newly discovered scrollable container is not selected: it is advanced instead (see
   * {@link advanceList}), since moving focus through it is what scrolls it; a recorded
   * non-focus edge on one has no D-pad replay and returns null. Validate mode passes its edge's recorded interaction, so a recorded `focusNavigate`
   * replays its `until`, walk options and `select` (a call that navigated on focus alone
   * presses no enter), even on a scrollable container.
   */
  async focusSelectElement(
    element: Element,
    observation: ObserveResult,
    {
      signal,
      recorded,
    }: { signal?: AbortSignal; recorded?: Pick<ToolCallInteraction, "toolName" | "args"> } = {},
  ): Promise<boolean | null> {
    // A recorded focus walk may target a scrollable container (focus alone can navigate). Any
    // other recorded edge on one (a touch run's swipeOn) has no D-pad replay, so validation skips it.
    if (isTruthy(element.scrollable) && recorded?.toolName !== "focusNavigate") {
      return recorded ? null : await this.advanceList(element, observation, signal);
    }
    const until =
      recordedFocusTarget(recorded) ??
      (observation.viewHierarchy
        ? focusTargetForElement(element, observation.viewHierarchy)
        : null);
    if (!until) {
      logger.warn(
        `[Explore] Element has no focus target: missing resource-id and text/content-desc (including descendants), or a duplicate needing an index; class=${element["class"] || "<empty>"}`,
      );
      return null;
    }
    // Validate mode replays the recorded walk, its direction and bounds included.
    const args = this.focusWalkArgs(until, element, observation, recorded);
    // The walk bypasses BaseVisualChange's action boundary, which flushes earlier evidence.
    await beginPostActionCaptureAction();
    const result = await this.context.runRecorded("focusNavigate", args, observation, () =>
      this.context.focusNavigator().execute({
        ...args,
        ...pinnedFocusOptions(until, this.context.focusTargetResolver ?? defaultTargetResolver),
        ...(signal ? { signal } : {}),
      }),
    );
    if (!result.success) {
      logger.info(
        `[Explore] D-pad focus did not reach ${JSON.stringify(until)}: ${result.message}`,
      );
      return false;
    }
    // A tap waits for the UI to change; the select key does not. Settle while the record is
    // still live, so the navigation it causes is attributed to it before explore moves on.
    await awaitWhileRequestIsLive(this.context.timer.sleep(FOCUS_SELECT_SETTLE_MS), signal);
    return true;
  }

  /**
   * The recorded walk to `until`: a recorded edge's own walk options, else explore's select, along
   * the rail for a card an advance revealed in one, so the edge replays from the rail's initial
   * viewport.
   */
  private focusWalkArgs(
    until: FocusNavigateTarget,
    element: Element,
    observation: ObserveResult,
    recorded: Pick<ToolCallInteraction, "toolName" | "args"> | undefined,
  ) {
    const direction = recorded
      ? undefined
      : this.context.revealedRows.railDirectionFor(element, observation);
    return {
      ...focusSelectArgs(until),
      ...(direction ? { direction } : {}),
      ...recordedFocusWalkOptions(recorded),
    };
  }

  /**
   * The D-pad counterpart of swiping a scrollable container: press down a vertical list (right
   * along a rail) until a row that was not on screen appears, within a press bound. True when rows
   * were revealed, false when the list is exhausted. The advance is not recorded: it scrolls in
   * place, and the walk to a revealed row is recorded when explore selects that row, along the
   * rail for a row revealed in a rail (see {@link RevealedListRows.railDirectionFor}).
   */
  private async advanceList(
    element: Element,
    observation: ObserveResult,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    await beginPostActionCaptureAction();
    const result = await this.context.runRecorded(null, {}, observation, () =>
      this.context.focusListAdvancer().execute({
        container: element.bounds,
        ...(signal ? { signal } : {}),
      }),
    );
    if (result.success) {
      this.context.revealedRows.remember(element.bounds, result.direction, result.revealed);
    }
    logger.info(
      result.success
        ? `[Explore] D-pad ${result.direction} through ${element["resource-id"] || element["class"]} revealed ${result.revealed.length} row(s) in ${result.presses} press(es)`
        : `[Explore] D-pad list ${element["resource-id"] || element["class"]} exhausted: ${result.message}`,
    );
    return result.success;
  }
}
