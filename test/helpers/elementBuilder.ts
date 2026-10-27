import type { Element } from "../../src/models/Element";

/** Placeholder rect for fixtures that do not care where the element is. */
const DEFAULT_BOUNDS: Element["bounds"] = { left: 0, top: 0, right: 0, bottom: 0 };

/**
 * Typed `Element` builder: a complete real `Element` with a default rect, plus the attributes the
 * test cares about. Use it instead of a partial literal that omits the required `bounds`.
 */
export function buildElement(overrides: Partial<Element> = {}): Element {
  return { bounds: DEFAULT_BOUNDS, ...overrides };
}
