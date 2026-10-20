import { type SwipeDirection } from "../../models";
import type { TransientEdgeFailure } from "./replayScrollSearch";

/**
 * What the replay scroll searches of ONE navigateTo call have done so far: the time
 * they spent (capped across steps), the direction the last failed search scrolled
 * (the list is left wherever that search ended), and the edges that call must settle.
 */
export class ReplayRunState {
  searchMs = 0;
  disturbedDirection: SwipeDirection | undefined;
  readonly transientFailures: TransientEdgeFailure[] = [];
}
