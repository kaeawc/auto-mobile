import { installInMemoryNavManager } from "../helpers/navigationTestHarness";
import { FakeNavigationGraphManager } from "../fakes/FakeNavigationGraphManager";
import { runNavigationGraphContract } from "./NavigationGraphContract";

// The real manager runs over createTestDatabase() (in-memory SQLite) via the navigation harness,
// which also stubs the post-commit telemetry write; never the file-backed database (#11868).
runNavigationGraphContract("FakeNavigationGraphManager", async () => ({
  graph: new FakeNavigationGraphManager(),
}));
runNavigationGraphContract("NavigationGraphManager (in-memory DB)", async () => {
  const harness = await installInMemoryNavManager();
  return { graph: harness.manager, dispose: harness.dispose };
});
