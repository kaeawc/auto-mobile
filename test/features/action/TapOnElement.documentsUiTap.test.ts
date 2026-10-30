import type { TapCoordinatesRequest } from "../../../src/features/observe/shared/SharedGestureDelegate";
import { describe, expect, test, spyOn, afterEach, mock, beforeEach } from "bun:test";
import type { Element } from "../../../src/models";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeTalkBackTapStrategy } from "../../fakes/FakeTalkBackTapStrategy";
import { FakeTalkBackNavigationDriver } from "../../fakes/FakeTalkBackNavigationDriver";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { logger } from "../../../src/utils/logger";

afterEach(() => mock.restore());

let clientSpy: ReturnType<typeof spyOn<typeof AndroidCtrlProxyClient, "getInstance">>;
beforeEach(() => {
  clientSpy = spyOn(AndroidCtrlProxyClient, "getInstance");
});

function createTap(
  options: {
    supported?: boolean;
    success?: boolean;
    throws?: boolean;
    dispatchedTapFails?: boolean;
    talkBackStrategy?: FakeTalkBackTapStrategy;
    talkBackDriverFactory?: { createDriver: () => FakeTalkBackNavigationDriver };
  } = {},
) {
  const adb = new FakeAdbClient();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const gestures: TapCoordinatesRequest[] = [];
  const service = new FakeCtrlProxy(timer);
  service.setSupportsNodeActionSelectors(options.supported ?? true);
  service.setActionResult({ success: options.success ?? true, action: "click", totalTimeMs: 1 });
  if (options.throws) {
    service.setFailureMode("requestNodeAction", new Error("Runner disconnected"));
  }
  const requestTap = service.requestTapCoordinates.bind(service);
  service.requestTapCoordinates = async (request) => {
    gestures.push(request);
    if (options.dispatchedTapFails) {
      request.onDispatch?.();
      return { success: false, totalTimeMs: 1, error: "Tap timed out after 5000ms" };
    }
    return requestTap(request);
  };
  clientSpy.mockReturnValue(service);
  let tap: TapOnElement;
  try {
    tap = new TapOnElement(
      { name: "test-device", platform: "android", deviceId: "emulator-5554" },
      adb,
      {
        timer,
        talkBackStrategy: options.talkBackStrategy,
        talkBackDriverFactory: options.talkBackDriverFactory,
      },
    );
  } finally {
    clientSpy.mockRestore();
  }
  return {
    tap,
    adb,
    gestures,
    service,
  };
}

const row: Element = {
  "resource-id": "com.google.android.documentsui:id/item_root",
  "collection-row-index": 2,
  "collection-column-index": 1,
  actions: ["click", "long_click"],
  clickable: "true",
  bounds: { left: 0, top: 300, right: 1080, bottom: 460 },
};

async function execute(tap: TapOnElement, element = row, action = "tap") {
  await tap.executeAndroidTapWithCoordinates(action, 540, 380, 0, element);
}

