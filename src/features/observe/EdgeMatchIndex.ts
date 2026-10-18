import type { NavigationEdge } from "../navigation/NavigationGraphManager";
import { normalizeIdentifier } from "../../utils/predictionUtils";
import type { IndexedEdge, InteractableElement } from "./PredictiveUIState";

export class EdgeMatchIndex {
  // tapOn: keyed by normalized args.text / element id.
  private readonly tapByText = new Map<string, IndexedEdge>();
  private readonly tapById = new Map<string, IndexedEdge>();
  // swipeOn: keyed by normalized container text / id / content-desc.
  private readonly swipeByText = new Map<string, IndexedEdge>();
  private readonly swipeById = new Map<string, IndexedEdge>();
  private readonly swipeByDesc = new Map<string, IndexedEdge>();

  constructor(edges: NavigationEdge[]) {
    edges.forEach((edge, index) => {
      const toolName = edge.interaction?.toolName;
      if (toolName === "tapOn") {
        this.indexTapEdge(edge, index);
      } else if (toolName === "swipeOn") {
        this.indexSwipeEdge(edge, index);
      }
    });
  }

  private indexTapEdge(edge: NavigationEdge, index: number): void {
    const args = edge.interaction?.args;
    this.addKey(this.tapByText, normalizeIdentifier(args?.text), edge, index);
    this.addKey(this.tapById, normalizeIdentifier(args?.elementId ?? args?.id), edge, index);
  }

  private indexSwipeEdge(edge: NavigationEdge, index: number): void {
    const args = edge.interaction?.args;
    const container = args?.container || edge.interaction?.uiState?.scrollPosition?.container;
    if (!container) {
      return;
    }
    this.addKey(this.swipeByText, normalizeIdentifier(container.text), edge, index);
    this.addKey(
      this.swipeById,
      normalizeIdentifier(container.elementId || container.resourceId),
      edge,
      index,
    );
    this.addKey(this.swipeByDesc, normalizeIdentifier(container.contentDesc), edge, index);
  }

  // First edge wins for a given key (preserves edge-order tie-breaking); empty
  // keys are skipped, matching the old `if (!normalized) return false` guards.
  private addKey(
    map: Map<string, IndexedEdge>,
    key: string | undefined,
    edge: NavigationEdge,
    index: number,
  ): void {
    if (!key || map.has(key)) {
      return;
    }
    map.set(key, { edge, index });
  }

  findMatch(interactable: InteractableElement): NavigationEdge | undefined {
    const text = normalizeIdentifier(interactable.text);
    const contentDesc = normalizeIdentifier(interactable.contentDesc);
    const resourceId = normalizeIdentifier(interactable.resourceId);

    let best: IndexedEdge | undefined;
    const consider = (candidate?: IndexedEdge): void => {
      if (candidate && (!best || candidate.index < best.index)) {
        best = candidate;
      }
    };

    if (interactable.clickable) {
      // tapOn: args.text matches the interactable's text or content-desc; an
      // element id matches its resource id.
      if (text) {
        consider(this.tapByText.get(text));
      }
      if (contentDesc) {
        consider(this.tapByText.get(contentDesc));
      }
      if (resourceId) {
        consider(this.tapById.get(resourceId));
      }
    }

    if (interactable.scrollable) {
      // swipeOn: container text matches text/content-desc; container id matches
      // resource id; container content-desc matches content-desc.
      if (text) {
        consider(this.swipeByText.get(text));
      }
      if (contentDesc) {
        consider(this.swipeByText.get(contentDesc));
        consider(this.swipeByDesc.get(contentDesc));
      }
      if (resourceId) {
        consider(this.swipeById.get(resourceId));
      }
    }

    return best?.edge;
  }
}
