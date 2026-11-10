import { readFileSync } from "node:fs";
import type { WatchCommand } from "../../../src/features/watch/WatchRunnerClient";
import { InputText } from "../../../src/features/action/InputText";
import { SwipeAtCoordinate } from "../../../src/features/action/SwipeAtCoordinate";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { watchRunners } from "../../../src/features/watch/WatchRunnerRegistry";
import {
  watchTapOn,
  watchTapAt,
  watchSwipeOn,
  watchPress,
  orderWatchTapCandidates,
} from "../../../src/features/watch/WatchActions";
import { FakeWatchRunnerClient } from "../../fakes/FakeWatchRunnerClient";
import hierarchy from "../../fixtures/watchos-xcuitest/sdk-hierarchy-live.json";
import { FakeTimer } from "../../fakes/FakeTimer";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { defaultTapAtElementFactory } from "../../../src/server/interactionTools/tapHandlers";
import { SwipeOn } from "../../../src/features/action/swipeon/SwipeOn";
import { PressButton } from "../../../src/features/action/PressButton";
import { SendKeys } from "../../../src/features/action/SendKeys";
import { PinchOn } from "../../../src/features/action/PinchOn";
import { MultiTouchGesture } from "../../../src/features/action/MultiTouchGesture";
import type { BootedDevice, Element } from "../../../src/models";
import { ActionableError } from "../../../src/models/ActionableError";
import * as watchActions from "../../../src/features/watch/WatchActions";
import xcuiHierarchy from "../../fixtures/watchos-xcuitest/hierarchy.json";

describe("watch tap candidate ordering", () => {
  // Fake candidates shaped like the captured XCUITest nodes, without parsing a hierarchy.
  const candidate = (type: number): Element => {
    const [x, y, width, height] = xcuiHierarchy.frame;
    return {
      class: `XCUIElementType(${type})`,
      text: "helloAB",
      bounds: { left: x, top: y, right: x + width, bottom: y + height },
    };
  };

  test("prefers every input type and preserves order within both groups without mutation", () => {
    const label = candidate(48);
    const field = candidate(49);
    const button = candidate(9);
    const secure = candidate(50);
    const search = candidate(45);
    const otherField = candidate(49);
    const candidates = [label, field, button, secure, search, otherField];
    const ordered = orderWatchTapCandidates(candidates, true);
    const expected = [field, secure, search, otherField, label, button];
    ordered.forEach((element, index) => expect(element).toBe(expected[index]));
    expect(candidates).toEqual([label, field, button, secure, search, otherField]);
  });

  test("ordinary taps keep hierarchy order even with matching inputs", () => {
    const candidates = [candidate(48), candidate(49), candidate(45), candidate(50)];
    expect(orderWatchTapCandidates(candidates, false)).toEqual(candidates);
  });

  test("falls back to other matches in order and handles empty candidates", () => {
    const candidates = [candidate(48), candidate(9), { ...candidate(1), class: undefined }];
    expect(orderWatchTapCandidates(candidates, true)).toEqual(candidates);
    expect(orderWatchTapCandidates([], true)).toEqual([]);
  });
});

const device: BootedDevice = { deviceId: "watch-actions", platform: "watchos", name: "Watch" };
let client: FakeWatchRunnerClient;
let unregister: () => void;
beforeEach(() => {
  client = new FakeWatchRunnerClient();
  unregister = watchRunners.register(device.deviceId, client);
});
afterEach(() => unregister());

describe("watch tap by shared identifier with value aliases", () => {
  const field = (top: number, label: string, children: object[] = []) => ({
    className: "XCUIElementType(49)",
    accessibilityIdentifier: "repeated-field",
    accessibilityLabel: label,
    bounds: { left: 2, top, right: 180, bottom: top + 40 },
    children,
  });
  const alias = (top: number, value: string) => field(top, value);
  const tree = {
    ...hierarchy,
    root: {
      ...hierarchy.root,
      children: [
        field(10, "First", [alias(10, "alpha")]),
        field(60, "Second", [alias(60, "beta")]),
      ],
    },
  };

  test("elementId index addresses the second field, not the first field's value alias", async () => {
    const aliasClient = new FakeWatchRunnerClient(tree);
    const release = watchRunners.register("watch-alias", aliasClient);
    try {
      await watchTapOn("watch-alias", { elementId: "repeated-field", index: 1, action: "tap" });
      expect(aliasClient.commands.at(-1)).toEqual({ type: "tap", x: 91, y: 80 });
    } finally {
      release();
    }
  });
});

