import { BootedDevice, Element, ObserveResult } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { ProgressCallback } from "../action/BaseVisualChange";
import { logger } from "../../utils/logger";
import { SwipeOnElement } from "../action/SwipeOnElement";
import { TapAtCoordinate } from "../action/TapAtCoordinate";
import { TapOnElement } from "../action/TapOnElement";
import { Timer } from "../../utils/SystemTimer";
import { FocusNavigate } from "../action/FocusNavigate";
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

/** The production D-pad walk: fresh hierarchy reads and Android key presses. */
export function defaultFocusSelectNavigator(
  device: BootedDevice,
  observeScreen: Pick<ObserveScreen, "execute">,
  adbFactory: AdbClientFactory,
  timer: Timer,
): FocusSelectNavigator {
  const keys = new InputKey(device, { adbFactory, timer });
  return new FocusNavigate(
    createFocusNavigateObserver(observeScreen),
    { press: (key, signal) => keys.press(key, undefined, undefined, { signal }) },
    timer,
  );
}

interface ExplorationActionContext {
  device: BootedDevice;
  adb: AdbExecutor | undefined;
  timer: Timer;
  focusNavigator: () => FocusSelectNavigator;
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
   * A scrollable container is not selected: moving focus through it scrolls it. Validate mode
   * passes its edge's recorded interaction, so a recorded `focusNavigate` replays its `until`.
   */
  async focusSelectElement(
    element: Element,
    observation: ObserveResult,
    {
      signal,
      recorded,
    }: { signal?: AbortSignal; recorded?: Pick<ToolCallInteraction, "toolName" | "args"> } = {},
  ): Promise<boolean | null> {
    if (isTruthy(element.scrollable)) {
      logger.debug("[Explore] D-pad mode: skipping scrollable container; focus moves scroll it");
      return null;
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
    const args = { ...focusSelectArgs(until), ...recordedFocusWalkOptions(recorded) };
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
}
