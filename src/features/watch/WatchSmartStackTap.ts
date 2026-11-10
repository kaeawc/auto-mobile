import type {
  Element,
  ViewHierarchyResult,
  TapOnElementOptions,
  TapOnElementResult,
} from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { DefaultElementParser } from "../utility/ElementParser";
import type { WatchRunnerClient } from "./WatchRunnerClient";
import { parseSmartStackWidgetIdentifier, parseWatchClockFaceDump } from "./WatchSmartStack";

/** Optional capability probe; only a header or a parsed card identifies an open stack. */
export async function readOpenSmartStack(
  client: WatchRunnerClient,
  now: () => number,
  signal?: AbortSignal,
): Promise<ReturnType<typeof parseWatchClockFaceDump> | undefined> {
  try {
    const dump = await client.request({ type: "face", op: "dump" }, signal, { timeoutMs: 2000 });
    if (typeof dump !== "string") {
      throw new Error("Clockface dump was not text");
    }
    const { hierarchy, smartStack } = parseWatchClockFaceDump(dump, { timestamp: now() });
    return smartStack.header || smartStack.cards.length > 0 ? { hierarchy, smartStack } : undefined;
  } catch (error) {
    // Safe to swallow because this optional capability probe leaves the existing app path available.
    logger.debug(`Smart Stack tap preflight unavailable: ${errorMessage(error)}`);
    return undefined;
  }
}

/** Whether screen-absolute bounds are non-empty and lie entirely within the screen. */
function isOnScreen(bounds: Element["bounds"], hierarchy: ViewHierarchyResult): boolean {
  const { left, top, right, bottom } = bounds;
  return (
    right > left &&
    bottom > top &&
    left >= 0 &&
    top >= 0 &&
    right <= hierarchy.screenWidth! &&
    bottom <= hierarchy.screenHeight!
  );
}

/** Shared flattening and on-screen filtering for app and clockface tap candidates. */
export function watchHierarchyElements(hierarchy: ViewHierarchyResult): {
  all: Element[];
  available: Element[];
} {
  const all = new DefaultElementParser()
    .flattenViewHierarchy(hierarchy)
    .map((entry) => entry.element);
  const available = all.filter((element) => isOnScreen(element.bounds, hierarchy));
  return { all, available };
}

export function matches(
  element: Element,
  selector: { elementId?: string; text?: string },
): boolean {
  return (
    (selector.elementId !== undefined || selector.text !== undefined) &&
    (selector.elementId === undefined ||
      element["resource-id"] === selector.elementId ||
      element["view-id"] === selector.elementId) &&
    (selector.text === undefined || element.text === selector.text)
  );
}

/**
 * The runner exposes a populated text field's value (or a placeholder) as a same-type, same-bounds
 * child that repeats the field's identifier. An identifier match must count the field once, or an
 * index over several fields sharing an identifier lands on the first field's alias.
 */
function dropIdentifierAliases(candidates: readonly Element[]): Element[] {
  const seen = new Set<string>();
  return candidates.filter((element) => {
    const { left, top, right, bottom } = element.bounds;
    const key = `${element["resource-id"] ?? element["view-id"]}|${element.class}|${left},${top},${right},${bottom}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function matchWatchTapCandidates(
  available: readonly Element[],
  selector: { elementId?: string; text?: string },
): Element[] {
  const matched = available.filter((element) => matches(element, selector));
  return selector.elementId !== undefined ? dropIdentifierAliases(matched) : matched;
}

/** Face taps use fractions of the clockface screen, while callers supply XCTest points. */
export async function tapSmartStackAt(
  client: WatchRunnerClient,
  hierarchy: ViewHierarchyResult,
  point: { x: number; y: number },
  signal?: AbortSignal,
): Promise<void> {
  const { screenWidth, screenHeight } = hierarchy;
  if (
    !screenWidth ||
    !screenHeight ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x > screenWidth ||
    point.y > screenHeight
  ) {
    throw new ActionableError(
      "Smart Stack tap is outside the screen; use coordinates in points within the watch screen.",
    );
  }
  await client.request(
    { type: "face", op: "tap", x: point.x / screenWidth, y: point.y / screenHeight },
    signal,
  );
}

export async function tapSmartStackOn(
  client: WatchRunnerClient,
  { hierarchy, smartStack }: ReturnType<typeof parseWatchClockFaceDump>,
  options: TapOnElementOptions,
  signal?: AbortSignal,
): Promise<TapOnElementResult> {
  const { all, available } = watchHierarchyElements(hierarchy);
  // Card bounds are screen-absolute, so off-screen cards are dropped before the index applies.
  const cards = smartStack.cards
    .filter((card) => isOnScreen(card.bounds, hierarchy))
    .map((card) => {
      const cell = all.find((element) => {
        const identifier = element["resource-id"];
        return (
          identifier !== undefined &&
          (card.type === "widget"
            ? parseSmartStackWidgetIdentifier(identifier)?.cellId === card.cellId
            : identifier === `StackCollectionView${card.cellKind}`)
        );
      });
      return { card, cell };
    })
    .filter(
      ({ card, cell }) =>
        (options.text !== undefined && card.texts.includes(options.text)) ||
        (options.elementId !== undefined && cell?.["resource-id"] === options.elementId),
    );
  const matched = matchWatchTapCandidates(available, options)[options.index ?? 0];
  const selected = cards[options.index ?? 0];
  const element = cards.length > 0 ? (selected?.cell ?? (selected ? matched : undefined)) : matched;
  if (!element) {
    throw new ActionableError(
      "The Smart Stack is open, but no element matched. To observe it, call the face dump, use tapAt with coordinates in points, or call launchApp to bring the host app forward.",
    );
  }
  // Widget descendants use cell-local frames; only the parsed card bounds are screen-absolute.
  const { left, top, right, bottom } = selected?.card.bounds ?? element.bounds;
  await tapSmartStackAt(
    client,
    hierarchy,
    { x: (left + right) / 2, y: (top + bottom) / 2 },
    signal,
  );
  return { success: true, action: "tap", element };
}