describe("DocumentsUI row activation (#6335)", () => {
  for (const pkg of ["com.android.documentsui", "com.google.android.documentsui"]) {
    test(`activates the exact ${pkg} collection item through CtrlProxy`, async () => {
      const { tap, adb, service, gestures } = createTap();
      await execute(tap, { ...row, "resource-id": `${pkg}:id/item_root` });
      expect(service.getNodeActionHistory()).toMatchObject([
        {
          action: "click",
          selector: {
            resourceId: `${pkg}:id/item_root`,
            collectionRow: 2,
            collectionColumn: 1,
          },
        },
      ]);
      expect(gestures).toHaveLength(0);
      expect(adb.getAllCommands()).toHaveLength(0);
    });
  }

  for (const options of [{ supported: false }, { success: false }, { throws: true }]) {
    test(`falls back to input when semantic activation is unavailable: ${JSON.stringify(options)}`, async () => {
      const { tap, adb, gestures, service } = createTap(options);
      const warning = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await execute(tap);
        expect(service.getNodeActionHistory()).toHaveLength(options.success === false ? 1 : 0);
        if (options.throws) {
          expect(warning).toHaveBeenCalledWith(
            "[TapOnElement] DocumentsUI row activation failed: Error: Runner disconnected",
          );
        }
        expect(gestures).toHaveLength(0);
        expect(adb.getAllCommands()).toEqual(["shell input touchscreen tap 540 380"]);
      } finally {
        warning.mockRestore();
      }
    });
  }

  test("never activates the first resource-id match when collection identity is missing", async () => {
    const { tap, adb, service } = createTap();
    await execute(tap, {
      ...row,
      "collection-row-index": undefined,
      "collection-column-index": undefined,
    });
    expect(service.getNodeActionHistory()).toHaveLength(0);
    expect(adb.getAllCommands()).toEqual(["shell input touchscreen tap 540 380"]);
  });

  test("does not use an incomplete collection identity", async () => {
    const { tap, adb, service } = createTap();
    await execute(tap, { ...row, "collection-column-index": undefined });
    expect(service.getNodeActionHistory()).toHaveLength(0);
    expect(adb.getAllCommands()).toEqual(["shell input touchscreen tap 540 380"]);
  });

  test("does not attempt an unadvertised click action", async () => {
    const { tap, adb, service } = createTap();
    await execute(tap, { ...row, actions: ["long_click"] });
    expect(service.getNodeActionHistory()).toHaveLength(0);
    expect(adb.getAllCommands()).toEqual(["shell input touchscreen tap 540 380"]);
  });

  for (const id of [
    "com.example.app:id/item_root",
    "com.google.android.documentsui:id/sub_menu_grid",
  ]) {
    test(`preserves coordinate gestures for ${id}`, async () => {
      const { tap, adb, service, gestures } = createTap();
      await execute(tap, { ...row, "resource-id": id });
      expect(service.getNodeActionHistory()).toHaveLength(0);
      expect(gestures).toEqual([
        expect.objectContaining({ x: 540, y: 380, duration: 10, onDispatch: expect.any(Function) }),
      ]);
      expect(adb.getAllCommands()).toHaveLength(0);
    });
  }

  test("does not replay a dispatched coordinate tap through TapOnElement", async () => {
    const { tap, adb } = createTap({ dispatchedTapFails: true });

    await expect(
      execute(tap, { ...row, "resource-id": "com.example.app:id/item_root" }),
    ).rejects.toThrow(/outcome is indeterminate.*Do not retry automatically/i);
    expect(adb.getAllCommands()).toHaveLength(0);
  });

  test("preserves two input taps for an explicit double tap", async () => {
    const { tap, adb, service } = createTap();
    await execute(tap, row, "doubleTap");
    expect(service.getNodeActionHistory()).toHaveLength(0);
    expect(adb.getAllCommands()).toEqual([
      "shell input touchscreen tap 540 380",
      "shell input touchscreen tap 540 380",
    ]);
  });
});

for (const action of ["tap", "doubleTap"]) {
  test(`TalkBack ${action} recovers through DocumentsUI routing after activation failure`, async () => {
    const strategy = new FakeTalkBackTapStrategy();
    strategy.setDirectActivationResult({ success: false, method: "accessibility-action" });
    const { tap, adb } = createTap({
      success: false,
      talkBackStrategy: strategy,
      talkBackDriverFactory: { createDriver: () => new FakeTalkBackNavigationDriver() },
    });
    await tap.executeAndroidTap(action, { x: 540, y: 380 }, 0, row, { isTalkBackEnabled: true });
    expect(strategy.fallbackCalls).toHaveLength(0);
    expect(adb.getAllCommands()).toHaveLength(action === "tap" ? 1 : 2);
  });
}

test("does not activate or fall back after cancellation during runner capability lookup", async () => {
  const { tap, adb, service } = createTap();
  const controller = new AbortController();
  service.supportsNodeActionSelectors = async () => {
    controller.abort();
    return true;
  };
  await expect(
    tap.executeAndroidTapWithCoordinates("tap", 540, 380, 0, row, controller.signal),
  ).rejects.toThrow();
  expect(service.getNodeActionHistory()).toHaveLength(0);
  expect(adb.getAllCommands()).toHaveLength(0);
});

test.each(["capability", "action"])(
  "propagates abort during pending %s without input fallback",
  async (stage) => {
    const { tap, adb, gestures, service } = createTap();
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    if (stage === "capability") {
      service.supportsNodeActionSelectors = async (_perf, signal) => {
        received = signal;
        signal?.addEventListener("abort", finish, { once: true });
        await pending;
        return true;
      };
    } else {
      service.requestNodeAction = async (_action, _selector, _timeout, _perf, signal) => {
        received = signal;
        signal?.addEventListener("abort", finish, { once: true });
        await pending;
        return { success: true, action: "click", totalTimeMs: 1 };
      };
    }
    const result = tap.executeAndroidTapWithCoordinates("tap", 540, 380, 0, row, controller.signal);
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
    }
    expect(received).toBe(controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow("Operation cancelled");
    expect(adb.getAllCommands()).toHaveLength(0);
    expect(gestures).toHaveLength(0);
  },
);
