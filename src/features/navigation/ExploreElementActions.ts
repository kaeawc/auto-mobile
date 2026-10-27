import { BootedDevice, Element, ObserveResult } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { ProgressCallback } from "../action/BaseVisualChange";
import { logger } from "../../utils/logger";
import { SwipeOnElement } from "../action/SwipeOnElement";
import { TapAtCoordinate } from "../action/TapAtCoordinate";
import { TapOnElement } from "../action/TapOnElement";
import { Timer } from "../../utils/SystemTimer";
import { publicTapOnArgs, tapCoordinatesFor, tapSelectorFor } from "./ExploreElementExtraction";

interface ExplorationActionContext {
  device: BootedDevice;
  adb: AdbExecutor | undefined;
  timer: Timer;
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
}
