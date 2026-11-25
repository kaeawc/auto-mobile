import { logger } from "../../../src/utils/logger";
import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import {
  SetAccessibilityFocus,
  type TalkBackStateProbe,
} from "../../../src/features/accessibility/SetAccessibilityFocus";
import type {
  BootedDevice,
  ObserveResult,
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../src/models";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAccessibilityFocusService } from "../../fakes/FakeAccessibilityFocusService";

const device: BootedDevice = { deviceId: "a11y-hint", platform: "android", name: "Test" };
const resourceId = "com.example:id/title";

function observeResult(): ObserveResult {
  const bounds = { left: 0, top: 0, right: 100, bottom: 50 };
  const target: ViewHierarchyNode = { $: { "resource-id": resourceId, bounds } };
  const viewHierarchy: ViewHierarchyResult = {
    hierarchy: { node: { $: { bounds }, node: [target] } },
  };
  return {
    updatedAt: 1,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy,
  } as ObserveResult;
}

describe("SetAccessibilityFocus refused-action hint (#19194)", () => {
  let service: FakeAccessibilityFocusService;
  let observeScreen: FakeObserveScreen;
  let probeCalls: number;
  let warn: ReturnType<typeof spyOn>;
  let debug: ReturnType<typeof spyOn>;

  const run = (probe: TalkBackStateProbe, action: "set" | "clear" = "set") => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    return new SetAccessibilityFocus(device, {
      observeScreen,
      timer,
      serviceFactory: () => service,
      talkBackProbe: async (d) => {
        probeCalls++;
        expect(d).toBe(device);
        return probe(d);
      },
    }).execute({ action, resourceId });
  };

  beforeEach(() => {
    probeCalls = 0;
    service = new FakeAccessibilityFocusService();
    observeScreen = new FakeObserveScreen();
    observeScreen.setObserveResult(observeResult());
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    debug = spyOn(logger, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    debug.mockRestore();
  });

  test("names TalkBack when the framework refuses focus and TalkBack is off", async () => {
    service.setSetThrows(new Error("performAction returned false"));
    const result = await run(async () => false);
    expect(result.success).toBe(false);
    expect(result.error).toContain("because TalkBack is off");
    expect(result.error).toContain("accessibility {talkback:true}");
    expect(probeCalls).toBe(1);
  });

  test("hints TalkBack conditionally when its state is unknown", async () => {
    service.setClearThrows(new Error("performAction returned false"));
    const result = await run(async () => {
      throw new Error("adb offline");
    }, "clear");
    expect(result.error).toContain(
      "refused to clear accessibility focus (performAction returned false)",
    );
    expect(result.error).toContain("if TalkBack is off");
  });

  test("keeps the raw refusal when TalkBack is already on", async () => {
    service.setSetThrows(new Error("performAction returned false"));
    const result = await run(async () => true);
    expect(result.error).toBe("performAction returned false");
  });

  test("does not probe TalkBack for unrelated failures", async () => {
    service.setSetThrows(new Error("Element not found"));
    const result = await run(async () => false);
    expect(result.error).toBe("Element not found");
    expect(probeCalls).toBe(0);
  });
});
