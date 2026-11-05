import { beforeEach, describe, expect, test } from "bun:test";
import type { InternalToolCaller } from "../../../src/features/navigation/InternalToolCaller";
import { NavigateTo } from "../../../src/features/navigation/NavigateTo";
import type { ForegroundObserver } from "../../../src/features/navigation/foregroundOverlay";
import type { InteractionInputMode } from "../../../src/features/navigation/focusDrivenInput";
import type { UIStateSetup } from "../../../src/features/navigation/interfaces/UIStateSetup";
import type { BootedDevice } from "../../../src/models";
import type { NavigationEdge } from "../../../src/utils/interfaces/NavigationGraph";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeNavigationGraphManager } from "../../fakes/FakeNavigationGraphManager";
import { FakeTimer } from "../../fakes/FakeTimer";

const device: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "TV" };
const noSetup: UIStateSetup = {
  setupUIState: async () => [],
  setupScrollPosition: async () => null,
};
const cleanForegroundObserver: ForegroundObserver = { execute: async () => ({}) };

function edge(from: string, to: string, toolName: string, args: Record<string, unknown>) {
  return {
    from,
    to,
    timestamp: 0,
    edgeType: "tool",
    interaction: { toolName, args, timestamp: 0 },
  } satisfies NavigationEdge;
}

/** Records every replayed call; each call lands on the next screen of the path. */
class RecordingToolCaller implements InternalToolCaller {
  readonly calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];

  constructor(
    private readonly graph: FakeNavigationGraphManager,
    private readonly arrivals: string[],
  ) {}

  getTool(name: string) {
    return { name };
  }

  async callInternal(tool: string | { name: string }, args: Record<string, unknown>) {
    const toolName = typeof tool === "string" ? tool : tool.name;
    this.calls.push({ toolName, args });
    const next = this.arrivals.shift();
    if (next) {
      this.graph.setCurrentScreenValue(next);
    }
    return { structuredContent: { success: true } };
  }

  async callInternalTyped() {
    return undefined;
  }
}

describe("NavigateTo on a focus-driven TV", () => {
  let graph: FakeNavigationGraphManager;
  let timer: FakeTimer;
  let caller: RecordingToolCaller;

  beforeEach(() => {
    graph = new FakeNavigationGraphManager();
    graph.setCurrentScreenValue("Home");
    graph.setPathResult({
      found: true,
      path: [
        edge("Home", "Movies", "tapOn", { selector: { text: "Movies" }, action: "tap" }),
        edge("Movies", "Details", "focusNavigate", {
          until: { resourceId: "app:id/first_title" },
          select: true,
        }),
      ],
      startScreen: "Home",
      targetScreen: "Details",
    });
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    caller = new RecordingToolCaller(graph, ["Movies", "Details"]);
  });

  function navigate(mode: InteractionInputMode) {
    return new NavigateTo(device, new FakeAdbClientFactory(), {
      uiStateSetup: noSetup,
      screenWaiter: { waitForScreen: async () => true },
      navigationManager: graph,
      timer,
      foregroundObserverProvider: () => cleanForegroundObserver,
      internalToolCaller: caller,
      inputMode: async () => mode,
    }).execute({ targetScreen: "Details", platform: "android" });
  }

  test("replays a recorded tap as D-pad focus and select, and a focus edge as recorded", async () => {
    const result = await navigate("dpad");
    expect(result.success).toBe(true);
    expect(caller.calls.map(({ toolName }) => toolName)).toEqual([
      "focusNavigate",
      "focusNavigate",
    ]);
    expect(caller.calls[0].args).toMatchObject({ until: { label: "Movies" }, select: true });
    expect(caller.calls[1].args).toMatchObject({
      until: { resourceId: "app:id/first_title" },
      select: true,
    });
    expect(result.path?.[0]).toBe('focusNavigate({"until":{"label":"Movies"},"select":true})');
  });

  test("touch input replays the tap unchanged", async () => {
    const result = await navigate("touch");
    expect(result.success).toBe(true);
    expect(caller.calls.map(({ toolName }) => toolName)).toEqual(["tapOn", "focusNavigate"]);
  });
});
