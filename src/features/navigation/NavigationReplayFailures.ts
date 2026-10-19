import { edgeActionKey, edgePairKey, storedEdgeActionKey } from "../../db/edgeReplayKey";
import type { NavigationEdge as DBNavigationEdge } from "../../db/types";
import type { NavigationEdge } from "../../utils/interfaces/NavigationGraph";

/** Consecutive navigateTo calls whose scroll search missed an edge target before demotion (#10154). */
const EDGE_TARGET_MISS_DEMOTION_THRESHOLD = 2;

/** Advisory replay ranking and consecutive target-miss accounting for one graph. */
export class NavigationReplayFailures {
  // Edge actions whose replay by navigateTo did not reach the edge's target (#10031),
  // per (app, from, to) pair. In-memory on purpose: it is advisory ranking state that
  // a daemon restart may forget (the edge is simply tried again), not graph data, so it
  // needs no column or migration. Cleared when the edge works or is re-recorded.
  private failedEdgeReplays: Map<string, Set<string>> = new Map();

  // Consecutive navigateTo calls whose replay of an edge found its target missing even
  // after a bounded scroll search (#10154), per (app, from, to) pair then action. One
  // miss may only mean the list is positioned differently; repeated misses promote the
  // edge into `failedEdgeReplays` so later calls stop paying for the search. A replay
  // that reaches its target clears the count.
  private edgeTargetMisses: Map<string, Map<string, number>> = new Map();
  public recordEdgeReplayOutcome(
    appId: string | null,
    edge: NavigationEdge,
    reached: boolean,
  ): void {
    if (!appId) {
      return;
    }
    const pairKey = edgePairKey(appId, edge.from, edge.to);
    const actionKey = edgeActionKey(edge.interaction?.toolName, edge.interaction?.args);
    if (reached) {
      this.forgetFailedEdgeReplay(pairKey, actionKey);
      this.forgetEdgeTargetMisses(pairKey, actionKey);
      return;
    }
    this.addFailedEdgeReplay(pairKey, actionKey);
  }

  private addFailedEdgeReplay(pairKey: string, actionKey: string): void {
    const actions = this.failedEdgeReplays.get(pairKey) ?? new Set<string>();
    actions.add(actionKey);
    this.failedEdgeReplays.set(pairKey, actions);
  }

  /** Whether `edge`'s action is currently remembered as failed (ranked last by findPath). */
  public hasEdgeReplayFailure(appId: string | null, edge: NavigationEdge): boolean {
    if (!appId) {
      return false;
    }
    const actions = this.failedEdgeReplays.get(edgePairKey(appId, edge.from, edge.to));
    return actions?.has(edgeActionKey(edge.interaction?.toolName, edge.interaction?.args)) ?? false;
  }

  /**
   * End of a navigateTo call in which replaying `edge` failed only because its target
   * was not on screen, and the call remembered that as a failure so the fallback edge
   * would rank first (#10154). The call-scoped failure is forgotten unless this was
   * the edge's `EDGE_TARGET_MISS_DEMOTION_THRESHOLD`th consecutive call whose scroll
   * `searched` for the target without finding it, which keeps the failure so later
   * calls try the edge last until it next reaches its target. A failure without a
   * search (the search was refused or skipped) never counts towards demotion.
   */
  public settleTransientEdgeFailure(
    appId: string | null,
    edge: NavigationEdge,
    searched: boolean,
  ): void {
    if (!appId) {
      return;
    }
    const pairKey = edgePairKey(appId, edge.from, edge.to);
    const actionKey = edgeActionKey(edge.interaction?.toolName, edge.interaction?.args);
    const misses = searched ? this.countEdgeTargetMiss(pairKey, actionKey) : 0;
    if (misses < EDGE_TARGET_MISS_DEMOTION_THRESHOLD) {
      this.forgetFailedEdgeReplay(pairKey, actionKey);
    }
  }

  private countEdgeTargetMiss(pairKey: string, actionKey: string): number {
    const actions = this.edgeTargetMisses.get(pairKey) ?? new Map<string, number>();
    const count = (actions.get(actionKey) ?? 0) + 1;
    actions.set(actionKey, count);
    this.edgeTargetMisses.set(pairKey, actions);
    return count;
  }

  private forgetEdgeTargetMisses(pairKey: string, actionKey: string): void {
    const actions = this.edgeTargetMisses.get(pairKey);
    if (actions?.delete(actionKey) && actions.size === 0) {
      this.edgeTargetMisses.delete(pairKey);
    }
  }

  forgetFailedEdgeReplay(pairKey: string, actionKey: string): void {
    const actions = this.failedEdgeReplays.get(pairKey);
    if (actions?.delete(actionKey) && actions.size === 0) {
      this.failedEdgeReplays.delete(pairKey);
    }
  }

  isEdgeReplayFailed(appId: string | null, edge: DBNavigationEdge): boolean {
    if (!appId || this.failedEdgeReplays.size === 0) {
      return false;
    }
    const actions = this.failedEdgeReplays.get(
      edgePairKey(appId, edge.from_screen, edge.to_screen),
    );
    // Only pairs with a remembered failure pay for parsing the stored tool args.
    return (
      actions !== undefined && actions.has(storedEdgeActionKey(edge.tool_name, edge.tool_args))
    );
  }

  clear(): void {
    this.failedEdgeReplays.clear();
    this.edgeTargetMisses.clear();
  }
}
