import {
  Element,
  ElementBounds,
  ObserveResult,
  ScreenSize,
  ViewHierarchyResult,
} from "../../models";
import { SelectedElement, SelectedElementDetection } from "../../utils/interfaces/NavigationGraph";
import { ScreenshotUtils, screenshotUtilsAdapter } from "../../utils/ScreenshotUtilsAdapter";
import { ImageUtils } from "../../utils/interfaces/ImageUtils";
import { JimpImageUtils } from "../../utils/image-utils";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { TapEffect } from "../../models/TapOnElementResult";
import { SearchableHierarchy } from "../utility/SearchableNode";
import { resolveViewHierarchyForSearch } from "../utility/viewHierarchySearch";
import { boundsArea, intersectBounds } from "../../utils/bounds";
import { UIStateExtractor } from "./UIStateExtractor";

interface VisualSelectionConfig {
  minDifferencePercent?: number;
  minElementSizePx?: number;
  pixelmatchThreshold?: number;
  confidenceScale?: number;
}

const DEFAULT_VISUAL_SELECTION_CONFIG: Required<VisualSelectionConfig> = {
  minDifferencePercent: 1,
  minElementSizePx: 4,
  pixelmatchThreshold: 0.1,
  confidenceScale: 5,
};

/**
 * How much of the tapped element's pre-tap bounds a post-tap node must cover to count as the same
 * element. Selection styling can nudge or resize a tab or row by a few pixels, so this is not
 * exact equality; a same-text node elsewhere (a screen title that repeats the row's label) covers
 * none of it.
 */
const MIN_TAPPED_BOUNDS_OVERLAP_FRACTION = 0.75;

interface SelectionStateDetectorOptions {
  screenshotUtils?: ScreenshotUtils;
  imageUtils?: ImageUtils;
  config?: VisualSelectionConfig;
}

export interface SelectionDetectionContext {
  currentObservation?: ObserveResult;
  previousObservation?: ObserveResult | null;
  tappedElement?: Element;
  beforeScreenshotPath?: string | null;
  afterScreenshotPath?: string | null;
  /** The tap flow's own screen-change verdict for this action, when it computed one. */
  tapEffect?: TapEffect;
}

/**
 * A tap navigated away when the tap flow's screen identity or active window changed. A bare
 * `viewHierarchy changed` is deliberately not navigation: switching a tab swaps the content below
 * it without leaving the screen, and the element-presence check covers a destination screen that
 * lacks the tapped element.
 */
export function tapNavigatedAwayFromScreen(effect: TapEffect | undefined): boolean {
  return (
    effect?.screenChanged === true &&
    (effect.basis === "screenIdentity changed" || effect.basis === "activeWindow changed")
  );
}

/** An identifier the tapped element does not have constrains nothing; one it has must match. */
function identifierMatches(expected: string | undefined, actual: string | undefined): boolean {
  return !expected || expected === actual;
}

/** A node without bounds cannot be placed, so it is not evidence the tapped element stayed. */
function coversMostOfTappedBounds(tapped: ElementBounds, node: ElementBounds | undefined): boolean {
  const tappedArea = boundsArea(tapped);
  if (!node || tappedArea <= 0) {
    return false;
  }
  const shared = intersectBounds(tapped, node);
  return shared !== null && boundsArea(shared) / tappedArea >= MIN_TAPPED_BOUNDS_OVERLAP_FRACTION;
}

export interface SelectionStateDetectorLike {
  detectSelectedElements(context: SelectionDetectionContext): Promise<SelectedElement[]>;
}

export class SelectionStateDetector implements SelectionStateDetectorLike {
  private screenshotUtils: ScreenshotUtils;
  private imageUtils: ImageUtils;
  private config: Required<VisualSelectionConfig>;

  constructor(options: SelectionStateDetectorOptions = {}) {
    this.screenshotUtils = options.screenshotUtils ?? screenshotUtilsAdapter;
    this.imageUtils = options.imageUtils ?? new JimpImageUtils();
    this.config = {
      ...DEFAULT_VISUAL_SELECTION_CONFIG,
      ...options.config,
    };
  }

  async detectSelectedElements(context: SelectionDetectionContext): Promise<SelectedElement[]> {
    const currentObservation = context.currentObservation;
    if (!currentObservation?.viewHierarchy) {
      return [];
    }

    const accessibilityState = new UIStateExtractor().extract(currentObservation.viewHierarchy);
    if (accessibilityState?.selectedElements?.length) {
      const selectedElements = this.applySelectedState(accessibilityState.selectedElements, {
        method: "accessibility",
        confidence: 1,
        reason: "selected attribute present in view hierarchy",
      });
      logger.info(
        `[SELECTION_STATE] Using accessibility selected state (${selectedElements.length} element(s))`,
      );
      return selectedElements;
    }

    return this.detectVisualFallback(context, currentObservation);
  }

