import { ActionableError } from "../../models/ActionableError";
import type { Element, TapOnElementOptions, TapOnElementResult } from "../../models";
import { DefaultElementParser } from "../utility/ElementParser";
import { normalizeTvosHierarchy } from "./TvosHierarchy";
import type { TvosRunnerClient } from "./TvosRunnerClient";
import { tvosRunners } from "./TvosRunnerRegistry";

type Direction = "up" | "down" | "left" | "right";

function focusKey(element: Element): string {
  const { left, top, right, bottom } = element.bounds;
  return JSON.stringify([element["resource-id"], left, top, right, bottom]);
}

function sameBounds(a: Element, b: Element): boolean {
  return (
    a.bounds.left === b.bounds.left &&
    a.bounds.top === b.bounds.top &&
    a.bounds.right === b.bounds.right &&
    a.bounds.bottom === b.bounds.bottom
  );
}

function directions(focus: Element, target: Element): Direction[] {
  const a = focus.bounds;
  const b = target.bounds;
  const dx = (b.left + b.right - a.left - a.right) / 2;
  const dy = (b.top + b.bottom - a.top - a.bottom) / 2;
  const horizontal: Direction[] = dx === 0 ? [] : [dx > 0 ? "right" : "left"];
  const vertical: Direction[] = dy === 0 ? [] : [dy > 0 ? "down" : "up"];
  const overlapsX = a.left < b.right && b.left < a.right;
  const overlapsY = a.top < b.bottom && b.top < a.bottom;
  const horizontalFirst = overlapsY ? true : overlapsX ? false : Math.abs(dx) >= Math.abs(dy);
  return horizontalFirst ? [...horizontal, ...vertical] : [...vertical, ...horizontal];
}

function validateOptions(options: TapOnElementOptions, maxMoves: number): void {
  const refused = Object.entries(options).filter(
    ([key, value]) =>
      value !== undefined &&
      (value !== false || key === "ensureChecked") &&
      !["action", "elementId", "text", "index"].includes(key),
  );
  if (options.action !== "tap" || refused.length) {
    throw new ActionableError(
      `tvOS tapOn supports only action tap and elementId, text, index; unsupported: ${
        options.action !== "tap" ? options.action : refused.map(([key]) => key).join(", ")
      }.`,
    );
  }
  if (options.index !== undefined && (!Number.isInteger(options.index) || options.index < 0)) {
    throw new ActionableError("tvOS tap index must be a non-negative integer.");
  }
  if (!Number.isInteger(maxMoves) || maxMoves < 0) {
    throw new ActionableError("tvOS maxMoves must be a non-negative integer.");
  }
}

function matches(element: Element, options: TapOnElementOptions): boolean {
  return (
    (options.elementId !== undefined || options.text !== undefined) &&
    (options.elementId === undefined ||
      element["resource-id"] === options.elementId ||
      element["view-id"] === options.elementId) &&
    (options.text === undefined || element.text === options.text)
  );
}

async function readFocusAndTarget(
  client: TvosRunnerClient,
  options: TapOnElementOptions,
  signal?: AbortSignal,
): Promise<{ focus: Element; target: Element }> {
  const hierarchy = normalizeTvosHierarchy(await client.hierarchy(signal));
  signal?.throwIfAborted();
  const all = new DefaultElementParser()
    .flattenViewHierarchy(hierarchy)
    .map(({ element }) => element);
  const candidates = all.filter((element) => {
    const { left, top, right, bottom } = element.bounds;
    return (
      right > left &&
      bottom > top &&
      left >= 0 &&
      top >= 0 &&
      right <= hierarchy.screenWidth! &&
      bottom <= hierarchy.screenHeight! &&
      matches(element, options)
    );
  });
  const target = candidates[options.index ?? 0];
  if (!target) {
    throw new ActionableError(
      "No tvOS element matched; observe and check the identifier, exact text or index.",
    );
  }
  const focus = all.find((element) => element.focused === "true");
  if (!focus) {
    throw new ActionableError(
      "Nothing is focused on tvOS; use pressButton to establish focus and observe before retrying tapOn.",
    );
  }
  return { focus, target };
}

function describe(element: Element): string {
  return element["resource-id"] || element.text || focusKey(element);
}

/** maxMoves is an internal navigation budget; the public tapOn schema is unchanged. */
export async function tvosTapOn(
  deviceId: string,
  options: TapOnElementOptions,
  signal?: AbortSignal,
  maxMoves = 30,
): Promise<TapOnElementResult> {
  validateOptions(options, maxMoves);
  signal?.throwIfAborted();
  const client = tvosRunners.require(deviceId);
  const blocked = new Map<string, Set<Direction>>();
  let previous: { key: string; direction: Direction } | undefined;
  for (let moves = 0; ; moves++) {
    signal?.throwIfAborted();
    const { focus, target } = await readFocusAndTarget(client, options, signal);
    if (sameBounds(focus, target)) {
      await client.request({ type: "request_press_button", action: "select" }, signal);
      return { success: true, action: "tap", element: target };
    }
    const key = focusKey(focus);
    const refused = blocked.get(key) ?? new Set<Direction>();
    if (previous?.key === key) {
      refused.add(previous.direction);
      blocked.set(key, refused);
    }
    const direction = directions(focus, target).find((value) => !refused.has(value));
    if (!direction) {
      throw new ActionableError(
        `tvOS focus stopped making progress from ${describe(focus)} toward ${describe(target)}; the target may be unreachable or in a focus trap. Observe and navigate with pressButton before retrying.`,
      );
    }
    if (moves >= maxMoves) {
      throw new ActionableError(
        `tvOS tapOn exceeded maxMoves (${maxMoves}) before reaching ${describe(target)}; observe and move closer with pressButton before retrying.`,
      );
    }
    await client.request({ type: "request_press_button", action: direction }, signal);
    previous = { key, direction };
  }
}
