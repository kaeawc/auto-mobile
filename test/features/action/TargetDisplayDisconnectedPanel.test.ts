import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import type { Posture } from "../../../src/models/DisplayPanel";
import { ActionableError } from "../../../src/models/ActionableError";
import type { BaseActionResult } from "../../../src/models/BaseActionResult";
import { withStaleDisplay } from "../../../src/models/StaleDisplayError";
import { DisplaySelectionError } from "../../../src/features/observe/DisplaySelection";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { SwipeOn } from "../../../src/features/action/swipeon/SwipeOn";
import { DragAndDrop } from "../../../src/features/action/DragAndDrop";
import type { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import * as targetDisplayAction from "../../../src/features/action/TargetDisplayAction";
import { TapAtCoordinate } from "../../../src/features/action/TapAtCoordinate";
import type { CoordinateTapClient } from "../../../src/features/action/coordinateTapDispatch";
import { runWithSelectedDisplayPin } from "../../../src/features/observe/SessionDisplayContext";
import { logger } from "../../../src/utils/logger";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeDisplayTransitionReader } from "../../fakes/FakeDisplayTransitionReader";
import { FakeTimer } from "../../fakes/FakeTimer";

const inner = "4619827259835644672";
const cover = "4619827551948147201";
const captures = {
  opened: readFileSync(
    new URL("../../fixtures/android-fold-displays/fold-open-get-displays.txt", import.meta.url),
    "utf8",
  ),
  closed: readFileSync(
    new URL("../../fixtures/android-fold-displays/fold-closed-get-displays.txt", import.meta.url),
    "utf8",
  ),
};

function device(postures: Posture[] = ["closed", "opened"]): BootedDevice {
  return {
    deviceId: "fold-disconnected-panel",
    name: "am-fold-pixel10pf",
    platform: "android",
    apiLevel: 36,
    displays: {
      panels: [
        { key: inner, role: "inner", sizePx: { width: 2076, height: 2152 } },
        { key: cover, role: "cover", sizePx: { width: 1080, height: 2364 } },
      ],
      postures,
    },
  };
}

function observation(key: string): ObserveResult {
  return {
    display: {
      key,
      role: key === cover ? "cover" : "inner",
      posture: key === cover ? "closed" : "opened",
      generation: 7,
    },
    displayRevision: 41,
    screenSize: { width: 2076, height: 2152 },
  };
}

function harness(
  posture: keyof typeof captures = "closed",
  previousKey = cover,
  targetDevice = device(),
) {
  const adb = new FakeAdbExecutor();
  // FakeAdbExecutor matches substrings, just like the existing action-display adb() helper.
  adb.setCommandResponse("cmd display get-displays", { stdout: captures[posture], stderr: "" });
  const observe = new FakeObserveScreen();
  observe.setObserveResult(observation(previousKey));
  const transitions = new FakeDisplayTransitionReader();
  const previous = () => observation(previousKey);
  const prepare = (display = "inner", signal?: AbortSignal) =>
    targetDisplayAction.prepareTargetDisplayAction(
      targetDevice,
      display,
      observe,
      adb,
      previous,
      signal,
      transitions,
    );
  return { adb, observe, transitions, previous, prepare, targetDevice };
}

function reobserve(key: string): string {
  return `Coordinates for display "${key}" require a prior observation of that panel. Re-observe display "${key}" and retry.`;
}

const foldedMessage = `Display "${inner}" (inner) is not connected in the current posture. Connected panels: ${cover} (cover). Target a connected panel, omit display, or use display: "active"; to make this panel available, change the device posture with setPosture {posture: "opened"}.`;
const pinRemedy =
  " Clear the pin with setActiveDevice {display: null} (include deviceId and sessionUuid), or select another display explicitly.";

class FakeTapClient implements CoordinateTapClient {
  calls = 0;
  async requestTapCoordinates(): Promise<{ success: boolean }> {
    this.calls++;
    return { success: true };
  }
}

