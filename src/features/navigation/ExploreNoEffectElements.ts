import { createHash } from "node:crypto";
import { isTruthy, type Element, type ViewHierarchyResult } from "../../models";
import { logger } from "../../utils/logger";
import { centreInside } from "../action/FocusListAdvance";
import { getElementKey } from "./ExploreElementExtraction";

/**
 * An element's identity from its own properties, without resolving a selector
 * in the hierarchy (which costs a tree search per element, every round).
 */
const keyOf = (element: Element): string => getElementKey(element);

/**
 * The screen explore is choosing from, in two grains:
 * - `exact`: the navigation-graph screen, the package and the keys of every
 *   navigation candidate (soft-keyboard windows already removed). Focus,
 *   selection highlight and the IME do not change it, so an interaction that
 *   only opened the keyboard or moved focus leaves it as it was.
 * - `screen`: the navigation-graph screen when the app reports one; otherwise
 *   (no SDK, every screen reads "unknown") the package and the candidates
 *   outside scrollable lists, so scrolling a list or rail stays on one screen.
 */
export interface ExploreScreenIdentity {
  exact: string;
  screen: string;
}

function digest(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

export function exploreScreenIdentity(
  graphScreen: string | null,
  candidates: Element[],
  hierarchy: Pick<ViewHierarchyResult, "packageName"> | undefined,
): ExploreScreenIdentity {
  const screenName = graphScreen ?? "unknown";
  const packageName = hierarchy?.packageName ?? "";
  const exact = digest([screenName, packageName, ...candidates.map(keyOf).sort()]);
  if (screenName !== "unknown") {
    return { exact, screen: `screen:${screenName}` };
  }
  const lists = candidates.filter((element) => isTruthy(element.scrollable));
  const fixed = candidates.filter(
    (element) =>
      !lists.some((list) => list !== element && centreInside(element.bounds, list.bounds)),
  );
  return { exact, screen: digest([packageName, ...fixed.map(keyOf).sort()]) };
}

interface PendingInteraction {
  identity: ExploreScreenIdentity;
  key: string;
}

/**
 * Elements whose interaction left the screen unchanged, per screen (#17442).
 * Such an element is not selected again on that screen, so explore moves on to
 * the other rows and cards instead of re-selecting the same top-scored element
 * every round. An interaction is settled on the next screen explore chooses
 * from, after any keyboard it opened was hidden.
 */
export class ExploreNoEffectElements {
  private readonly byScreen = new Map<string, Set<string>>();
  private pending: PendingInteraction | null = null;
  /** The screen the last selection chose from. */
  private current: ExploreScreenIdentity | null = null;

  clear(): void {
    this.byScreen.clear();
    this.pending = null;
    this.current = null;
  }

  /**
   * Settle the last interaction against the screen explore now chooses from,
   * and return its candidates not known to leave it unchanged.
   */
  selectable(
    graphScreen: string | null,
    candidates: Element[],
    hierarchy: ViewHierarchyResult | undefined,
  ): Element[] {
    const identity = exploreScreenIdentity(graphScreen, candidates, hierarchy);
    this.settle(identity);
    this.current = identity;
    return this.withEffect(candidates, identity);
  }

  /**
   * After an interaction with an element selected by {@link selectable}: a
   * dispatched action is judged by the next screen, while a failed one is left
   * to explore's stuck-screen count.
   */
  interacted(element: Element, dispatched: boolean): void {
    const current = this.current;
    this.current = null;
    if (dispatched && current) {
      this.begin(current, element);
    }
  }

  /** Remember the element whose action was dispatched on the screen `identity`. */
  begin(identity: ExploreScreenIdentity, element: Element): void {
    this.pending = { identity, key: keyOf(element) };
  }

  /**
   * Settle the last interaction against the screen explore now chooses from:
   * an unchanged exact identity marks its element as having no effect there.
   */
  settle(identity: ExploreScreenIdentity): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending || pending.identity.exact !== identity.exact) {
      return;
    }
    const keys = this.byScreen.get(pending.identity.screen) ?? new Set<string>();
    keys.add(pending.key);
    this.byScreen.set(pending.identity.screen, keys);
    logger.info(`[Explore] '${pending.key}' did not change the screen; not selecting it again`);
  }

  /** The elements not known to leave the screen `identity` unchanged. */
  withEffect(elements: Element[], identity: ExploreScreenIdentity): Element[] {
    const noEffect = this.byScreen.get(identity.screen);
    if (!noEffect) {
      return elements;
    }
    return elements.filter((element) => !noEffect.has(keyOf(element)));
  }
}
