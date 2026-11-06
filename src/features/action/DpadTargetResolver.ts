import type { FocusNavigateOptions, FocusNavigateTarget, FocusScreen } from "./FocusNavigate";
import type { ElementBounds } from "../../models/ElementBounds";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";

/**
 * Picks the element a touch tap would act on for this screen read: its bounds, null when nothing
 * matches, or undefined when this read cannot be resolved (no hierarchy), which leaves matching to
 * the focus loop.
 */
export interface DpadTargetResolver {
  resolve(screen: FocusScreen, target: FocusNavigateTarget): ElementBounds | null | undefined;
}

/**
 * Resolve with tapOn's own selector and the options its touch path uses for a plain text or
 * elementId tap, so hint-text fallback, ranking, actionable-ancestor promotion and synthetic ids
 * all agree between touch and D-pad.
 */
export class SelectorDpadTargetResolver implements DpadTargetResolver {
  constructor(private readonly selector: Pick<ElementSelector, "select">) {}

  resolve(screen: FocusScreen, target: FocusNavigateTarget): ElementBounds | null | undefined {
    if (!screen.hierarchy) {
      return undefined;
    }
    if (target.label) {
      const selection = this.selector.select(
        screen.hierarchy,
        { text: target.label },
        {
          partialMatch: true,
          caseSensitive: false,
          strategy: "first",
          intentAction: "inspect",
          allowHintFallback: true,
          selectionIntent: "tap",
        },
      );
      return selection.element?.bounds ?? null;
    }
    if (target.elementId) {
      const selection = this.selector.select(
        screen.hierarchy,
        { elementId: target.elementId },
        { partialMatch: false, strategy: "first", intentAction: "inspect" },
      );
      return selection.element?.bounds ?? null;
    }
    return undefined;
  }
}

/**
 * Focus walk options that pin a target named the way tapOn names one (only a `label` or only an
 * `elementId`) to the element tapOn would tap on each read, so a focused parent row never stands
 * in for an independently actionable child. The resolver reads that one field, so a target that
 * combines it with other fields keeps focusNavigate's own matching, which checks every field.
 */
export function pinnedFocusOptions(
  until: FocusNavigateTarget,
  resolver: DpadTargetResolver,
): Pick<FocusNavigateOptions, "firstMatch" | "pinTarget"> {
  const fields = Object.entries(until).filter(([, value]) => value !== undefined);
  const single = fields.length === 1 ? fields[0][0] : undefined;
  if (single !== "label" && single !== "elementId") {
    return {};
  }
  return { firstMatch: true, pinTarget: (screen) => resolver.resolve(screen, until) };
}