describe("Android disconnected action panel", () => {
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  let debug: ReturnType<typeof spyOn<typeof logger, "debug">>;
  beforeEach(() => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    debug = spyOn(logger, "debug").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    debug.mockRestore();
  });

  test("folded inner names the connected cover and posture remedy without observing or tapping", async () => {
    const h = harness();
    await expect(h.prepare()).rejects.toThrow(foldedMessage);
    expect(h.observe.getExecuteOptions()).toEqual([]);
    expect(h.adb.getExecutedCommands()).toEqual(["shell cmd display get-displays"]);
    expect(h.adb.getCommandCalls()[0]).toMatchObject({
      timeoutMs: 2000,
      maxBuffer: undefined,
      noRetry: true,
    });
    expect(foldedMessage).not.toContain("Re-observe display");
    expect(foldedMessage).not.toContain("setActiveDevice");
  });

  test("unfolded cover names the connected inner", async () => {
    const h = harness("opened", inner);
    await expect(h.prepare("cover")).rejects.toThrow(
      `Display "${cover}" (cover) is not connected in the current posture. Connected panels: ${inner} (inner). Target a connected panel, omit display, or use display: "active"; to make this panel available, change the device posture with setPosture {posture: "closed"}.`,
    );
    expect(h.observe.getExecuteOptions()).toEqual([]);
  });

  test("no posture support omits setPosture", async () => {
    await expect(harness("closed", cover, device([])).prepare()).rejects.toThrow(
      `Display "${inner}" (inner) is not connected in the current posture. Connected panels: ${cover} (cover). Target a connected panel, omit display, or use display: "active".`,
    );
  });

  test("call-local pin adds the existing session-clearing remedy", async () => {
    const h = harness();
    await expect(
      runWithSelectedDisplayPin({ pin: "inner", inventory: h.targetDevice.displays }, () =>
        h.prepare(),
      ),
    ).rejects.toThrow(foldedMessage + pinRemedy);
    // AsyncLocalStorage does not leak the pin into the following unpinned call.
    await expect(h.prepare()).rejects.toThrow(foldedMessage);
  });

  test("unknown selector keeps the exact inventory error and makes no read", async () => {
    const h = harness();
    await expect(h.prepare("999")).rejects.toThrow(
      `Unknown or unavailable display "999". Available panels: ${inner} (inner), ${cover} (cover)`,
    );
    expect(h.adb.getExecutedCommands()).toEqual([]);
  });

  test("connected but not rendered still needs the exact prior observation advice", async () => {
    const h = harness("opened", cover);
    await expect(h.prepare()).rejects.toThrow(reobserve(inner));
    expect(h.observe.getExecuteOptions()).toEqual([]);
  });

  for (const unreadable of ["throws", "empty"] as const) {
    test(`unreadable list (${unreadable}) keeps prior observation advice`, async () => {
      const h = harness();
      if (unreadable === "throws") {
        h.adb.setCommandError("cmd display get-displays", new Error("display service unavailable"));
      } else {
        h.adb.setCommandResponse("cmd display get-displays", { stdout: "", stderr: "" });
      }
      await expect(h.prepare()).rejects.toThrow(reobserve(inner));
      expect(h.adb.getExecutedCommands()).toEqual(["shell cmd display get-displays"]);
      expect(unreadable === "throws" ? warn : debug).toHaveBeenCalledTimes(1);
    });
  }

  test("already-rendered connected panel proceeds with only the pre-existing mapping read", async () => {
    const h = harness("opened", inner);
    const result = await h.prepare();
    expect(result.displayId).toBe(0);
    expect(result.observation.display.key).toBe(inner);
    // Pre-fix inputDisplayId -> logicalIdForPanel reads once; FakeObserveScreen performs no ADB reads.
    expect(h.adb.getExecutedCommands()).toEqual(["shell cmd display get-displays"]);
    expect(h.observe.getExecuteOptions()).toHaveLength(1);
  });

  test("ordinary single-display missing observation keeps old advice without a read", async () => {
    const h = harness("closed", cover, { deviceId: "single", name: "Single", platform: "android" });
    await expect(h.prepare("0")).rejects.toThrow(reobserve("0"));
    expect(h.adb.getExecutedCommands()).toEqual([]);
  });

  test("abort during the read surfaces cancellation and forwards the signal", async () => {
    const h = harness();
    const controller = new AbortController();
    h.adb.abortAfterCommand("cmd display get-displays", controller);
    await expect(h.prepare("inner", controller.signal)).rejects.toThrow(
      OPERATION_CANCELLED_MESSAGE,
    );
    expect(h.adb.getCommandCalls()[0]?.signal).toBe(controller.signal);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a rejected AbortError is not downgraded to re-observe advice", async () => {
    const h = harness();
    const aborted = new Error("read aborted");
    aborted.name = "AbortError";
    h.adb.setCommandError("cmd display get-displays", aborted);
    await expect(h.prepare()).rejects.toThrow(aborted);
    expect(warn).not.toHaveBeenCalled();
  });

  test("TapAtCoordinate returns the actionable failure without dispatch", async () => {
    const h = harness();
    const client = new FakeTapClient();
    const action = new TapAtCoordinate(h.targetDevice, h.adb, {
      timer: new FakeTimer(),
      androidClient: client,
      iosClient: client,
      lastRenderedObservation: h.previous,
      displayTransitions: h.transitions,
    });
    action.observeScreen = h.observe;
    const result = await action.execute({ x: 300, y: 900, display: "inner" });
    expect(result.success).toBe(false);
    expect(result.error).toBe(`Failed to tap at coordinates: ${foldedMessage}`);
    expect(client.calls).toBe(0);
    expect(h.observe.getExecuteOptions()).toEqual([]);
    expect(h.adb.wasCommandExecuted("input")).toBe(false);
  });

  test("pure builder includes connected inventory roles and key-only fallback", () => {
    const message = targetDisplayAction.buildDisconnectedPanelMessage(
      inner,
      "inner",
      [{ key: cover, role: "cover" }, { key: "unlisted" }],
      false,
      false,
    );
    expect(message).toContain(`Connected panels: ${cover} (cover), unlisted.`);
    expect(message).not.toContain("setPosture");
    expect(message).not.toContain("setActiveDevice");
    expect(message).not.toContain("Re-observe display");
  });

  test("pure builder supplies the folded and pinned messages", () => {
    expect(
      targetDisplayAction.buildDisconnectedPanelMessage(
        inner,
        "inner",
        [{ key: cover, role: "cover" }],
        true,
        false,
      ),
    ).toBe(foldedMessage);
    expect(
      targetDisplayAction.buildDisconnectedPanelMessage(
        inner,
        "inner",
        [{ key: cover, role: "cover" }],
        true,
        true,
      ),
    ).toBe(foldedMessage + pinRemedy);
  });

  test("disconnected rejection is structured", async () => {
    await expect(harness().prepare()).rejects.toBeInstanceOf(ActionableError);
  });
});

