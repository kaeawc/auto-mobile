import type { ObserveToolDependencies } from "../../src/server/observeResponse";
import type { FakeObserveScreen } from "../fakes/FakeObserveScreen";

type ObserveToolScreen = ReturnType<NonNullable<ObserveToolDependencies["createScreen"]>>;

/**
 * Adapts a {@link FakeObserveScreen} to the screen `registerObserveTools` builds per call. The
 * device-read entry point has its own signature (`signal`, `screenshot`, ...) rather than
 * `execute`'s options bag, so it is adapted rather than aliased; the fake serves both from the
 * same configured observation.
 */
export function observeToolScreen(screen: FakeObserveScreen): ObserveToolScreen {
  return {
    execute: (options) => screen.execute(options),
    executeDeviceRead: () => screen.execute({}),
    captureScreenshot: (perf, signal, observation) =>
      screen.captureScreenshot(perf, signal, observation),
    appendRawViewHierarchy: screen.appendRawViewHierarchy.bind(screen),
    getMostRecentCachedObserveResult: screen.getMostRecentCachedObserveResult.bind(screen),
  };
}