describe("watch actions", () => {
  test.each([0.5, -0.5])("rotates the crown by signed delta %s", async (delta) => {
    expect(await watchActions.watchRotateCrown(device, { delta, velocity: 2 })).toEqual({
      success: true,
      delta,
      velocity: 2,
    });
    expect(client.commands).toEqual([{ type: "crown", delta, velocity: 2 }]);
  });
  test("defaults crown velocity to 1 before dispatch", async () => {
    await watchActions.watchRotateCrown(device, { delta: 0.25 });
    expect(client.commands).toEqual([{ type: "crown", delta: 0.25, velocity: 1 }]);
    expect(watchActions.CROWN_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(client.requestOptions).toEqual([{ timeoutMs: watchActions.CROWN_REQUEST_TIMEOUT_MS }]);
  });
  test.each([0, NaN, Infinity, -Infinity])("refuses invalid crown delta %s", async (delta) => {
    await expect(watchActions.watchRotateCrown(device, { delta })).rejects.toBeInstanceOf(
      ActionableError,
    );
    expect(client.commands).toEqual([]);
  });
  test.each([0, -1, NaN, Infinity, -Infinity])(
    "refuses invalid crown velocity %s",
    async (velocity) => {
      await expect(
        watchActions.watchRotateCrown(device, { delta: 1, velocity }),
      ).rejects.toBeInstanceOf(ActionableError);
      expect(client.commands).toEqual([]);
    },
  );
  test.each(["android", "ios", "tvos"] as const)("refuses crown input on %s", async (platform) => {
    await expect(
      watchActions.watchRotateCrown({ ...device, platform }, { delta: 1 }),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(client.commands).toEqual([]);
  });
  test("refuses an aborted crown action before dispatch", async () => {
    await expect(
      watchActions.watchRotateCrown(
        device,
        { delta: 1 },
        AbortSignal.abort(new Error("cancelled")),
      ),
    ).rejects.toThrow("cancelled");
    expect(client.commands).toEqual([]);
  });
  test.each([false, true])(
    "refuses ensureChecked=%s before any runner command",
    async (ensureChecked) => {
      await expect(
        new TapOnElement(device, null, { timer: new FakeTimer() }).execute({
          action: "tap",
          elementId: "ctrlproxy-crown",
          ensureChecked,
        }),
      ).rejects.toThrow("ensureChecked");
      expect(client.commands).toEqual([]);
    },
  );
  test("taps by identifier through the tapOn entry point", async () => {
    const result = await new TapOnElement(device, null, { timer: new FakeTimer() }).execute({
      action: "tap",
      elementId: "ctrlproxy-crown",
    });
    expect(result.success).toBe(true);
    expect(client.commands).toEqual([
      { type: "face", op: "dump" },
      { type: "hierarchy" },
      { type: "tap", identifier: "ctrlproxy-crown" },
    ]);
  });
  test.each([
    { left: 0, top: 0, right: 0, bottom: 0 },
    { left: 10, top: 224, right: 50, bottom: 244 },
  ])("uses the visible row's center when an earlier duplicate is offscreen: %j", async (bounds) => {
    unregister();
    const tree = structuredClone(hierarchy);
    tree.root.children = [
      {
        ...tree.root,
        accessibilityIdentifier: "reused-row",
        accessibilityLabel: "Earlier row",
        bounds,
        children: [],
      },
      {
        ...tree.root,
        accessibilityIdentifier: "reused-row",
        accessibilityLabel: "Visible row",
        bounds: { left: 10, top: 40, right: 70, bottom: 80 },
        children: [],
      },
    ];
    client = new FakeWatchRunnerClient(tree);
    unregister = watchRunners.register(device.deviceId, client);

    const result = await watchTapOn(device.deviceId, { action: "tap", text: "Visible row" });

    expect(result).toMatchObject({ success: true, element: { text: "Visible row" } });
    expect(client.commands).toEqual([
      { type: "face", op: "dump" },
      { type: "hierarchy" },
      { type: "tap", x: 40, y: 60 },
    ]);
  });
  test("text-only nodes dispatch their center in XCTest points", async () => {
    await watchTapOn(device.deviceId, { action: "tap", text: "CtrlProxyWatch" });
    expect(client.commands[2]).toEqual({ type: "tap", x: 92, y: 112 });
  });
  test("coordinate entry point routes without a hierarchy read", async () => {
    const result = await defaultTapAtElementFactory(device).execute({
      x: 50,
      y: 80,
    });
    expect(result).toMatchObject({ success: true, x: 50, y: 80 });
    expect(client.commands).toEqual([
      { type: "face", op: "dump" },
      { type: "tap", x: 50, y: 80 },
    ]);
  });
  test.each(["call context", "positional"] as const)(
    "coordinate entry point honors cancellation via %s before any command",
    async (form) => {
      const signal = AbortSignal.abort(new Error("watch tap cancelled"));
      const tap = defaultTapAtElementFactory(device);
      await expect(
        form === "call context"
          ? tap.execute({ x: 50, y: 80 }, { signal })
          : tap.execute({ x: 50, y: 80 }, undefined, signal),
      ).rejects.toThrow("watch tap cancelled");
      expect(client.commands).toEqual([]);
    },
  );
  test("refuses zero-area text matches", async () => {
    await expect(
      watchTapOn(device.deviceId, { action: "tap", text: "Non-hittable fixture" }),
    ).rejects.toThrow("No watch element matched");
    expect(client.commands).toEqual([{ type: "face", op: "dump" }, { type: "hierarchy" }]);
  });
  test("refuses offscreen text matches", async () => {
    unregister();
    const tree = structuredClone(hierarchy);
    tree.root.bounds.top = tree.screenHeight;
    tree.root.bounds.bottom = tree.screenHeight * 2;
    client = new FakeWatchRunnerClient(tree);
    unregister = watchRunners.register(device.deviceId, client);
    await expect(
      watchTapOn(device.deviceId, { action: "tap", text: "CtrlProxyWatch" }),
    ).rejects.toThrow("No watch element matched");
    expect(client.commands).toEqual([{ type: "face", op: "dump" }, { type: "hierarchy" }]);
  });
  test("swipeOn entry point sends direction and home entry point sends home", async () => {
    const timer = new FakeTimer();
    const swipe = await new SwipeOn(device, null, { timer }).execute({ direction: "up" });
    expect(swipe).toMatchObject({ success: true, durationIgnored: true });
    await new PressButton(device, null, timer).execute("home");
    expect(client.commands).toEqual([{ type: "swipe", direction: "up" }, { type: "home" }]);
    expect(timer.getSleepHistory()).toEqual([]);
  });
  test("lookFor matches identifiers and text with a bounded direction search", async () => {
    expect(
      await watchSwipeOn(device.deviceId, {
        direction: "up",
        lookFor: { elementId: "ctrlproxy-crown" },
      }),
    ).toMatchObject({ found: true, scrollIterations: 0 });
    client.commands.length = 0;
    expect(
      await watchSwipeOn(device.deviceId, {
        direction: "up",
        gestureType: "scrollTowardsDirection",
        lookFor: { text: "Non-hittable fixture", maxSwipes: 2 },
      }),
    ).toMatchObject({ found: false, scrollIterations: 2 });
    expect(client.commands.filter((command) => command.type === "swipe")).toEqual([
      { type: "swipe", direction: "down", distance: watchActions.WATCH_LOOK_FOR_SWIPE_DISTANCE },
      { type: "swipe", direction: "down", distance: watchActions.WATCH_LOOK_FOR_SWIPE_DISTANCE },
    ]);
  });
  test("lookFor swipes move less than one screen so consecutive reads overlap", () => {
    expect(watchActions.WATCH_LOOK_FOR_SWIPE_DISTANCE).toBeGreaterThan(0);
    expect(watchActions.WATCH_LOOK_FOR_SWIPE_DISTANCE).toBeLessThan(1);
  });
  test("long press, pinch, multi-touch and text reject before any command", async () => {
    const timer = new FakeTimer();
    await expect(
      new TapOnElement(device, null, { timer }).execute({
        action: "longPress",
        text: "CtrlProxy Watch",
      }),
    ).rejects.toThrow("longPress");
    await expect(
      defaultTapAtElementFactory(device).execute({ x: 1, y: 2, action: "longPress" }),
    ).rejects.toThrow("longPress");
    await expect(new PinchOn(device, null, { timer }).execute({ direction: "in" })).rejects.toThrow(
      "pinch",
    );
    expect(() => new SendKeys(device, undefined, { timer })).toThrow("text input");
    await expect(
      new MultiTouchGesture(device, null, { timer }).execute({
        action: "swipe",
        x: 10,
        y: 20,
        direction: "up",
        fingers: 2,
      }),
    ).rejects.toThrow("multi-touch");
    await expect(new InputText(device, null, { timer }).execute("hello")).rejects.toThrow(
      "text input",
    );
    await expect(
      new SwipeAtCoordinate(device, null, { timer }).execute({
        from: { x: 1, y: 2 },
        to: { x: 3, y: 4 },
      }),
    ).rejects.toThrow("coordinate swipe");
    expect(client.commands).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  });
  test("refuses unsupported targeting and non-absolute coordinates before commands", async () => {
    await expect(
      watchTapOn(device.deviceId, { action: "doubleTap", text: "CtrlProxy Watch" }),
    ).rejects.toThrow("doubleTap");
    await expect(
      watchTapAt(device.deviceId, { x: 1, y: 1, coordinateSpace: "normalized" }),
    ).rejects.toThrow("non-absolute");
    await expect(
      watchSwipeOn(device.deviceId, { direction: "up", container: { text: "list" } }),
    ).rejects.toThrow("container");
    await expect(watchPress(device.deviceId, "back")).rejects.toThrow("press back");
    expect(client.commands).toEqual([]);
  });
});

describe("watch actions with Smart Stack", () => {
  const dump = readFileSync(
    new URL(
      "../../fixtures/watchos-clockface/fixture-face-smartstack-after-reload.txt",
      import.meta.url,
    ),
    "utf8",
  );
  const cellId =
    "StackCollectionViewComplicationCell -- 93A18F3B-D642-41DA-B6A4-F312ED9DB584 -- ProbeApp -- ProbeWidgetXYZ -- dev.probe.app -- dev.probe.app-dev.probe.app.widget-probe-0";
  function useDump(text: string, failure = false) {
    class StackClient extends FakeWatchRunnerClient {
      override async request(
        command: WatchCommand,
        signal?: AbortSignal,
        options?: { timeoutMs?: number },
      ): Promise<unknown> {
        const result = await super.request(command, signal, options);
        if (command.type === "face" && command.op === "dump") {
          if (failure) {
            throw new Error("unsupported face command");
          }
          return text;
        }
        return result;
      }
    }
    unregister();
    client = new StackClient();
    unregister = watchRunners.register(device.deviceId, client);
  }
  test("tapAt sends exactly one normalized face tap and no app command", async () => {
    useDump(dump);
    expect(await watchTapAt(device.deviceId, { x: 93.5, y: 146.25 })).toEqual({
      success: true,
      action: "tap",
      x: 93.5,
      y: 146.25,
    });
    expect(client.commands).toEqual([
      { type: "face", op: "dump" },
      { type: "face", op: "tap", x: 0.5, y: 146.25 / 223 },
    ]);
  });
  test.each([{ text: "T28" }, { elementId: cellId }])(
    "tapOn matches widget %j without app hierarchy or tap",
    async (selector) => {
      useDump(dump);
      const result = await watchTapOn(device.deviceId, { action: "tap", ...selector });
      expect(result).toMatchObject({
        success: true,
        action: "tap",
        element: { "resource-id": cellId },
      });
      expect(client.commands).toEqual([
        { type: "face", op: "dump" },
        { type: "face", op: "tap", x: 0.5, y: 146.25 / 223 },
      ]);
    },
  );
  test.each([false, true])(
    "closed stack or failed preflight preserves app taps (failure=%s)",
    async (failure) => {
      useDump(
        readFileSync(
          new URL("../../fixtures/watch/fixture-face-dump-host-foreground.txt", import.meta.url),
          "utf8",
        ),
        failure,
      );
      await watchTapAt(device.deviceId, { x: 50, y: 80 });
      await watchTapOn(device.deviceId, { action: "tap", elementId: "ctrlproxy-crown" });
      expect(client.commands).toEqual([
        { type: "face", op: "dump" },
        { type: "tap", x: 50, y: 80 },
        { type: "face", op: "dump" },
        { type: "hierarchy" },
        { type: "tap", identifier: "ctrlproxy-crown" },
      ]);
    },
  );
});