type DisconnectedCall = (h: ReturnType<typeof harness>) => Promise<BaseActionResult>;
const noopTapClient = new FakeTapClient();
// Every action fails in the pre-dispatch panel check, before any input or capture.
const disconnectedActions: Array<[string, DisconnectedCall]> = [
  [
    "tapAt",
    (h) => {
      const action = new TapAtCoordinate(h.targetDevice, h.adb, {
        timer: new FakeTimer(),
        androidClient: noopTapClient,
        iosClient: noopTapClient,
        lastRenderedObservation: h.previous,
        displayTransitions: h.transitions,
      });
      action.observeScreen = h.observe;
      return action.execute({ x: 300, y: 900, display: "inner" });
    },
  ],
  [
    "tapOn",
    (h) => {
      const action = new TapOnElement(h.targetDevice, h.adb, {
        timer: new FakeTimer(),
        lastRenderedObservation: h.previous,
        displayTransitions: h.transitions,
      });
      action.observeScreen = h.observe;
      return action.execute({ action: "tap", text: "x", display: "inner" });
    },
  ],
  [
    "swipeOn",
    (h) => {
      const action = new SwipeOn(h.targetDevice, h.adb as unknown as AdbClient, {
        timer: new FakeTimer(),
        lastRenderedObservation: h.previous,
        displayTransitions: h.transitions,
      });
      action.observeScreen = h.observe;
      return action.execute({ direction: "up", display: "inner" });
    },
  ],
  [
    "dragAndDrop",
    (h) => {
      const action = new DragAndDrop(
        h.targetDevice,
        h.adb as unknown as AdbClient,
        new FakeTimer(),
        { lastRenderedObservation: h.previous, displayTransitions: h.transitions },
      );
      action.observeScreen = h.observe;
      return action.execute({
        source: { text: "Source" },
        target: { text: "Target" },
        display: "inner",
      });
    },
  ],
];