  private async detectVisualFallback(
    context: SelectionDetectionContext,
    currentObservation: ObserveResult,
  ): Promise<SelectedElement[]> {
    const { tappedElement, beforeScreenshotPath, afterScreenshotPath } = context;
    if (!tappedElement) {
      logger.debug("[SELECTION_STATE] Visual fallback skipped: no tapped element provided");
      return [];
    }

    if (!beforeScreenshotPath || !afterScreenshotPath) {
      logger.debug("[SELECTION_STATE] Visual fallback skipped: missing before/after screenshots");
      return [];
    }

    const selectedElement = this.buildSelectedElement(tappedElement);
    if (!selectedElement) {
      logger.debug("[SELECTION_STATE] Visual fallback skipped: tapped element lacks identifiers");
      return [];
    }

    const skipReason = this.visualFallbackSkipReason(
      selectedElement,
      tappedElement.bounds,
      context.tapEffect,
      currentObservation.viewHierarchy,
    );
    if (skipReason) {
      logger.debug(`[SELECTION_STATE] Visual fallback skipped: ${skipReason}`);
      return [];
    }

    const visualResult = await this.detectVisualSelection(
      tappedElement.bounds,
      beforeScreenshotPath,
      afterScreenshotPath,
      context.previousObservation?.screenSize,
      currentObservation.screenSize,
    );

    if (!visualResult) {
      return [];
    }

    const detection: SelectedElementDetection = {
      method: "visual",
      confidence: visualResult.confidence,
      reason: visualResult.reason,
    };

    logger.info(
      `[SELECTION_STATE] Using visual fallback for ${this.describeElement(selectedElement)} ` +
        `(diff=${visualResult.differencePercent.toFixed(2)}%, confidence=${visualResult.confidence})`,
    );

    return [
      {
        ...selectedElement,
        selectedState: detection,
      },
    ];
  }

  /**
   * The visual signal measures pixels under the PRE-tap bounds. After a navigation, or once the
   * tapped element is gone, those pixels belong to other content, so a difference there says
   * nothing about the tapped element.
   */
  private visualFallbackSkipReason(
    selectedElement: SelectedElement,
    bounds: ElementBounds,
    tapEffect: TapEffect | undefined,
    viewHierarchy: ViewHierarchyResult | undefined,
  ): string | null {
    if (tapNavigatedAwayFromScreen(tapEffect)) {
      return `tap navigated (${tapEffect?.basis})`;
    }
    if (!this.isStillPresent(selectedElement, bounds, viewHierarchy)) {
      return `${this.describeElement(selectedElement)} is not in the post-tap hierarchy`;
    }
    return null;
  }

  private applySelectedState(
    selectedElements: SelectedElement[],
    selectedState: SelectedElementDetection,
  ): SelectedElement[] {
    return selectedElements.map((element) => ({
      ...element,
      selectedState: element.selectedState ?? selectedState,
    }));
  }

  private buildSelectedElement(element: Element): SelectedElement | null {
    const selected: SelectedElement = {
      text: element.text,
      resourceId: element["resource-id"],
      contentDesc: element["content-desc"],
    };

    if (!selected.text && !selected.resourceId && !selected.contentDesc) {
      return null;
    }

    return selected;
  }

  /**
   * Whether a node carrying every identifier the tapped element has (text, resource-id,
   * content-desc — the identity SelectedElement and the navigation graph use across observations)
   * exists in the post-tap hierarchy AND sits where the tapped element was. Bounds alone are not
   * identity (new content can sit at old bounds), nor are identifiers alone: a text-only row that
   * navigated to a screen titled with the same text matches by identifier, but that node is
   * elsewhere. Apps that keep one activity across navigation give the tap flow no other signal.
   */
  private isStillPresent(
    identity: SelectedElement,
    tappedBounds: ElementBounds,
    viewHierarchy: ViewHierarchyResult | undefined,
  ): boolean {
    if (!viewHierarchy) {
      return false;
    }
    const nodes = new SearchableHierarchy().project(
      resolveViewHierarchyForSearch(viewHierarchy) ?? viewHierarchy,
    );
    return nodes.some(
      ({ properties, bounds }) =>
        identifierMatches(identity.text, properties.text) &&
        identifierMatches(identity.resourceId, properties["resource-id"]) &&
        identifierMatches(identity.contentDesc, properties["content-desc"]) &&
        coversMostOfTappedBounds(tappedBounds, bounds),
    );
  }

  private describeElement(element: SelectedElement): string {
    return element.text || element.resourceId || element.contentDesc || "unknown element";
  }

