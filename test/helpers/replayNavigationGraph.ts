import { FakeNavigationGraphManager } from "../fakes/FakeNavigationGraphManager";
import type { NavigationEdge } from "../../src/utils/interfaces/NavigationGraph";

/** A Home -> Detail graph whose only path is the given replayable edge. */
export function createReplayNavigationGraph(edge: NavigationEdge): FakeNavigationGraphManager {
  const graph = new FakeNavigationGraphManager();
  graph.setCurrentScreenValue("Home");
  for (const screenName of ["Home", "Detail"]) {
    graph.addNode({ screenName, firstSeenAt: 0, lastSeenAt: 0, visitCount: 1, backStackDepth: 0 });
  }
  graph.setPathResult({ found: true, path: [edge], startScreen: "Home", targetScreen: "Detail" });
  return graph;
}