describe("disconnected action panel pinnedDisplay details", () => {
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  beforeEach(() => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  const pinned = (h: ReturnType<typeof harness>) => ({
    pin: "inner",
    inventory: h.targetDevice.displays,
  });
  async function pinnedRejection(h: ReturnType<typeof harness>): Promise<unknown> {
    return runWithSelectedDisplayPin(pinned(h), async () => {
      try {
        await h.prepare();
      } catch (caught) {
        return caught;
      }
      throw new Error("expected a rejection");
    });
  }

  test("withStaleDisplay attaches the documented shape for a pinned disconnected panel", async () => {
    const h = harness();
    const error = await pinnedRejection(h);
    expect(error).toBeInstanceOf(DisplaySelectionError);
    const result = runWithSelectedDisplayPin(pinned(h), () =>
      withStaleDisplay({ success: false }, error),
    );
    expect(result).toEqual({
      success: false,
      error: foldedMessage + pinRemedy,
      pinnedDisplay: { pin: "inner", availablePanels: [{ key: cover, role: "cover" }] },
    });
  });

  for (const [name, run] of disconnectedActions) {
    test(`${name}: a pinned disconnected panel reports pinnedDisplay with the unchanged message`, async () => {
      const h = harness();
      const result = await runWithSelectedDisplayPin(pinned(h), () => run(h));
      expect(result.success).toBe(false);
      expect(result.error).toContain(foldedMessage + pinRemedy);
      expect(result.pinnedDisplay).toEqual({
        pin: "inner",
        availablePanels: [{ key: cover, role: "cover" }],
      });
      expect(Object.hasOwn(result, "staleDisplay")).toBe(false);
      expect(h.observe.getExecuteOptions()).toEqual([]);
      expect(h.adb.wasCommandExecuted("input")).toBe(false);
    });

    test(`${name}: an explicit disconnected display keeps the plain error without pinnedDisplay`, async () => {
      const h = harness();
      const result = await run(h);
      expect(result.success).toBe(false);
      expect(result.error).toContain(foldedMessage);
      expect(result.error).not.toContain("Clear the pin");
      expect(Object.hasOwn(result, "pinnedDisplay")).toBe(false);
    });
  }

  test("a connected panel raises no error", async () => {
    const h = harness("opened", inner);
    await expect(runWithSelectedDisplayPin(pinned(h), () => h.prepare())).resolves.toMatchObject({
      displayId: 0,
    });
  });

  test("an unlisted connected panel keeps a valid schema role in pinnedDisplay", async () => {
    const h = harness();
    h.adb.setCommandResponse("cmd display get-displays", {
      stdout: 'Display id 0: DisplayInfo{uniqueId "local:unlisted" type INTERNAL, real 100 x 100}',
      stderr: "",
    });
    const error = await pinnedRejection(h);
    const result = runWithSelectedDisplayPin(pinned(h), () =>
      withStaleDisplay({ success: false }, error),
    );
    expect(result.pinnedDisplay).toEqual({
      pin: "inner",
      availablePanels: [{ key: "unlisted", role: "unknown" }],
    });
  });
});