  private async detectVisualSelection(
    bounds: ElementBounds,
    beforeScreenshotPath: string,
    afterScreenshotPath: string,
    beforeScreenSize?: ScreenSize,
    afterScreenSize?: ScreenSize,
  ): Promise<{ differencePercent: number; confidence: number; reason: string } | null> {
    try {
      const beforeScreenshot = await this.screenshotUtils.getCachedScreenshot(beforeScreenshotPath);
      const afterScreenshot = await this.screenshotUtils.getCachedScreenshot(afterScreenshotPath);

      const beforeDimensions = await this.screenshotUtils.getImageDimensions(
        beforeScreenshot.buffer,
      );
      const afterDimensions = await this.screenshotUtils.getImageDimensions(afterScreenshot.buffer);

      if (
        beforeDimensions.width !== afterDimensions.width ||
        beforeDimensions.height !== afterDimensions.height
      ) {
        // Rotation or a resolution change: the same bounds no longer cover the same pixels.
        logger.debug(
          `[SELECTION_STATE] Visual fallback skipped: screenshot size changed ` +
            `${beforeDimensions.width}x${beforeDimensions.height} -> ` +
            `${afterDimensions.width}x${afterDimensions.height}`,
        );
        return null;
      }

      const beforeCrop = await this.cropElementRegion(
        beforeScreenshot.buffer,
        bounds,
        beforeScreenSize,
        beforeDimensions,
      );
      const afterCrop = await this.cropElementRegion(
        afterScreenshot.buffer,
        bounds,
        afterScreenSize,
        afterDimensions,
      );

      if (!beforeCrop || !afterCrop) {
        logger.debug(
          "[SELECTION_STATE] Visual fallback skipped: invalid element bounds for cropping",
        );
        return null;
      }

      const comparison = await this.screenshotUtils.compareImages(
        beforeCrop,
        afterCrop,
        this.config.pixelmatchThreshold,
        false,
      );

      if (!comparison.compared) {
        // Could not compare: unknown, not "changed" and not "unchanged". The comparator already
        // logged the underlying error; keep the trace attached to this decision too.
        logger.warn(`[SELECTION_STATE] Visual fallback skipped: ${comparison.error}`);
        return null;
      }

      const differencePercent = Math.max(0, 100 - comparison.similarity);
      if (differencePercent < this.config.minDifferencePercent) {
        logger.debug(
          `[SELECTION_STATE] Visual fallback skipped: diff ${differencePercent.toFixed(2)}% ` +
            `< threshold ${this.config.minDifferencePercent}%`,
        );
        return null;
      }

      const confidence = this.computeConfidence(differencePercent);
      return {
        differencePercent,
        confidence,
        reason: `visual diff ${differencePercent.toFixed(2)}% >= ${this.config.minDifferencePercent}%`,
      };
    } catch (error) {
      logger.warn(`[SELECTION_STATE] Visual fallback failed: ${errorMessage(error)}`, error);
      return null;
    }
  }

  private async cropElementRegion(
    buffer: Buffer,
    bounds: ElementBounds,
    screenSize: ScreenSize | undefined,
    imageDimensions: { width: number; height: number },
  ): Promise<Buffer | null> {
    const normalized = this.normalizeBounds(bounds, screenSize, imageDimensions);
    if (!normalized) {
      return null;
    }

    return this.imageUtils.crop(
      buffer,
      normalized.width,
      normalized.height,
      normalized.left,
      normalized.top,
    );
  }

  private normalizeBounds(
    bounds: ElementBounds,
    screenSize: ScreenSize | undefined,
    imageDimensions: { width: number; height: number },
  ): { left: number; top: number; width: number; height: number } | null {
    if (imageDimensions.width <= 0 || imageDimensions.height <= 0) {
      return null;
    }

    const scaleX = screenSize?.width ? imageDimensions.width / screenSize.width : 1;
    const scaleY = screenSize?.height ? imageDimensions.height / screenSize.height : 1;

    const left = Math.max(0, Math.floor(bounds.left * scaleX));
    const top = Math.max(0, Math.floor(bounds.top * scaleY));
    const right = Math.min(imageDimensions.width, Math.ceil(bounds.right * scaleX));
    const bottom = Math.min(imageDimensions.height, Math.ceil(bounds.bottom * scaleY));

    const width = right - left;
    const height = bottom - top;

    if (width < this.config.minElementSizePx || height < this.config.minElementSizePx) {
      return null;
    }

    return { left, top, width, height };
  }

  private computeConfidence(differencePercent: number): number {
    const normalized = Math.min(1, Math.max(0, differencePercent / this.config.confidenceScale));
    return Number(normalized.toFixed(2));
  }
}
