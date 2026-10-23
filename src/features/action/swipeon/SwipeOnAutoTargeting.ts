import {
  BootedDevice,
  Element,
  ElementBounds,
  ObserveResult,
  SwipeDirection,
  SwipeOnOptions,
  SwipeOnResult,
  ScrollableCandidate,
} from "../../../models";
import { logger } from "../../../utils/logger";
import { AutoTargetSelectorService } from "./types";
import { buildContainerFromElement } from "../../utility/elementProperties";

/**
 * SwipeOnAutoTargeting - picks the scrollable container an auto-targeted swipe should drive.
 *
 * Extracted from SwipeOn (max-class-lines): candidate listing, the auto-target decision and
 * folding its warning into a result.
 */
export type AutoTargetDecision = {
  element?: Element;
  scrollFrame?: ElementBounds;
  container?: SwipeOnOptions["container"];
  warning?: string;
  scrollableCandidates?: ScrollableCandidate[];
};

export class SwipeOnAutoTargeting {
  constructor(
    private readonly device: BootedDevice,
    private readonly selector: () => AutoTargetSelectorService,
  ) {}

  buildScrollableCandidates(scrollables: Element[]): ScrollableCandidate[] {
    const candidates: ScrollableCandidate[] = [];
    const seen = new Set<string>();

    for (const scrollable of scrollables) {
      const candidate: ScrollableCandidate = {
        elementId: scrollable["resource-id"],
        text: scrollable.text,
        contentDesc: scrollable["content-desc"],
        className: scrollable.class,
      };

      if (
        !candidate.elementId &&
        !candidate.text &&
        !candidate.contentDesc &&
        !candidate.className
      ) {
        continue;
      }

      const key = `${candidate.elementId ?? ""}|${candidate.text ?? ""}|${candidate.contentDesc ?? ""}|${candidate.className ?? ""}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push(candidate);
    }

    return candidates;
  }

  resolveAutoTargetDecision({
    scrollables,
    candidates,
    observeResult,
    direction,
    includeSystemInsets,
  }: {
    scrollables: Element[];
    candidates: ScrollableCandidate[];
    observeResult?: ObserveResult;
    direction: SwipeDirection;
    includeSystemInsets?: boolean;
  }): AutoTargetDecision {
    if (scrollables.length === 0) {
      logger.info(`[SwipeOn] Mode: screen swipe (no scrollables found)`);
      return {};
    }
    const screenBounds = observeResult
      ? this.selector().getScreenBounds(observeResult, {
          platform: this.device.platform,
          includeSystemInsets,
        })
      : null;
    const element = this.selector().selectAutoTargetScrollable(
      scrollables,
      screenBounds,
      direction,
    );
    if (!element) {
      logger.info(
        `[SwipeOn] Mode: screen swipe (scrollables found but none matched direction=${direction})`,
      );
      return {
        warning:
          "Scrollable containers found but none matched the swipe direction; swiping the screen. Set autoTarget: false to force screen swipes.",
        scrollableCandidates: candidates,
      };
    }
    const container = buildContainerFromElement(element);
    if (!container && this.device.platform === "android") {
      logger.info(`[SwipeOn] Mode: element swipe (auto-target element has no usable identifier)`);
      return {
        element,
        warning:
          "Auto-targeted scrollable container lacks a usable identifier; swiping within its bounds without container metadata.",
        scrollableCandidates: candidates,
      };
    }
    if (!container) {
      logger.info(`[SwipeOn] Mode: screen swipe (auto-target element has no usable identifier)`);
      return {
        // Explicit system-inset inclusion preserves the full-screen fallback geometry.
        scrollFrame: includeSystemInsets ? undefined : element.bounds,
        warning:
          "Auto-targeted scrollable container lacks a usable identifier; swiping the screen. Provide container.elementId or container.text to target it explicitly.",
        scrollableCandidates: candidates,
      };
    }
    logger.info(
      `[SwipeOn] Mode: auto-target element swipe (container=${JSON.stringify(container)})`,
    );
    return {
      container,
      warning: `Auto-targeted scrollable container (${this.selector().describeContainer(container)}). Set autoTarget: false to force full-screen swipes.`,
      scrollableCandidates: candidates,
    };
  }

  withAutoTargetDecision({
    result,
    decision,
  }: {
    result: SwipeOnResult;
    decision: AutoTargetDecision;
  }): SwipeOnResult {
    if (!decision.warning) {
      return result;
    }
    return {
      ...result,
      warning: this.selector().mergeWarnings(result.warning, decision.warning),
      scrollableCandidates: decision.scrollableCandidates,
    };
  }
}
