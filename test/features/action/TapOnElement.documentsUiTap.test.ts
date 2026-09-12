import { describe, expect, test, spyOn } from "bun:test";
import type { Element } from "../../../src/models";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeTalkBackTapStrategy } from "../../fakes/FakeTalkBackTapStrategy";
import { FakeTalkBackNavigationDriver } from "../../fakes/FakeTalkBackNavigationDriver";
import { FakeTimer } from "../../fakes/FakeTimer";

function createTap(options: { supported?: boolean; success?: boolean; throws?: boolean } = {}) {
  const adb = new FakeAdbClient();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const gestures: unknown[] = [];
  const actions: unknown[] = [];
  const service = {
    supportsNodeActionSelectors: async () => options.supported ?? true,
    requestNodeAction: async (action: string, selector: unknown) => {
      actions.push({ action, selector });
      if (options.throws) {
        throw new Error("Runner disconnected");
      }
      return { success: options.success ?? true };
    },
    requestTapCoordinates: async (...args: unknown[]) => {
      gestures.push(args);
      return { success: true };
    },
  };
  const clientSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
    service as unknown as AndroidCtrlProxyClient,
  );
  let tap: TapOnElement;
  try {
    tap = new TapOnElement(
      { name: "test-device", platform: "android", deviceId: "emulator-5554" },
      adb,
      { timer },
    );
  } finally {
    clientSpy.mockRestore();
  }
  return { tap, adb, gestures, actions };
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
  await (tap as any).executeAndroidTapWithCoordinates(action, 540, 380, 0, element);
}

describe("DocumentsUI row activation (#6335)", () => {
  for (const pkg of ["com.android.documentsui", "com.google.android.documentsui"]) {
    test(`activates the exact ${pkg} collection item through CtrlProxy`, async () => {
      const { tap, adb, actions, gestures } = createTap();
      await execute(tap, { ...row, "resource-id": `${pkg}:id/item_root` });
      expect(actions).toEqual([
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
      const { tap, adb, gestures } = createTap(options);
      await execute(tap);
      expect(gestures).toHaveLength(0);
      expect(adb.getAllCommands()).toEqual(["shell input touchscreen tap 540 380"]);
    });
  }

  test("never activates the first resource-id match when collection identity is missing", async () => {
    const { tap, adb, actions } = createTap();
    await execute(tap, {
      ...row,
      "collection-row-index": undefined,
      "collection-column-index": undefined,
    });
    expect(actions).toHaveLength(0);
    expect(adb.getAllCommands()).toEqual(["shell input touchscreen tap 540 380"]);
  });

  test("does not use an incomplete collection identity", async () => {
    const { tap, adb, actions } = createTap();
    await execute(tap, { ...row, "collection-column-index": undefined });
    expect(actions).toHaveLength(0);
    expect(adb.getAllCommands()).toEqual(["shell input touchscreen tap 540 380"]);
  });

  test("does not attempt an unadvertised click action", async () => {
    const { tap, adb, actions } = createTap();
    await execute(tap, { ...row, actions: ["long_click"] });
    expect(actions).toHaveLength(0);
    expect(adb.getAllCommands()).toEqual(["shell input touchscreen tap 540 380"]);
  });

  for (const id of [
    "com.example.app:id/item_root",
    "com.google.android.documentsui:id/sub_menu_grid",
  ]) {
    test(`preserves coordinate gestures for ${id}`, async () => {
      const { tap, adb, actions, gestures } = createTap();
      await execute(tap, { ...row, "resource-id": id });
      expect(actions).toHaveLength(0);
      expect(gestures).toEqual([[540, 380, 10]]);
      expect(adb.getAllCommands()).toHaveLength(0);
    });
  }

  test("preserves two input taps for an explicit double tap", async () => {
    const { tap, adb, actions } = createTap();
    await execute(tap, row, "doubleTap");
    expect(actions).toHaveLength(0);
    expect(adb.getAllCommands()).toEqual([
      "shell input touchscreen tap 540 380",
      "shell input touchscreen tap 540 380",
    ]);
  });
});

for (const action of ["tap", "doubleTap"]) {
  test(`TalkBack ${action} recovers through DocumentsUI routing after activation failure`, async () => {
    const { tap, adb } = createTap({ success: false });
    const strategy = new FakeTalkBackTapStrategy();
    strategy.setDirectActivationResult({ success: false, method: "accessibility-action" });
    (tap as any).talkBackStrategy = strategy;
    (tap as any).talkBackDriverFactory = { createDriver: () => new FakeTalkBackNavigationDriver() };
    await (tap as any).executeAndroidTap(action, 540, 380, 0, row, undefined, undefined, true);
    expect(strategy.fallbackCalls).toHaveLength(0);
    expect(adb.getAllCommands()).toHaveLength(action === "tap" ? 1 : 2);
  });
}

test("does not activate or fall back after cancellation during runner capability lookup", async () => {
  const { tap, adb, actions } = createTap();
  const controller = new AbortController();
  (tap as any).accessibilityService.supportsNodeActionSelectors = async () => {
    controller.abort();
    return true;
  };
  await expect(
    (tap as any).executeAndroidTapWithCoordinates("tap", 540, 380, 0, row, controller.signal),
  ).rejects.toThrow();
  expect(actions).toHaveLength(0);
  expect(adb.getAllCommands()).toHaveLength(0);
});

test.each(["capability", "action"])(
  "propagates abort during pending %s without input fallback",
  async (stage) => {
    const { tap, adb, gestures } = createTap();
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    if (stage === "capability") {
      (tap as any).accessibilityService.supportsNodeActionSelectors = async (
        _perf: unknown,
        signal: AbortSignal,
      ) => {
        received = signal;
        signal.addEventListener("abort", finish, { once: true });
        await pending;
        return true;
      };
    } else {
      (tap as any).accessibilityService.requestNodeAction = async (
        _action: string,
        _selector: unknown,
        _timeout: unknown,
        _perf: unknown,
        signal: AbortSignal,
      ) => {
        received = signal;
        signal.addEventListener("abort", finish, { once: true });
        await pending;
        return { success: true };
      };
    }
    const result = (tap as any).executeAndroidTapWithCoordinates(
      "tap",
      540,
      380,
      0,
      row,
      controller.signal,
    );
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
