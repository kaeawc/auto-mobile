import { finalizeToolResponse } from "../../../src/server/finalizeToolResponse";
import { createStructuredToolResponse } from "../../../src/utils/toolUtils";
import { FakeArtifactWriter } from "../../fakes/FakeArtifactWriter";
import { setPostureResultSchema } from "../../../src/server/toolOutputSchemas";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice, ObserveResult, Posture } from "../../../src/models";
import {
  classifyIosPostureObservation,
  pendingPostureOperationCountForTest,
  SetPosture,
} from "../../../src/features/device/SetPosture";
import type { DisplayPanel } from "../../../src/models/DisplayPanel";
import {
  DisplayTransitionTracker,
  type DisplayTransitionSink,
} from "../../../src/features/observe/DisplayTransition";
import {
  observedIosDisplay,
  ObservedAndroidDisplayCache,
} from "../../../src/features/observe/ObservationDisplay";
import type { ObserveScreen } from "../../../src/features/observe/interfaces/ObserveScreen";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAndroidHingeAngleConsole } from "../../fakes/FakeAndroidHingeAngleConsole";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import type { AppleDevice } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActionableError } from "../../../src/models/ActionableError";
import { displayInventoryOutcome } from "../../../src/models/DeviceInfo";
import { parseAndroidCommittedStateIdentifier } from "../../../src/utils/android-cmdline-tools/AndroidDisplayInventory";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-display", name), "utf8");
const foldStates = fixture("foldpf-print-states.txt");
const phoneStates = fixture("phone-states.txt");
const closedState = fixture("foldpf-5-after-reset-state.txt");
const openedState = fixture("foldpf-1-default-state.txt");
const hingeAngleReadBack = fixture("hinge-angle0-get.txt");
const rearState = fixture("foldpf-2-rear-display-override-state.txt");
import { logger } from "../../../src/utils/logger";
import { loadDuoEnumerate } from "../../fixtures/loadDuoEnumerate";
import {
  parseSimulatorDisplays,
  simulatorDeviceDisplays,
} from "../../../src/utils/ios-cmdline-tools/SimulatorDisplays";

const display = {
  key: "panel-inner",
  role: "inner",
  posture: "half_opened",
  generation: 4,
} as const;
const observation = {
  display,
  screenSize: { width: 200, height: 300 },
  deviceLock: { locked: true, keyguardShowing: true },
} as ObserveResult;

function makeDevice(
  deviceId = "emulator-5554",
  postures: Posture[] = ["closed", "half_opened", "opened", "rear_display", "flipped", "tent"],
): BootedDevice {
  return {
    name: "Test foldable",
    platform: "android",
    deviceId,
    displays: { panels: [], postures },
  };
}

function makeFeature(
  device: BootedDevice,
  adb: FakeAdbExecutor,
  timer = new FakeTimer(),
  observed: ObserveResult = observation,
) {
  timer.enableAutoAdvance();
  adb.setCommandResponse("emu sensor get hinge-angle0", createExecResult(hingeAngleReadBack, ""));
  const adbFactory: AdbClientFactory = { create: () => adb };
  const tracker = new DisplayTransitionTracker(() => {});
  let observeCount = 0;
  const observeFactory = () =>
    ({
      execute: async () => {
        observeCount += 1;
        tracker.notifyTransition(device.deviceId, "fake observed identity change");
        return { ...observed, displayRevision: tracker.revision(device.deviceId) };
      },
    }) as ObserveScreen;
  return {
    feature: new SetPosture(device, {
      adbFactory,
      observeFactory,
      timer,
      transitionSink: tracker,
    }),
    getObserveCount: () => observeCount,
    tracker,
    timer,
  };
}

describe("SetPosture", () => {
  test.each(["emulator-5554", "R5CT123"])(
    "refuses plain phone closed and opened without changing %s",
    async (deviceId) => {
      for (const posture of ["closed", "opened"] as const) {
        const adb = new FakeAdbExecutor();
        adb.setCommandResponse(
          "shell cmd device_state print-states",
          createExecResult(phoneStates, ""),
        );
        const device = makeDevice(deviceId);
        delete device.displays;
        const { feature, getObserveCount } = makeFeature(device, adb);
        const attempt = feature.execute(posture);
        await expect(attempt).rejects.toBeInstanceOf(ActionableError);
        await expect(attempt).rejects.toThrow("Supported postures: none. Nothing was changed.");
        expect(adb.getExecutedCommands()).toEqual(["shell cmd device_state print-states"]);
        expect(getObserveCount()).toBe(0);
      }
    },
  );

  test("reads fold support before dispatch when emulator inventory is absent", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell cmd device_state print-states", createExecResult(foldStates, ""));
    adb.setCommandResponse("shell cmd device_state state", createExecResult(closedState, ""));
    const device = makeDevice();
    delete device.displays;
    const { feature } = makeFeature(device, adb);
    await expect(feature.execute("closed")).resolves.toMatchObject({ posture: "closed" });
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd device_state print-states",
      "shell cmd device_state state reset",
      "emu fold",
      "shell cmd device_state state",
    ]);
  });

  test("refuses unavailable device_state service without hydrated fold support", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError(
      "shell cmd device_state print-states",
      new Error("Can't find service: device_state"),
    );
    const device = makeDevice();
    delete device.displays;
    const { feature } = makeFeature(device, adb);
    await expect(feature.execute("closed")).rejects.toThrow(
      "Supported postures: none. Nothing was changed.",
    );
    expect(adb.getExecutedCommands()).toEqual(["shell cmd device_state print-states"]);
  });

  test("falls back to print-states when hydration is marked unreadable", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell cmd device_state print-states",
      createExecResult(phoneStates, ""),
    );
    const device = makeDevice();
    device[displayInventoryOutcome] = { kind: "unreadable", reason: "inventory unavailable" };
    const { feature } = makeFeature(device, adb);
    await expect(feature.execute("closed")).rejects.toThrow("Nothing was changed.");
    expect(adb.getExecutedCommands()).toEqual(["shell cmd device_state print-states"]);
  });

  test("fails when an unmapped posture remains unknown after dispatch", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell cmd device_state print-states",
      createExecResult(phoneStates, ""),
    );
    const { feature, timer } = makeFeature(makeDevice(), adb, new FakeTimer(), {
      ...observation,
      display: { ...display, posture: "unknown" },
    });
    await expect(feature.execute("closed")).rejects.toThrow("observed posture is 'unknown'");
    expect(timer.now()).toBe(3000);
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd device_state print-states",
      "shell cmd device_state state reset",
      "emu fold",
    ]);
  });

  test("fails after command dispatch when the committed posture never changes", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell cmd device_state print-states", createExecResult(foldStates, ""));
    adb.setCommandResponse("shell cmd device_state state", createExecResult(openedState, ""));
    const { feature, timer, getObserveCount } = makeFeature(makeDevice(), adb);
    await expect(feature.execute("closed")).rejects.toThrow(
      "Posture command was sent, but the posture did not change to 'closed' after 3000 ms",
    );
    expect(adb.wasCommandExecuted("emu fold")).toBe(true);
    expect(timer.now()).toBe(3000);
    expect(getObserveCount()).toBe(0);
  });

  test("does not silently succeed for an inventory posture without a committed-state mapping", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell cmd device_state print-states", createExecResult(foldStates, ""));
    const { feature, timer } = makeFeature(makeDevice(), adb);
    await expect(feature.execute("tent")).rejects.toThrow(
      "Posture command was sent, but the posture did not change to 'tent' after 3000 ms",
    );
    expect(adb.wasCommandExecuted("emu posture 5")).toBe(true);
    expect(timer.now()).toBe(3000);
  });

  test("returns the real tracker generation after the fake observation notifies", async () => {
    const device = makeDevice();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell cmd device_state print-states", createExecResult(foldStates, ""));
    adb.setCommandResponse("shell cmd device_state state", createExecResult(closedState, ""));
    const { feature, tracker } = makeFeature(device, adb);
    const result = await feature.execute("closed");
    expect(tracker.identityRevision(device.deviceId)).toBe(1);
    expect("display" in result && result.display.generation).toBe(
      tracker.identityRevision(device.deviceId),
    );
  });

  test("refreshes cached Android posture on the same panel without a transition push", async () => {
    const device = makeDevice("posture-cache-regression");
    device.displays = {
      panels: [
        { key: display.key, role: "inner", sizePx: { width: 200, height: 300 } },
        { key: "panel-cover", role: "cover", sizePx: { width: 100, height: 150 } },
      ],
      postures: ["opened", "closed"],
    };
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell cmd device_state print-states", createExecResult(foldStates, ""));
    adb.setCommandResponse("shell cmd device_state state", createExecResult(openedState, ""));
    const cache = new ObservedAndroidDisplayCache(timer);
    const tracker = new DisplayTransitionTracker(() => {});
    const observe = async (): Promise<ObserveResult> => {
      const result = {
        ...observation,
        display: { ...display, posture: await cache.posture(device, adb) },
      };
      tracker.checkIdentity(device.deviceId, result.display);
      tracker.record(device.deviceId, result);
      return { ...result, displayRevision: tracker.revision(device.deviceId) };
    };
    try {
      expect((await observe()).display.posture).toBe("opened");
      const before = tracker.identityRevision(device.deviceId);
      adb.setCommandResponse("shell cmd device_state state", createExecResult(closedState, ""));
      // The cache is still warm and geometry/panel identity have not changed.
      expect(await cache.posture(device, adb)).toBe("opened");
      const feature = new SetPosture(device, {
        adbFactory: { create: () => adb },
        observeFactory: () => ({ execute: observe }) as ObserveScreen,
        timer,
        transitionSink: tracker,
      });
      const result = await feature.execute("closed");
      expect(result).toMatchObject({
        posture: "closed",
        display: { key: display.key, posture: "closed", generation: before + 1 },
      });
      expect(tracker.identityRevision(device.deviceId)).toBe(before + 1);
      expect(timer.now()).toBe(0);
    } finally {
      ObservedAndroidDisplayCache.release(device.deviceId);
    }
  });

  test("freshly captures Android final hierarchy when committed state changes without a display push", async () => {
    const device = makeDevice();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell cmd device_state print-states", createExecResult(foldStates, ""));
    adb.setCommandResponse("shell cmd device_state state", createExecResult(closedState, ""));
    const tracker = new DisplayTransitionTracker(() => {});
    const observe = new FakeObserveScreen();
    let capturedText: string | undefined;
    const execute = spyOn(observe, "execute").mockImplementation(async (options) => {
      // The legacy cache-eligible path can return the pre-posture hierarchy,
      // even though ObserveScreen stamps the newly assembled result as current.
      const viewHierarchy = {
        hierarchy: {
          node: { text: options?.freshness === "fresh" ? "after posture" : "before posture" },
        },
      };
      capturedText = viewHierarchy.hierarchy.node.text;
      return { ...observation, viewHierarchy, displayRevision: tracker.revision(device.deviceId) };
    });
    try {
      const feature = new SetPosture(device, {
        adbFactory: { create: () => adb },
        observeFactory: () => observe,
        timer: new FakeTimer(),
        transitionSink: tracker,
      });
      await expect(feature.execute("closed")).resolves.toMatchObject({ posture: "closed" });
      expect(capturedText).toBe("after posture");
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith({ freshness: "fresh", signal: undefined });
      expect(tracker.revision(device.deviceId)).toBe(0);
    } finally {
      execute.mockRestore();
    }
  });

  test("parses only the committed state, even when base and override differ", () => {
    expect(parseAndroidCommittedStateIdentifier(rearState)).toBe(3);
    expect(
      parseAndroidCommittedStateIdentifier(
        fixture("foldpf-6-fold-from-closed-base-while-override-state.txt"),
      ),
    ).toBe(3);
    expect(
      parseAndroidCommittedStateIdentifier(
        fixture("foldpf-2-rear-display-override-print-state.txt"),
      ),
    ).toBe(3);
  });

  test("maps each emulator posture to its console command and returns fresh display state", async () => {
    const mappings = [
      ["closed", ["shell cmd device_state state reset", "emu fold"]],
      ["half_opened", ["emu posture 2"]],
      ["opened", ["shell cmd device_state state reset", "emu unfold"]],
      ["flipped", ["emu posture 4"]],
      ["tent", ["emu posture 5"]],
    ] as const;

    for (const [posture, commands] of mappings) {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse(
        "shell cmd device_state print-states",
        createExecResult(phoneStates, ""),
      );
      const { feature, getObserveCount } = makeFeature(makeDevice(), adb, new FakeTimer(), {
        ...observation,
        display: { ...display, posture },
      });
      const result = await feature.execute(posture);
      expect(adb.getExecutedCommands()).toEqual([
        "shell cmd device_state print-states",
        ...commands,
      ]);
      expect(getObserveCount()).toBe(2);
      expect(result).toEqual({
        posture,
        display: { ...display, posture, generation: 2 },
        locked: true,
      });
    }
  });

  // am-flip-6p7 (mt-0083 D2): the console refuses fold/unfold but accepts `emu posture <n>`.
  test.each([
    ["opened", "emu unfold", "emu posture 3"],
    ["closed", "emu fold", "emu posture 1"],
  ] as const)(
    "falls back to the numeric posture when '%s' is refused as not foldable",
    async (posture, foldCommand, fallback) => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse(
        "shell cmd device_state print-states",
        createExecResult(phoneStates, ""),
      );
      adb.setCommandResponse(foldCommand, createExecResult("KO: Device is not foldable\r\n", ""));
      adb.setCommandResponse(fallback, createExecResult("OK\r\n", ""));
      const { feature } = makeFeature(makeDevice(), adb, new FakeTimer(), {
        ...observation,
        display: { ...display, posture },
      });
      const result = await feature.execute(posture);
      expect(adb.getExecutedCommands()).toEqual([
        "shell cmd device_state print-states",
        "shell cmd device_state state reset",
        foldCommand,
        fallback,
      ]);
      expect(result.posture).toBe(posture);
    },
  );

  test("a not-foldable refusal of the fallback posture command is still reported", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell cmd device_state print-states",
      createExecResult(phoneStates, ""),
    );
    adb.setCommandResponse("emu unfold", createExecResult("KO: Device is not foldable", ""));
    adb.setCommandResponse("emu posture 3", createExecResult("KO: Failed to set posture", ""));
    const { feature } = makeFeature(makeDevice(), adb, new FakeTimer());
    await expect(feature.execute("opened")).rejects.toThrow(
      "The emulator console refused 'emu posture 3': KO: Failed to set posture. The posture did not change.",
    );
  });

  test("other fold/unfold refusals fail without the numeric fallback", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell cmd device_state print-states",
      createExecResult(phoneStates, ""),
    );
    adb.setCommandResponse("emu fold", createExecResult("KO: console busy", ""));
    const { feature } = makeFeature(makeDevice(), adb, new FakeTimer());
    await expect(feature.execute("closed")).rejects.toThrow(
      "The emulator console refused 'emu fold': KO: console busy. The posture did not change.",
    );
    expect(adb.wasCommandExecuted("emu posture 1")).toBe(false);
  });

  test("sets the Resizable emulator display preset", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell cmd device_state print-states",
      createExecResult(phoneStates, ""),
    );
    const { feature } = makeFeature(
      makeDevice("emulator-5554", ["closed", "opened"]),
      adb,
      new FakeTimer(),
      {
        ...observation,
        display: { ...display, posture: "opened" },
      },
    );
    await feature.execute("opened", "tablet");
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd device_state print-states",
      "emu unfold",
      "emu resize-display 2",
    ]);
  });

  // SYNTHETIC console replies: no real capture of a refused posture/resize-display exists in
  // the repo (#9007 quotes the posture reply). Capture with, on a booted AVD:
  //   adb -s emulator-5554 emu posture 2          (then `adb ... emu resize-display 2` headless)
  describe("emulator console replies", () => {
    const refuseResize = "KO: resize-display is not supported";

    function foldableAdb(): FakeAdbExecutor {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse(
        "shell cmd device_state print-states",
        createExecResult(phoneStates, ""),
      );
      return adb;
    }

    function sizedFeature(
      adb: FakeAdbExecutor,
      sizes: { width: number; height: number }[],
      role: "inner" | "cover" | "unknown" = "inner",
      panels: DisplayPanel[] = [],
    ) {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const tracker = new DisplayTransitionTracker(() => {});
      const device = { ...makeDevice("emulator-5554", ["closed", "opened"]) };
      device.displays = { panels, postures: ["closed", "opened"] };
      let index = 0;
      const feature = new SetPosture(device, {
        adbFactory: { create: () => adb },
        observeFactory: () =>
          ({
            execute: async () => {
              const screenSize = sizes[Math.min(index++, sizes.length - 1)];
              tracker.notifyTransition(device.deviceId, "fake observed identity change");
              return {
                ...observation,
                display: { ...display, posture: "opened", role },
                screenSize,
                displayRevision: tracker.revision(device.deviceId),
              };
            },
          }) as ObserveScreen,
        timer,
        transitionSink: tracker,
      });
      return { feature, timer };
    }

    test("a refused resize-display fails the call with the console's reason", async () => {
      const adb = foldableAdb();
      adb.setCommandResponse("emu resize-display 2", createExecResult(refuseResize, ""));
      const { feature } = makeFeature(
        makeDevice("emulator-5554", ["closed", "opened"]),
        adb,
        new FakeTimer(),
        { ...observation, display: { ...display, posture: "opened" } },
      );
      const attempt = feature.execute("opened", "tablet");
      await expect(attempt).rejects.toBeInstanceOf(ActionableError);
      await expect(attempt).rejects.toThrow(
        "The emulator console refused 'emu resize-display 2': KO: resize-display is not supported",
      );
      await expect(attempt).rejects.toThrow("'tablet' display preset was not applied");
    });

    test("a refused resize-display on stderr is also reported", async () => {
      const adb = foldableAdb();
      adb.setCommandResponse("emu resize-display 2", createExecResult("", refuseResize));
      const { feature } = makeFeature(makeDevice("emulator-5554", ["closed", "opened"]), adb);
      await expect(feature.execute("opened", "tablet")).rejects.toThrow(refuseResize);
    });

    test("a refused posture command fails at once with the console's reason", async () => {
      const adb = foldableAdb();
      adb.setCommandResponse("emu posture 2", createExecResult("KO: Failed to set posture", ""));
      const timer = new FakeTimer();
      const { feature } = makeFeature(makeDevice(), adb, timer);
      const attempt = feature.execute("half_opened", "tablet");
      await expect(attempt).rejects.toThrow(
        "The emulator console refused 'emu posture 2': KO: Failed to set posture. The posture did not change.",
      );
      await expect(attempt).rejects.not.toThrow("device_state override");
      expect(timer.getSleepHistory()).toEqual([]);
      expect(adb.getExecutedCommands()).toEqual([
        "shell cmd device_state print-states",
        "emu posture 2",
      ]);
    });

    test("accepted OK replies still succeed without warnings", async () => {
      const adb = foldableAdb();
      adb.setCommandResponse("emu unfold", createExecResult("OK", ""));
      adb.setCommandResponse("emu resize-display 2", createExecResult("OK", ""));
      const { feature } = sizedFeature(adb, [{ width: 200, height: 300 }]);
      const result = await feature.execute("opened", "tablet");
      expect(result.warnings).toBeUndefined();
    });

    const cover: DisplayPanel = { key: "1", role: "cover", sizePx: { width: 100, height: 200 } };
    const inner: DisplayPanel = { key: "0", role: "inner", sizePx: { width: 300, height: 400 } };

    test("warns when the committed posture's panel has not swapped in", async () => {
      const adb = foldableAdb();
      const { feature } = sizedFeature(adb, [{ width: 200, height: 300 }], "cover", [cover, inner]);
      const result = await feature.execute("opened");
      expect(result.warnings).toEqual([
        expect.stringContaining("active display is still the cover panel rather than the inner"),
      ]);
    });

    test("stays silent when the active panel matches or the role is unknown", async () => {
      const adb = foldableAdb();
      const matching = sizedFeature(adb, [{ width: 200, height: 300 }], "inner", [cover, inner]);
      expect((await matching.feature.execute("opened")).warnings).toBeUndefined();
      const unknown = sizedFeature(foldableAdb(), [{ width: 200, height: 300 }], "unknown", [
        cover,
        inner,
      ]);
      expect((await unknown.feature.execute("opened")).warnings).toBeUndefined();
    });
  });

  test("uses observed posture when hydrated fold support exists but device_state is absent", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError(
      "shell cmd device_state print-states",
      new Error("Can't find service: device_state"),
    );
    const { feature } = makeFeature(
      makeDevice("emulator-5554", ["closed", "opened"]),
      adb,
      new FakeTimer(),
      {
        ...observation,
        display: { ...display, posture: "closed" },
      },
    );
    await feature.execute("closed");
    expect(adb.getExecutedCommands()).toEqual(["shell cmd device_state print-states", "emu fold"]);
  });

  test("uses the emulator rear display device state instead of closing its hinge", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell cmd device_state print-states", createExecResult(foldStates, ""));
    adb.setCommandResponse("shell cmd device_state state", createExecResult(rearState, ""));
    const { feature } = makeFeature(makeDevice(), adb);
    await feature.execute("rear_display");
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd device_state print-states",
      "shell cmd device_state state 3",
      "shell cmd device_state state",
    ]);
  });

  test("resets rear display state before unfolding the emulator", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell cmd device_state print-states", createExecResult(foldStates, ""));
    adb.setCommandResponseSequence("shell cmd device_state state", [
      createExecResult(rearState, ""),
      createExecResult(rearState, ""),
      createExecResult(openedState, ""),
      createExecResult(openedState, ""),
    ]);
    const { feature } = makeFeature(makeDevice(), adb);
    await feature.execute("rear_display");
    await feature.execute("opened");
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd device_state print-states",
      "shell cmd device_state state 3",
      "shell cmd device_state state",
      "shell cmd device_state print-states",
      "shell cmd device_state state reset",
      "emu unfold",
      "shell cmd device_state state",
    ]);
  });

  test("resets before closing and completes rear display to opened to closed", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell cmd device_state print-states", createExecResult(foldStates, ""));
    adb.setCommandResponseSequence("shell cmd device_state state", [
      createExecResult(rearState, ""),
      createExecResult(rearState, ""),
      createExecResult(openedState, ""),
      createExecResult(openedState, ""),
      createExecResult(closedState, ""),
      createExecResult(closedState, ""),
    ]);
    const { feature } = makeFeature(makeDevice(), adb);
    await feature.execute("rear_display");
    await feature.execute("opened");
    await feature.execute("closed");
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd device_state print-states",
      "shell cmd device_state state 3",
      "shell cmd device_state state",
      "shell cmd device_state print-states",
      "shell cmd device_state state reset",
      "emu unfold",
      "shell cmd device_state state",
      "shell cmd device_state print-states",
      "shell cmd device_state state reset",
      "emu fold",
      "shell cmd device_state state",
    ]);
  });

  test("polls committed state until opened is applied", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell cmd device_state print-states", createExecResult(foldStates, ""));
    adb.setCommandResponseSequence("shell cmd device_state state", [
      createExecResult(rearState, ""),
      createExecResult(fixture("foldpf-7-unfold-from-closed-base-while-override-state.txt"), ""),
      createExecResult(rearState, ""),
      createExecResult(openedState, ""),
    ]);
    const { feature, timer } = makeFeature(makeDevice(), adb);
    await feature.execute("opened");
    expect(timer.getSleepHistory()).toEqual([250, 250]);
    expect(
      adb.getExecutedCommands().filter((command) => command === "shell cmd device_state state"),
    ).toHaveLength(3);
  });

  test("reports the actual committed override when readback times out", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell cmd device_state print-states", createExecResult(foldStates, ""));
    adb.setCommandResponse(
      "shell cmd device_state state",
      createExecResult(fixture("foldpf-6-fold-from-closed-base-while-override-state.txt"), ""),
    );
    const { feature, timer } = makeFeature(makeDevice(), adb);
    const attempt = feature.execute("closed");
    await expect(attempt).rejects.toBeInstanceOf(ActionableError);
    await expect(attempt).rejects.toThrow(
      "'closed' after 3000 ms; committed state is 'rear_display' (REAR_DISPLAY_MODE, 3)",
    );
    expect(timer.now()).toBe(3000);
  });

  test("rejects rear display when it is absent from print-states", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell cmd device_state print-states",
      createExecResult(phoneStates, ""),
    );
    const { feature } = makeFeature(makeDevice(), adb);
    await expect(feature.execute("rear_display")).rejects.toThrow(
      "Posture 'rear_display' is not supported by this device. Supported postures: none.",
    );
    expect(adb.getExecutedCommands()).toEqual(["shell cmd device_state print-states"]);
  });

  test("parses physical print-states and sets the matching state identifier", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell cmd device_state print-states", createExecResult(foldStates, ""));
    adb.setCommandResponse("shell cmd device_state state", createExecResult(closedState, ""));
    const { feature } = makeFeature(makeDevice("R5CT123"), adb);
    const result = await feature.execute("closed");
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd device_state print-states",
      "shell cmd device_state state reset",
      "shell cmd device_state state 0",
      "shell cmd device_state state",
    ]);
    expect(result).toEqual({
      posture: "closed",
      display: { ...display, generation: 1 },
      locked: true,
    });
  });

  test("sets the matching physical device state for opened posture", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell cmd device_state print-states", createExecResult(foldStates, ""));
    adb.setCommandResponse("shell cmd device_state state", createExecResult(openedState, ""));
    const { feature } = makeFeature(makeDevice("R5CT123"), adb);
    await feature.execute("opened");
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd device_state print-states",
      "shell cmd device_state state reset",
      "shell cmd device_state state 2",
      "shell cmd device_state state",
    ]);
  });

  test("resets physical device state for opened posture when no opened state exists", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell cmd device_state print-states",
      createExecResult(phoneStates, ""),
    );
    const { feature, getObserveCount } = makeFeature(makeDevice("R5CT123"), adb, new FakeTimer(), {
      ...observation,
      display: { ...display, posture: "opened" },
    });
    await feature.execute("opened");
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd device_state print-states",
      "shell cmd device_state state reset",
    ]);
    expect(getObserveCount()).toBe(2);
  });

  test("rejects a posture absent from device inventory with supported postures", async () => {
    const adb = new FakeAdbExecutor();
    const { feature } = makeFeature(makeDevice("emulator-5554", ["closed", "opened"]), adb);
    await expect(feature.execute("tent")).rejects.toThrow(
      "Posture 'tent' is not supported by this device. Supported postures: closed, opened.",
    );
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  const duo: BootedDevice = {
    name: "iPhone Duo",
    platform: "ios",
    deviceId: "34C35F33-224C-4E74-B8C0-668FF03E49F5",
    deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
    displays: simulatorDeviceDisplays(
      parseSimulatorDisplays(loadDuoEnumerate()),
      "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
    ),
  };
  const sessionDuo: BootedDevice = {
    name: duo.name,
    platform: duo.platform,
    deviceId: duo.deviceId,
    displays: duo.displays,
  };
  const simulatorInfo: AppleDevice = {
    udid: duo.deviceId,
    name: duo.name,
    state: "Booted",
    isAvailable: true,
    deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro",
  };

  function makeIosFeature(
    device: BootedDevice = duo,
    observations: ObserveResult[] = [observation],
  ) {
    const client = new FakeIOSCtrlProxy();
    const simctl = new FakeSimCtlClient();
    simctl.setDeviceInfo(device.deviceId, simulatorInfo);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const sequence: string[] = [];
    const tracker = new DisplayTransitionTracker(() => {});
    const transitionSink: DisplayTransitionSink = {
      revision: (deviceId) => tracker.revision(deviceId),
      identityRevision: (deviceId) => tracker.identityRevision(deviceId),
      rememberIosPosture: (device, display, posture) =>
        tracker.rememberIosPosture(device, display, posture),
      notifyAndroidTransition: () => {},
      notifyTransition: (deviceId, reason) => {
        tracker.notifyTransition(deviceId, reason);
        sequence.push(`transition:${deviceId}:${reason}`);
      },
    };
    let observeCount = 0;
    const feature = new SetPosture(device, {
      iosClientProvider: () => client,
      simctl,
      observeFactory: () =>
        ({
          execute: async () => {
            observeCount += 1;
            sequence.push("observe");
            return {
              ...observations[Math.min(observeCount - 1, observations.length - 1)]!,
              displayRevision: tracker.revision(device.deviceId),
            };
          },
        }) as ObserveScreen,
      timer,
      transitionSink,
    });
    return {
      feature,
      client,
      simctl,
      timer,
      tracker,
      sequence,
      getObserveCount: () => observeCount,
    };
  }

  describe("session simulator foldability lookup", () => {
    test("Android validation never looks up simulator metadata", async () => {
      const simctl = new FakeSimCtlClient();
      const feature = new SetPosture(makeDevice("physical-android", ["opened"]), { simctl });
      await expect(feature.execute("closed")).rejects.toThrow("not supported by this device");
      expect(await feature.executeHingeAngle(90)).toMatchObject({ status: "unsupported" });
      expect(simctl.getMethodCalls("getDeviceInfo")).toEqual([]);
    });

    test.each([
      ["closed", 0],
      ["half_opened", 130],
      ["opened", 180],
    ] as const)("looks up Duo identity for %s and hingeAngle", async (posture, angle) => {
      const device = Object.freeze({ ...sessionDuo, displays: undefined });
      const h = makeIosFeature(device);
      h.simctl.setDeviceInfo(device.deviceId, {
        ...simulatorInfo,
        deviceTypeIdentifier: duo.deviceType,
      });
      h.client.supportedCommands = ["set_hinge_angle"];
      expect(h.simctl.getMethodCalls("getDeviceInfo")).toEqual([]);
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        expect(await h.feature.execute(posture)).toMatchObject({ posture });
        expect(await h.feature.executeHingeAngle(angle)).toMatchObject({ hingeAngle: angle });
        expect(h.client.getHingeAngleHistory()).toEqual([angle, angle]);
        expect(h.simctl.getMethodCalls("getDeviceInfo")).toEqual([
          { udid: device.deviceId },
          { udid: device.deviceId },
        ]);
        expect(device.deviceType).toBeUndefined();
        expect(device.displays).toBeUndefined();
        expect(h.timer.getSleepHistory()).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });

    test.each(["non-Duo", "throws", "null", "missing type"] as const)(
      "both forms fail closed when lookup %s",
      async (mode) => {
        const h = makeIosFeature({ ...sessionDuo, displays: undefined });
        const cause = new Error("simulator inventory unavailable");
        if (mode === "throws") {
          h.simctl.setDeviceInfoError(cause);
        }
        if (mode === "null") {
          h.simctl.setDeviceInfo(duo.deviceId, null);
        }
        if (mode === "missing type") {
          h.simctl.setDeviceInfo(duo.deviceId, {
            ...simulatorInfo,
            deviceTypeIdentifier: undefined,
          });
        }
        h.client.supportedCommands = ["set_hinge_angle"];
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        const hinge = spyOn(h.client, "requestSetHingeAngle");
        const clear = spyOn(ObservedAndroidDisplayCache, "clear");
        try {
          const unsupported = {
            status: "unsupported",
            message: "This iOS simulator is not a foldable device.",
          };
          for (const posture of ["closed", "half_opened", "opened"] as const) {
            expect(await h.feature.execute(posture)).toEqual(unsupported);
          }
          expect(await h.feature.executeHingeAngle(90)).toEqual(unsupported);
          expect(h.simctl.getMethodCalls("getDeviceInfo")).toEqual(
            Array(4).fill({ udid: duo.deviceId }),
          );
          expect(hinge).not.toHaveBeenCalled();
          expect(clear).not.toHaveBeenCalled();
          expect(h.tracker.identityRevision(duo.deviceId)).toBe(0);
          expect(h.sequence).toEqual([]);
          expect(pendingPostureOperationCountForTest()).toBe(0);
          expect(h.timer.getSleepHistory()).toEqual([]);
          if (mode === "non-Duo") {
            expect(warn).not.toHaveBeenCalled();
          } else if (mode === "throws") {
            expect(warn).toHaveBeenCalledWith(
              "[SetPosture] Failed to resolve simulator foldability: simulator inventory unavailable",
              cause,
            );
          } else {
            expect(warn).toHaveBeenCalledWith(
              `[SetPosture] Simulator device type is unavailable for ${duo.deviceId}`,
            );
          }
        } finally {
          warn.mockRestore();
          hinge.mockRestore();
          clear.mockRestore();
        }
      },
    );

    test.each(["posture", "hingeAngle"] as const)(
      "cancellation during lookup prevents %s dispatch and late side effects",
      async (form) => {
        const h = makeIosFeature({ ...sessionDuo, displays: undefined });
        const controller = new AbortController();
        const lookup = Promise.withResolvers<AppleDevice | null>();
        const started = Promise.withResolvers<void>();
        const getInfo = spyOn(h.simctl, "getDeviceInfo").mockImplementation(() => {
          started.resolve();
          return lookup.promise;
        });
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        const clear = spyOn(ObservedAndroidDisplayCache, "clear");
        try {
          const result =
            form === "posture"
              ? h.feature.execute("closed", undefined, controller.signal)
              : h.feature.executeHingeAngle(90, { signal: controller.signal });
          await started.promise;
          controller.abort();
          await expect(result).rejects.toThrow("Posture request cancelled;");
          lookup.resolve({ ...simulatorInfo, deviceTypeIdentifier: duo.deviceType });
          await lookup.promise;
          expect(h.client.getHingeAngleHistory()).toEqual([]);
          expect(clear).not.toHaveBeenCalled();
          expect(warn).not.toHaveBeenCalled();
          expect(h.tracker.identityRevision(duo.deviceId)).toBe(0);
          expect(h.sequence).toEqual([]);
          expect(pendingPostureOperationCountForTest()).toBe(0);
        } finally {
          getInfo.mockRestore();
          warn.mockRestore();
          clear.mockRestore();
        }
      },
    );

    test("physical iOS refusal precedes lookup for both forms", async () => {
      const h = makeIosFeature({
        ...sessionDuo,
        deviceId: "00008120-001C191E0E99003A",
        displays: undefined,
      });
      for (const result of [
        await h.feature.execute("tent"),
        await h.feature.executeHingeAngle(90),
      ]) {
        expect(result).toEqual({
          status: "unsupported",
          message: "Physical iOS hinge posture can only be read, not set.",
        });
      }
      expect(h.simctl.getMethodCalls("getDeviceInfo")).toEqual([]);
      expect(h.client.getHingeAngleHistory()).toEqual([]);
    });
  });

  test.each([
    {
      ...duo,
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro",
      displays: { panels: [duo.displays!.panels[1]!], postures: ["opened" as const] },
    },
    // Explicit non-Duo identity wins even if a stale inventory claims Duo panels.
    { ...duo, deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro" },
    {
      ...sessionDuo,
      displays: { panels: [duo.displays!.panels[1]!], postures: ["opened" as const] },
    },
    {
      ...sessionDuo,
      displays: { panels: [duo.displays!.panels[0]!], postures: ["closed" as const] },
    },
    { ...sessionDuo, displays: { panels: [], postures: [] } },
    { ...sessionDuo, displays: undefined },
  ])("both forms refuse an iOS simulator without foldable evidence: %j", async (device) => {
    const h = makeIosFeature(device);
    h.client.supportedCommands = ["set_hinge_angle"];
    const hinge = spyOn(h.client, "requestSetHingeAngle");
    const clear = spyOn(ObservedAndroidDisplayCache, "clear");
    const unsupported = {
      status: "unsupported",
      message: "This iOS simulator is not a foldable device.",
    };
    try {
      for (const posture of [
        "closed",
        "half_opened",
        "opened",
        "rear_display",
        "flipped",
        "tent",
      ] as const) {
        expect(await h.feature.execute(posture)).toEqual(unsupported);
      }
      expect(await h.feature.executeHingeAngle(90)).toEqual(unsupported);
      expect(hinge).not.toHaveBeenCalled();
      expect(clear).not.toHaveBeenCalled();
      expect(h.sequence).toEqual([]);
      expect(h.tracker.identityRevision(device.deviceId)).toBe(0);
      expect(h.getObserveCount()).toBe(0);
      if (device.deviceType !== undefined) {
        expect(h.simctl.getMethodCalls("getDeviceInfo")).toEqual([]);
      }
    } finally {
      hinge.mockRestore();
      clear.mockRestore();
    }
  });

  describe("best effort hinge angles", () => {
    function makeAndroidAngleHarness() {
      const console = new FakeAndroidHingeAngleConsole();
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse(
        "shell cmd device_state print-states",
        createExecResult(foldStates, ""),
      );
      adb.setCommandResponse("shell cmd device_state state", createExecResult(openedState, ""));
      const tracker = new DisplayTransitionTracker(() => {});
      const observe = new FakeObserveScreen();
      observe.setObserveResult({
        ...observation,
        display: { ...display, posture: "opened" },
        displayRevision: tracker.revision("emulator-5554"),
      });
      const feature = new SetPosture(makeDevice(), {
        androidHingeAngleConsole: console,
        adbFactory: { create: () => adb },
        observeFactory: () => observe,
        transitionSink: tracker,
        timer: new FakeTimer(),
      });
      return { feature, console, adb, observe };
    }

    test.each([
      ["hinge-angle0-get.txt", 180],
      ["hinge-angle0-get-120.txt", 120],
    ] as const)("Android captured %s verifies a request for 120", async (name, actual) => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse(
        "shell cmd device_state print-states",
        createExecResult(foldStates, ""),
      );
      adb.setCommandResponse("shell cmd device_state state", createExecResult(openedState, ""));
      const { feature } = makeFeature(makeDevice(), adb, new FakeTimer(), {
        ...observation,
        display: { ...display, posture: "opened" },
      });
      adb.setCommandResponse("emu sensor get hinge-angle0", createExecResult(fixture(name), ""));
      const result = await feature.executeHingeAngle(120);
      expect(result).toMatchObject({ hingeAngle: 120, observedHingeAngle: actual });
      if (actual === 180) {
        expect(result).toMatchObject({
          warnings: [
            "Hinge angle read-back mismatch: requested 120 degrees but the emulator reports 180 degrees. The emulator console returned OK but did not apply the angle (hinge angle is best effort).",
          ],
        });
      } else {
        expect("warnings" in result).toBe(false);
      }
    });

    test("Android KO read-back warns that the requested angle could not be verified", async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse(
        "shell cmd device_state print-states",
        createExecResult(foldStates, ""),
      );
      adb.setCommandResponse("shell cmd device_state state", createExecResult(openedState, ""));
      const { feature } = makeFeature(makeDevice(), adb, new FakeTimer(), {
        ...observation,
        display: { ...display, posture: "opened" },
      });
      adb.setCommandResponse(
        "emu sensor get hinge-angle0",
        createExecResult("KO: unknown sensor\r\n", ""),
      );
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const result = await feature.executeHingeAngle(120);
        expect(result).toMatchObject({
          hingeAngle: 120,
          warnings: [
            "Could not verify hinge angle: KO: unknown sensor. The emulator console accepted the request but the angle was not read back.",
          ],
        });
        expect("observedHingeAngle" in result).toBe(false);
      } finally {
        warn.mockRestore();
      }
    });

    test("Android mismatch warns with both angles while preserving a success-shaped result", async () => {
      const h = makeAndroidAngleHarness();
      h.console.readBackResult = { ok: true, degrees: 180 };
      const result = await h.feature.executeHingeAngle(120);
      expect(result).toMatchObject({
        hingeAngle: 120,
        observedHingeAngle: 180,
        posture: "opened",
        warnings: [
          expect.stringContaining("requested 120 degrees but the emulator reports 180 degrees"),
        ],
      });
      expect("status" in result).toBe(false);
    });

    test.each(["failure result", "command error"])(
      "Android read-back %s warns and logs",
      async (mode) => {
        const h = makeAndroidAngleHarness();
        if (mode === "failure result") {
          h.console.readBackResult = { ok: false, reason: "KO: unknown sensor" };
        } else {
          h.console.readBackError = new Error("adb read timed out");
        }
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        try {
          const result = await h.feature.executeHingeAngle(120);
          expect(result).toMatchObject({
            hingeAngle: 120,
            warnings: [expect.stringContaining("Could not verify hinge angle:")],
          });
          expect("observedHingeAngle" in result).toBe(false);
          expect("status" in result).toBe(false);
          expect(warn).toHaveBeenCalled();
        } finally {
          warn.mockRestore();
        }
      },
    );

    test.each([119, 120, 121, undefined])(
      "Android matching read-back %s has no warning",
      async (actual) => {
        const h = makeAndroidAngleHarness();
        if (actual !== undefined) {
          h.console.readBackResult = { ok: true, degrees: actual };
        }
        const signal = new AbortController().signal;
        const result = await h.feature.executeHingeAngle(120, { signal });
        expect(result).toMatchObject({ hingeAngle: 120, observedHingeAngle: actual ?? 120 });
        expect("warnings" in result).toBe(false);
        expect(h.console.readBackCalls).toEqual([{ signal }]);
      },
    );

    test("Android abort during angle read-back propagates without further device work", async () => {
      const h = makeAndroidAngleHarness();
      const controller = new AbortController();
      const started = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<{ ok: true; degrees: number }>();
      const read = spyOn(h.console, "getHingeAngle").mockImplementation(async (_adb, options) => {
        expect(options?.signal).toBe(controller.signal);
        started.resolve();
        return pending.promise;
      });
      const attempt = h.feature.executeHingeAngle(120, { signal: controller.signal });
      const outcome = attempt.catch((error: unknown) => error);
      try {
        await started.promise;
        controller.abort();
        expect(await outcome).toBeInstanceOf(ActionableError);
        expect(h.adb.getExecutedCommands()).toEqual([]);
        expect(h.observe.getExecuteOptions()).toEqual([]);
        expect(pendingPostureOperationCountForTest()).toBe(0);
      } finally {
        pending.resolve({ ok: true, degrees: 120 });
        read.mockRestore();
      }
    });

    test("Android read-back warnings merge with stale observation warnings", async () => {
      const h = makeAndroidAngleHarness();
      h.console.readBackResult = { ok: true, degrees: 180 };
      h.observe.setObserveResult({ ...observation, displayRevision: undefined });
      const result = await h.feature.executeHingeAngle(120);
      expect("warnings" in result && result.warnings).toEqual([
        expect.stringContaining("observation predates"),
        expect.stringContaining("requested 120 degrees"),
      ]);
    });

    test.each([119, 120, 121, 180, undefined])(
      "iOS reported angle %s is compared with the request",
      async (actual) => {
        const h = makeIosFeature(duo, [
          {
            ...observation,
            screenSize: { width: 2007, height: 2853 },
            display: { ...display, posture: "half_opened" },
          },
        ]);
        h.client.supportedCommands = ["set_hinge_angle"];
        h.client.setHingeAngleResult({ success: true, angle: actual, totalTimeMs: 0 });
        const result = await h.feature.executeHingeAngle(120);
        expect(result).toMatchObject({ hingeAngle: 120, posture: "half_opened" });
        expect("status" in result).toBe(false);
        if (actual === undefined) {
          expect(result).toMatchObject({
            warnings: [
              "Hinge angle not verifiable: the iPhone Duo runner did not report the resulting angle.",
            ],
          });
          expect("observedHingeAngle" in result).toBe(false);
        } else {
          expect(result).toMatchObject({ observedHingeAngle: actual });
          if (actual === 180) {
            expect(result).toMatchObject({
              warnings: [
                expect.stringContaining(
                  "requested 120 degrees but the iPhone Duo runner reports 180 degrees",
                ),
              ],
            });
          } else {
            expect("warnings" in result).toBe(false);
          }
        }
      },
    );

    test.each([-1, 181, NaN, Infinity, -Infinity])(
      "direct angle %s is actionable",
      async (angle) => {
        const adb = new FakeAdbExecutor();
        const { feature } = makeFeature(makeDevice(), adb);
        await expect(feature.executeHingeAngle(angle)).rejects.toBeInstanceOf(ActionableError);
        expect(adb.getExecutedCommands()).toEqual([]);
      },
    );

    test("angle plus preset rejects without I/O", async () => {
      const adb = new FakeAdbExecutor();
      const { feature } = makeFeature(makeDevice(), adb);
      await expect(feature.executeHingeAngle(90, { displayPreset: "phone" })).rejects.toThrow(
        "displayPreset",
      );
      expect(adb.getExecutedCommands()).toEqual([]);
    });

    test.each([0, 90, 180])(
      "Android OK at %s reports committed fixture posture and one generation",
      async (angle) => {
        const adb = new FakeAdbExecutor();
        const command = `emu sensor set hinge-angle0 ${angle}`;
        adb.setCommandResponse(command, createExecResult("OK", ""));
        adb.setCommandResponse(
          "shell cmd device_state print-states",
          createExecResult(foldStates, ""),
        );
        adb.setCommandResponse("shell cmd device_state state", createExecResult(closedState, ""));
        const observed = { ...observation, display: { ...display, posture: "closed" as const } };
        const device = makeDevice();
        const h = makeFeature(device, adb, new FakeTimer(), observed);
        const send = spyOn(adb, "executeCommand");
        const result = await h.feature.executeHingeAngle(angle);
        expect(result).toMatchObject({
          hingeAngle: angle,
          posture: "closed",
          display: { generation: 1 },
        });
        expect(result).toMatchObject({ observedHingeAngle: 180 });
        expect(adb.getExecutedCommands()).toEqual([
          command,
          "emu sensor get hinge-angle0",
          "shell cmd device_state print-states",
          "shell cmd device_state state",
        ]);
        expect(send.mock.calls[0]).toEqual([command, undefined, undefined, true, undefined]);
        expect(send.mock.calls[1]).toEqual([
          "emu sensor get hinge-angle0",
          undefined,
          undefined,
          true,
          undefined,
        ]);
        if (angle === 180) {
          expect("warnings" in result).toBe(false);
        } else {
          expect(result).toMatchObject({
            warnings: [expect.stringContaining(`requested ${angle} degrees`)],
          });
        }
        const postureAdb = new FakeAdbExecutor();
        postureAdb.setCommandResponse(
          "shell cmd device_state print-states",
          createExecResult(foldStates, ""),
        );
        postureAdb.setCommandResponse(
          "shell cmd device_state state",
          createExecResult(closedState, ""),
        );
        const posture = await makeFeature(
          device,
          postureAdb,
          new FakeTimer(),
          observed,
        ).feature.execute("closed");
        expect("display" in result && result.display.generation).toBe(
          "display" in posture && posture.display.generation,
        );
        expect(h.tracker.identityRevision(device.deviceId)).toBe(1);
        send.mockRestore();
      },
    );

    test.each(["stdout", "stderr"] as const)(
      "console KO in %s is unsupported with raw first line and no side effects",
      async (channel) => {
        const adb = new FakeAdbExecutor();
        const raw = "  KO: bad delay";
        adb.setCommandResponse(
          "emu sensor set",
          createExecResult(
            channel === "stdout" ? `\n${raw}\n` : "",
            channel === "stderr" ? `\n${raw}\n` : "",
          ),
        );
        const h = makeFeature(makeDevice(), adb);
        const result = await h.feature.executeHingeAngle(90);
        expect(result).toMatchObject({
          status: "unsupported",
          message: expect.stringContaining(raw),
        });
        expect(adb.getExecutedCommands()).toEqual(["emu sensor set hinge-angle0 90"]);
        expect(h.getObserveCount()).toBe(0);
        expect(h.tracker.identityRevision("emulator-5554")).toBe(0);
      },
    );

    test("console command errors remain operational failures", async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandError("emu sensor set", new Error("adb unreachable"));
      const h = makeFeature(makeDevice(), adb);
      await expect(h.feature.executeHingeAngle(90)).rejects.toBeInstanceOf(ActionableError);
      expect(adb.getExecutedCommands()).toEqual(["emu sensor set hinge-angle0 90"]);
      expect(h.getObserveCount()).toBe(0);
    });

    test("known committed and observed postures must agree", async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("emu sensor set", createExecResult("OK", ""));
      adb.setCommandResponse(
        "shell cmd device_state print-states",
        createExecResult(foldStates, ""),
      );
      adb.setCommandResponse("shell cmd device_state state", createExecResult(closedState, ""));
      const h = makeFeature(makeDevice(), adb);
      const attempt = h.feature.executeHingeAngle(90);
      await expect(attempt).rejects.toBeInstanceOf(ActionableError);
      await expect(attempt).rejects.toThrow("returned OK");
      await expect(attempt).rejects.toThrow("closed");
      await expect(attempt).rejects.toThrow("half_opened");
    });

    test.each(["unmapped", "unavailable", "unreadable"])(
      "%s device state is unknown rather than an angle guess",
      async (mode) => {
        const adb = new FakeAdbExecutor();
        adb.setCommandResponse("emu sensor set", createExecResult("OK", ""));
        adb.setCommandResponse(
          "shell cmd device_state print-states",
          createExecResult(mode === "unmapped" ? phoneStates : foldStates, ""),
        );
        if (mode === "unavailable") {
          adb.setCommandError(
            "shell cmd device_state state",
            new Error("Can't find service: device_state"),
          );
        } else {
          adb.setCommandResponse(
            "shell cmd device_state state",
            createExecResult(mode === "unreadable" ? "" : closedState, ""),
          );
        }
        const h = makeFeature(makeDevice(), adb);
        expect(await h.feature.executeHingeAngle(90)).toMatchObject({
          hingeAngle: 90,
          posture: "unknown",
          postureReason: expect.any(String),
        });
        if (mode !== "unavailable") {
          expect(h.timer.now()).toBe(3000);
        }
      },
    );

    test("a known committed posture remains device read-back when observation posture is unknown", async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("emu sensor set", createExecResult("OK", ""));
      adb.setCommandResponse(
        "shell cmd device_state print-states",
        createExecResult(foldStates, ""),
      );
      adb.setCommandResponse("shell cmd device_state state", createExecResult(closedState, ""));
      const h = makeFeature(makeDevice(), adb, new FakeTimer(), {
        ...observation,
        display: { ...display, posture: "unknown" },
      });
      expect(await h.feature.executeHingeAngle(90)).toMatchObject({
        hingeAngle: 90,
        posture: "closed",
      });
    });

    test("polls a temporarily unreadable committed state within the injected budget", async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("emu sensor set", createExecResult("OK", ""));
      adb.setCommandResponse(
        "shell cmd device_state print-states",
        createExecResult(foldStates, ""),
      );
      adb.setCommandResponseSequence("shell cmd device_state state", [
        createExecResult("", ""),
        createExecResult(closedState, ""),
      ]);
      const h = makeFeature(makeDevice(), adb, new FakeTimer(), {
        ...observation,
        display: { ...display, posture: "closed" },
      });
      expect(await h.feature.executeHingeAngle(90)).toMatchObject({ posture: "closed" });
      expect(h.timer.now()).toBe(250);
      expect(h.timer.getSleepHistory()).toContain(250);
    });

    test("unavailable state inventory cannot guess a posture from the final display", async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("emu sensor set", createExecResult("OK", ""));
      adb.setCommandError(
        "shell cmd device_state print-states",
        new Error("Can't find service: device_state"),
      );
      adb.setCommandResponse("shell cmd device_state state", createExecResult(closedState, ""));
      const h = makeFeature(makeDevice(), adb);
      expect(await h.feature.executeHingeAngle(90)).toMatchObject({
        posture: "unknown",
        postureReason: expect.any(String),
      });
      expect(h.timer.now()).toBe(3000);
    });

    test("an operational committed-state error fails after console acceptance", async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("emu sensor set", createExecResult("OK", ""));
      adb.setCommandResponse(
        "shell cmd device_state print-states",
        createExecResult(foldStates, ""),
      );
      adb.setCommandError("shell cmd device_state state", new Error("adb timed out"));
      const h = makeFeature(makeDevice(), adb);
      await expect(h.feature.executeHingeAngle(90)).rejects.toThrow("adb timed out");
      expect(h.getObserveCount()).toBe(0);
    });

    test("stale-twice Android angle observation preserves generation and reports unknown", async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("emu sensor set", createExecResult("OK", ""));
      adb.setCommandResponse(
        "shell cmd device_state print-states",
        createExecResult(foldStates, ""),
      );
      adb.setCommandResponse("shell cmd device_state state", createExecResult(closedState, ""));
      adb.setCommandResponse(
        "emu sensor get hinge-angle0",
        createExecResult(hingeAngleReadBack, ""),
      );
      const tracker = new DisplayTransitionTracker(() => {});
      const observed = new FakeObserveScreen();
      observed.setObserveResult({ ...observation, displayRevision: undefined });
      const feature = new SetPosture(makeDevice(), {
        adbFactory: { create: () => adb },
        observeFactory: () => observed,
        transitionSink: tracker,
        timer: new FakeTimer(),
      });
      expect(await feature.executeHingeAngle(90)).toMatchObject({
        hingeAngle: 90,
        posture: "unknown",
        postureReason: expect.stringContaining("provenance"),
        display: { generation: 4 },
        warnings: expect.any(Array),
      });
      expect(observed.getExecuteOptions()).toHaveLength(2);
    });

    test("Android console can be replaced by the narrow fake", async () => {
      const console = new FakeAndroidHingeAngleConsole();
      console.result = { ok: false, reason: "KO: bad speed" };
      const adb = new FakeAdbExecutor();
      const feature = new SetPosture(makeDevice(), {
        androidHingeAngleConsole: console,
        adbFactory: { create: () => adb },
        timer: new FakeTimer(),
      });
      expect(await feature.executeHingeAngle(90)).toMatchObject({
        status: "unsupported",
        message: expect.stringContaining("KO: bad speed"),
      });
      expect(console.calls).toEqual([{ degrees: 90, signal: undefined }]);
      expect(adb.getExecutedCommands()).toEqual([]);
    });

    test("physical Android angle is unsupported without sending anything", async () => {
      const adb = new FakeAdbExecutor();
      const h = makeFeature(makeDevice("R5CT123"), adb);
      expect(await h.feature.executeHingeAngle(90)).toMatchObject({
        status: "unsupported",
        message: expect.stringContaining("emulator console"),
      });
      expect(adb.getExecutedCommands()).toEqual([]);
    });

    test.each([0, 90, 180])(
      "advertised iOS angle %s uses panel read-back and runner angle",
      async (angle) => {
        const h = makeIosFeature(duo, [
          {
            ...observation,
            screenSize: { width: 2007, height: 2853 },
            display: { ...display, posture: "half_opened" },
          },
        ]);
        h.client.supportedCommands = ["set_hinge_angle"];
        h.client.setHingeAngleResult({ success: true, angle: 89, totalTimeMs: 0 });
        expect(await h.feature.executeHingeAngle(angle)).toMatchObject({
          hingeAngle: angle,
          observedHingeAngle: 89,
          posture: "half_opened",
          display: { generation: 2 },
        });
        expect(h.client.getHingeAngleHistory()).toEqual([angle]);
        expect(h.sequence.filter((entry) => entry.startsWith("transition:"))).toHaveLength(2);
      },
    );

    test("iOS cover reports closed even at an arbitrary angle and missing runner angle is omitted", async () => {
      const h = makeIosFeature(duo, [
        {
          ...observation,
          screenSize: { width: 1398, height: 2034 },
          display: { ...display, role: "cover", posture: "closed" },
        },
      ]);
      h.client.supportedCommands = ["set_hinge_angle"];
      h.client.setHingeAngleResult({ success: true, totalTimeMs: 0 });
      const result = await h.feature.executeHingeAngle(150);
      expect(result).toMatchObject({ hingeAngle: 150, posture: "closed" });
      expect("observedHingeAngle" in result).toBe(false);
    });

    test("indeterminate iOS panel reports unknown with a reason", async () => {
      const h = makeIosFeature();
      h.client.supportedCommands = ["set_hinge_angle"];
      expect(await h.feature.executeHingeAngle(90)).toMatchObject({
        hingeAngle: 90,
        posture: "unknown",
        postureReason: expect.any(String),
      });
    });

    test.each([{ supported: null }, { supported: [] }, { supported: ["tap"] }])(
      "unadvertised iOS runner %j requests a re-cut without sending or notifying",
      async ({ supported }) => {
        const h = makeIosFeature();
        h.client.supportedCommands = supported;
        expect(await h.feature.executeHingeAngle(90)).toMatchObject({
          status: "unsupported",
          message: expect.stringContaining("re-cut"),
        });
        expect(h.client.getHingeAngleHistory()).toEqual([]);
        expect(h.sequence).toEqual([]);
      },
    );

    test("absent iOS capability method requests a runner re-cut", async () => {
      const h = makeIosFeature();
      Object.defineProperty(h.client, "getSupportedCommands", { value: undefined });
      const result = await h.feature.executeHingeAngle(90);
      expect(result).toMatchObject({
        status: "unsupported",
        message: expect.stringContaining("8547"),
      });
      expect(h.client.getHingeAngleHistory()).toEqual([]);
      expect(h.sequence).toEqual([]);
    });

    test("iOS runner failures after advertising remain actionable", async () => {
      const h = makeIosFeature();
      h.client.supportedCommands = ["set_hinge_angle"];
      h.client.setHingeAngleResult({
        success: false,
        error: "Rejected hinge event",
        totalTimeMs: 0,
      });
      await expect(h.feature.executeHingeAngle(90)).rejects.toThrow("Rejected hinge event");
      expect(h.sequence).toEqual([]);
    });

    test("iOS angle requires foldable evidence before capability probing", async () => {
      // A Duo type now suffices, so exercise a session device lacking both forms of evidence.
      const h = makeIosFeature({ ...sessionDuo, displays: { panels: [], postures: ["opened"] } });
      h.client.supportedCommands = ["set_hinge_angle"];
      expect(await h.feature.executeHingeAngle(90)).toEqual({
        status: "unsupported",
        message: "This iOS simulator is not a foldable device.",
      });
      expect(h.client.getHingeAngleHistory()).toEqual([]);
    });

    test.each([
      { ...duo, deviceId: "physical-iphone" },
      { ...duo, deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16" },
    ])("unsupported iOS target %j sends nothing", async (device) => {
      const h = makeIosFeature(device);
      h.client.supportedCommands = ["set_hinge_angle"];
      expect(await h.feature.executeHingeAngle(90)).toMatchObject({ status: "unsupported" });
      expect(h.client.getHingeAngleHistory()).toEqual([]);
      expect(h.sequence).toEqual([]);
    });
  });

  for (const invalidation of [
    "transition",
    "release",
    "device change",
    "panel mismatch",
  ] as const) {
    test(`remembers settled iOS half_opened until ${invalidation}`, async () => {
      const tracker = new DisplayTransitionTracker(() => {});
      const inner = { pixelWidth: 2007, pixelHeight: 2853 };
      const cover = { pixelWidth: 1398, pixelHeight: 2034 };
      const client = new FakeIOSCtrlProxy();
      const feature = new SetPosture(duo, {
        iosClientProvider: () => client,
        transitionSink: tracker,
        timer: new FakeTimer(),
        observeFactory: () =>
          ({
            execute: async () => {
              const result = {
                ...observation,
                display: observedIosDisplay(duo, inner),
                screenSize: { width: 669, height: 951 },
              };
              tracker.record(duo.deviceId, result, "ios");
              return { ...result, displayRevision: tracker.revision(duo.deviceId) };
            },
          }) as ObserveScreen,
      });
      try {
        const result = await feature.execute("half_opened");
        expect(result).toMatchObject({
          posture: "half_opened",
          display: { posture: "half_opened" },
        });
        const next = observedIosDisplay(duo, inner);
        expect(next.posture).toBe("half_opened");
        const generation = tracker.identityRevision(duo.deviceId);
        expect(tracker.checkIdentity(duo.deviceId, next, "ios")).toBe(false);
        expect(
          tracker.checkIosGeometry(duo.deviceId, { width: 669, height: 951 }, undefined, next),
        ).toBe(false);
        expect(
          tracker.record(
            duo.deviceId,
            { display: next, screenSize: { width: 669, height: 951 } },
            "ios",
          ),
        ).toBe(false);
        expect(tracker.identityRevision(duo.deviceId)).toBe(generation);
        if (invalidation === "transition") {
          tracker.notifyTransition(duo.deviceId, "rotation");
        } else if (invalidation === "release") {
          tracker.reset(duo.deviceId);
        } else if (invalidation === "device change") {
          ObservedAndroidDisplayCache.clear(duo.deviceId);
        } else {
          expect(observedIosDisplay(duo, cover).posture).toBe("closed");
        }
        expect(observedIosDisplay(duo, inner).posture).toBe("opened");
      } finally {
        tracker.reset(duo.deviceId);
      }
    });
  }

  test("clears remembered iOS posture before sending the hinge request", async () => {
    const inner = { pixelWidth: 2007, pixelHeight: 2853 };
    ObservedAndroidDisplayCache.release(duo.deviceId);
    const innerDisplay = observedIosDisplay(duo, inner);
    ObservedAndroidDisplayCache.rememberIosPosture(duo.deviceId, {
      ...innerDisplay,
      posture: "half_opened",
    });
    const { feature, client } = makeIosFeature(duo, [
      { ...observation, display: innerDisplay, screenSize: { width: 669, height: 951 } },
    ]);
    const hinge = spyOn(client, "requestSetHingeAngle").mockImplementation(async () => {
      expect(observedIosDisplay(duo, inner).posture).toBe("opened");
      return { success: true, totalTimeMs: 0 };
    });
    try {
      await expect(feature.execute("half_opened")).resolves.toMatchObject({
        display: { posture: "half_opened" },
      });
      expect(hinge).toHaveBeenCalledWith(130);
      expect(observedIosDisplay(duo, inner).posture).toBe("half_opened");
    } finally {
      hinge.mockRestore();
      ObservedAndroidDisplayCache.release(duo.deviceId);
    }
  });

  test("does not remember iOS posture when both panel-valid final observations stayed stale", async () => {
    const inner = { pixelWidth: 2007, pixelHeight: 2853 };
    ObservedAndroidDisplayCache.release(duo.deviceId);
    const tracker = new DisplayTransitionTracker(() => {});
    const remember = spyOn(tracker, "rememberIosPosture");
    const observe = new FakeObserveScreen();
    observe.setObserveResult((index) => ({
      ...observation,
      display: { ...observedIosDisplay(duo, inner), generation: index + 1 },
      screenSize: { width: 669, height: 951 },
      displayRevision: tracker.revision(duo.deviceId) - 1,
    }));
    const timer = new FakeTimer();
    const feature = new SetPosture(duo, {
      observeFactory: () => observe,
      iosClientProvider: () => new FakeIOSCtrlProxy(timer),
      timer,
      transitionSink: tracker,
    });
    try {
      await expect(feature.execute("half_opened")).resolves.toMatchObject({
        posture: "half_opened",
        display: { posture: "opened", generation: 2 },
        warnings: [expect.any(String)],
      });
      expect(observe.getExecuteOptions()).toHaveLength(2);
      expect(remember).not.toHaveBeenCalled();
      expect(observedIosDisplay(duo, inner).posture).toBe("opened");
      expect(tracker.revision(duo.deviceId)).toBe(2);
    } finally {
      remember.mockRestore();
      tracker.reset(duo.deviceId);
    }
  });

  test("a cancelled or failed iOS hinge request clears the remembered posture", async () => {
    const inner = { pixelWidth: 2007, pixelHeight: 2853 };
    for (const failure of ["abort", "runner failure"] as const) {
      ObservedAndroidDisplayCache.release(duo.deviceId);
      const { feature, client } = makeIosFeature(duo, [
        {
          ...observation,
          display: observedIosDisplay(duo, inner),
          screenSize: { width: 669, height: 951 },
        },
      ]);
      try {
        await feature.execute("half_opened");
        expect(observedIosDisplay(duo, inner).posture).toBe("half_opened");
        if (failure === "abort") {
          const pending = spyOn(client, "requestSetHingeAngle").mockImplementation(() => {
            expect(observedIosDisplay(duo, inner).posture).toBe("opened");
            return new Promise(() => {});
          });
          try {
            const controller = new AbortController();
            const attempt = feature.execute("opened", undefined, controller.signal);
            // Acquiring the shared lock yields once, even when uncontended.
            await Promise.resolve();
            expect(pending).toHaveBeenCalledWith(180);
            controller.abort();
            await expect(attempt).rejects.toThrow();
          } finally {
            pending.mockRestore();
          }
        } else {
          client.setHingeAngleResult({ success: false, error: "hinge failed", totalTimeMs: 0 });
          await expect(feature.execute("opened")).rejects.toThrow("hinge failed");
        }
        expect(observedIosDisplay(duo, inner).posture).toBe("opened");
      } finally {
        ObservedAndroidDisplayCache.release(duo.deviceId);
      }
    }
  });

  test.each([
    duo,
    sessionDuo,
    { ...duo, displays: undefined },
    { ...duo, displays: { panels: [duo.displays!.panels[1]!], postures: ["opened" as const] } },
  ])("both forms accept Duo type or hydrated Duo panels: %j", async (device) => {
    for (const [posture, angle] of [
      ["closed", 0],
      ["half_opened", 130],
      ["opened", 180],
    ] as const) {
      const expectedDisplay = {
        ...display,
        key: posture === "closed" ? "primary" : "primary-1",
        role: posture === "closed" ? "cover" : "inner",
        posture,
      };
      const { feature, client, simctl, getObserveCount } = makeIosFeature(device, [
        {
          ...observation,
          display: expectedDisplay,
          screenSize:
            posture === "closed" ? { width: 466, height: 678 } : { width: 951, height: 669 },
        },
      ]);
      expect(await feature.execute(posture)).toEqual({
        posture,
        display: { ...expectedDisplay, generation: 2 },
        locked: true,
      });
      expect(client.getHingeAngleHistory()).toEqual([angle]);
      expect(getObserveCount()).toBe(1);
      client.supportedCommands = ["set_hinge_angle"];
      expect(await feature.executeHingeAngle(angle)).toMatchObject({ hingeAngle: angle });
      expect(client.getHingeAngleHistory()).toEqual([angle, angle]);
      expect(simctl.getMethodCalls("getDeviceInfo")).toEqual([]);
    }
  });

  test("polls until the iPhone Duo active display matches the requested posture", async () => {
    const laterDisplay = { ...display, key: "primary", role: "cover" };
    const oldObservation = { ...observation, screenSize: { width: 669, height: 951 } };
    const { feature, getObserveCount } = makeIosFeature(duo, [
      oldObservation,
      oldObservation,
      { ...observation, display: laterDisplay, screenSize: { width: 466, height: 678 } },
    ]);
    expect(await feature.execute("closed")).toEqual({
      posture: "closed",
      display: { ...laterDisplay, posture: "closed", generation: 2 },
      locked: true,
    });
    expect(getObserveCount()).toBe(3);
  });

  test("opened accepts either orientation of the inner panel geometry", async () => {
    const cover = {
      ...observation,
      display: { ...display, key: "primary", role: "cover" as const },
      screenSize: { width: 466, height: 678 },
    };
    const swapped = {
      ...observation,
      display: { ...display, key: "primary-1" },
      screenSize: { width: 669, height: 951 },
    };
    const inner = {
      ...observation,
      display: { ...display, key: "primary-1" },
      screenSize: { width: 951, height: 669 },
    };
    const { feature, getObserveCount, timer } = makeIosFeature(duo, [cover, swapped, inner]);
    expect(await feature.execute("opened")).toMatchObject({
      display: { ...inner.display, posture: "opened", generation: 2 },
    });
    expect(getObserveCount()).toBe(2);
    expect(timer.getSleepHistory()).toEqual([250]);
  });

  test("polls when an unknown role still has the old panel size, then succeeds at the expected size", async () => {
    const unknownRoleAtOldSize = {
      ...observation,
      display: { ...display, role: "unknown" },
      screenSize: { width: 669, height: 951 },
    } as ObserveResult;
    const expectedPanelSize = {
      ...unknownRoleAtOldSize,
      screenSize: { width: 466, height: 678 },
    };
    const { feature, getObserveCount, timer } = makeIosFeature(duo, [
      unknownRoleAtOldSize,
      expectedPanelSize,
    ]);
    expect(await feature.execute("closed")).toMatchObject({
      display: { ...unknownRoleAtOldSize.display, generation: 2 },
    });
    expect(getObserveCount()).toBe(2);
    expect(timer.getSleepHistory()).toEqual([250]);
  });

  test("throws when an unknown role keeps the old panel size until timeout", async () => {
    const unknownRoleAtOldSize = {
      ...observation,
      display: { ...display, role: "unknown" },
      screenSize: { width: 669, height: 951 },
    } as ObserveResult;
    const { feature, getObserveCount, timer } = makeIosFeature(duo, [unknownRoleAtOldSize]);
    await expect(feature.execute("closed")).rejects.toThrow(
      "hinge event was accepted, but the active display is still the inner panel after 3000 ms",
    );
    expect(getObserveCount()).toBe(13);
    expect(timer.now()).toBe(3000);
    expect(timer.getSleepHistory()).toEqual(Array(12).fill(250));
  });

  test("returns after one observe without panel inventory", async () => {
    const unknownRoleObservation = {
      ...observation,
      display: { ...display, role: "unknown" },
      screenSize: { width: 669, height: 951 },
    } as ObserveResult;
    const { feature, getObserveCount, timer } = makeIosFeature({ ...duo, displays: undefined }, [
      unknownRoleObservation,
    ]);
    expect(await feature.execute("closed")).toMatchObject({
      display: { ...unknownRoleObservation.display, generation: 2 },
    });
    expect(getObserveCount()).toBe(1);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("notifies before observing and after the new panel settles", async () => {
    const expectedDisplay = { ...display, role: "cover" };
    const { feature, sequence } = makeIosFeature(duo, [
      { ...observation, display: expectedDisplay, screenSize: { width: 466, height: 678 } },
    ]);
    expect(await feature.execute("closed")).toEqual({
      posture: "closed",
      display: { ...expectedDisplay, posture: "closed", generation: 2 },
      locked: true,
    });
    expect(sequence).toEqual([
      `transition:${duo.deviceId}:setPosture changed the iPhone Duo hinge angle`,
      "observe",
      `transition:${duo.deviceId}:setPosture settled on the iPhone Duo display`,
    ]);
  });

  test("returns an indeterminate observation with a warning instead of polling or throwing", async () => {
    const unknownObservation = {
      ...observation,
      display: { ...display, role: "unknown" },
      screenSize: { width: 777, height: 888 },
    };
    const settled = { ...unknownObservation, screenSize: { width: 466, height: 678 } };
    const { feature, getObserveCount, timer } = makeIosFeature(duo, [unknownObservation, settled]);
    const warning = spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      expect(await feature.execute("closed")).toMatchObject({
        display: { ...unknownObservation.display, generation: 2 },
      });
      expect(getObserveCount()).toBe(1);
      expect(timer.getSleepHistory()).toEqual([]);
      expect(warning).toHaveBeenCalledWith(
        "[SetPosture] Could not determine the active iPhone Duo panel after the hinge event",
      );
    } finally {
      warning.mockRestore();
    }
  });

  test("throws when the old panel remains after polling to timeout", async () => {
    const { feature, getObserveCount, timer } = makeIosFeature(duo, [
      { ...observation, screenSize: { width: 669, height: 951 } },
    ]);
    await expect(feature.execute("closed")).rejects.toThrow(
      "hinge event was accepted, but the active display is still the inner panel after 3000 ms",
    );
    expect(getObserveCount()).toBe(13);
    expect(timer.now()).toBe(3000);
    expect(timer.getSleepHistory()).toEqual(Array(12).fill(250));
  });

  test("classifies Duo panels in either orientation and derives point scale when available", () => {
    const panels: DisplayPanel[] = [
      { key: "primary-1", role: "inner", sizePx: { width: 2007, height: 2853 }, scale: 3 },
      { key: "primary", role: "cover", sizePx: { width: 1398, height: 2034 }, scale: 3 },
    ];
    const classifySize = (width: number, height: number) =>
      classifyIosPostureObservation(
        { ...observation, display: { ...display, role: "unknown" }, screenSize: { width, height } },
        panels,
        "cover",
      );
    expect(classifySize(1398, 2034)).toBe("expected");
    expect(classifySize(466, 678)).toBe("expected");
    expect(classifySize(2034, 1398)).toBe("expected");
    expect(
      classifyIosPostureObservation(
        { ...observation, screenSize: { width: 669, height: 951 } },
        panels,
        "inner",
      ),
    ).toBe("expected");
    const panelWithoutScale: DisplayPanel = {
      key: "primary",
      role: "cover",
      sizePx: { width: 1398, height: 2034 },
    };
    expect(
      classifyIosPostureObservation(
        {
          ...observation,
          display: { ...display, role: "unknown" },
          screenSize: { width: 678, height: 466 },
          viewHierarchy: { hierarchy: {}, pixelWidth: 1398, pixelHeight: 2034 },
        },
        [panelWithoutScale, panels[0]!],
        "cover",
      ),
    ).toBe("expected");
  });

  test("rejects unsupported Duo postures and display presets", async () => {
    const { feature, client } = makeIosFeature();
    await expect(feature.execute("tent")).rejects.toThrow("closed, half_opened, opened");
    await expect(feature.execute("opened", "tablet")).rejects.toThrow("displayPreset");
    expect(client.getHingeAngleHistory()).toEqual([]);
  });

  test("runner failure reports its error without a redundant runner update sentence", async () => {
    const { feature, client, getObserveCount } = makeIosFeature();
    client.setHingeAngleResult({
      success: false,
      error: "Unknown command type: set_hinge_angle",
      totalTimeMs: 0,
    });
    await expect(feature.execute("opened")).rejects.toMatchObject({
      message: "Could not set iPhone Duo posture: Unknown command type: set_hinge_angle",
    });
    expect(getObserveCount()).toBe(0);
  });

  test("physical iOS and non-Duo simulators report unsupported", async () => {
    const physical = makeIosFeature({ ...duo, deviceId: "00008120-001C191E0E99003A" });
    expect(await physical.feature.execute("opened")).toMatchObject({ status: "unsupported" });
    const ordinary = makeIosFeature({
      ...duo,
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
    });
    expect(await ordinary.feature.execute("opened")).toMatchObject({ status: "unsupported" });
    expect(physical.client.getHingeAngleHistory()).toEqual([]);
    expect(ordinary.client.getHingeAngleHistory()).toEqual([]);
  });

  test("omits locked when the fresh observation has no lock signal", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell cmd device_state print-states", createExecResult(foldStates, ""));
    adb.setCommandResponse("shell cmd device_state state", createExecResult(closedState, ""));
    const adbFactory: AdbClientFactory = { create: () => adb };
    const unlockedObservation = {
      display,
      displayRevision: 0,
      screenSize: { width: 200, height: 300 },
    } as ObserveResult;
    const observeFactory = () => ({ execute: async () => unlockedObservation }) as ObserveScreen;
    const feature = new SetPosture(makeDevice(), {
      adbFactory,
      observeFactory,
      transitionSink: new DisplayTransitionTracker(() => {}),
    });
    expect(await feature.execute("closed")).toEqual({
      posture: "closed",
      display: { ...display, generation: 0 },
    });
  });
});

for (const platform of ["android", "ios"] as const) {
  describe(`${platform} final posture observation provenance`, () => {
    function harness() {
      const device = makeDevice();
      device.platform = platform;
      if (platform === "ios") {
        device.deviceId = "34C35F33-224C-4E74-B8C0-668FF03E49F5";
        device.deviceType = "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo";
        device.displays!.panels = [
          { key: "panel-cover", role: "cover", sizePx: { width: 200, height: 300 } },
          { key: "panel-inner", role: "inner", sizePx: { width: 400, height: 600 } },
        ];
      }
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse(
        "shell cmd device_state print-states",
        createExecResult(foldStates, ""),
      );
      adb.setCommandResponse("shell cmd device_state state", createExecResult(closedState, ""));
      const observe = new FakeObserveScreen();
      const timer = new FakeTimer();
      const client = new FakeIOSCtrlProxy(timer);
      const events: string[] = [];
      // Full revision can differ from identity generation (iOS geometry corrections).
      let revision = 7;
      let generation = 3;
      const postureTracker = new DisplayTransitionTracker(() => {});
      const sink = {
        rememberIosPosture: (
          device: BootedDevice,
          display: ObserveResult["display"],
          posture: Posture,
        ) => postureTracker.rememberIosPosture(device, display, posture),
        revision: () => revision,
        identityRevision: () => generation,
        notifyAndroidTransition: () => {},
        notifyTransition: (_deviceId: string, reason: string) => {
          revision += 1;
          generation += 1;
          events.push(reason);
        },
      };
      const stamped = (stamp: number | undefined = revision, ownGeneration = 1): ObserveResult => ({
        ...observation,
        display: {
          ...display,
          key: "panel-cover",
          role: "cover",
          posture: "closed",
          generation: ownGeneration,
        },
        displayRevision: stamp,
      });
      const feature = new SetPosture(device, {
        adbFactory: { create: () => adb },
        observeFactory: () => observe,
        iosClientProvider: () => client,
        timer,
        transitionSink: sink,
      });
      return { feature, observe, sink, stamped, events, device, timer };
    }

    if (platform === "ios") {
      test("validates the retry panel when a requested-panel observation is stale", async () => {
        const h = harness();
        h.timer.enableAutoAdvance();
        h.observe.setObserveResult((index) =>
          index === 0
            ? h.stamped(h.sink.revision() - 1)
            : {
                ...h.stamped(),
                display: { ...display, generation: h.sink.identityRevision() },
                screenSize: { width: 400, height: 600 },
              },
        );
        const attempt = h.feature.execute("closed");
        await expect(attempt).rejects.toBeInstanceOf(ActionableError);
        await expect(attempt).rejects.toThrow("active display is still the inner panel");
        expect(h.observe.getExecuteOptions()).toHaveLength(14);
        expect(
          h.observe.getExecuteOptions().every((options) => options?.freshness === "fresh"),
        ).toBe(true);
        expect(h.events).not.toContain("setPosture settled on the iPhone Duo display");
      });
    }

    test("emits stale warnings as a string array for plan promotion without a singular warning", async () => {
      const h = harness();
      h.observe.setObserveResult(() => h.stamped(h.sink.revision() - 1));
      const result = await h.feature.execute("closed");
      if (!("display" in result)) {
        throw new Error("Expected a supported posture result");
      }
      expect(Array.isArray(result.warnings)).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings?.every((entry) => typeof entry === "string")).toBe(true);
      expect("warning" in result).toBe(false);
    });

    test("re-observes a stale final stamp once and adopts the fresh panel", async () => {
      const h = harness();
      h.observe.setObserveResult((index) => {
        h.events.push("observe");
        return index === 0
          ? { ...h.stamped(h.sink.revision() - 1), display: { ...display, role: "cover" } }
          : h.stamped();
      });
      const clear = spyOn(ObservedAndroidDisplayCache, "clear");
      try {
        expect(await h.feature.execute("closed")).toEqual({
          posture: "closed",
          display: { ...h.stamped().display, generation: h.sink.identityRevision() },
          locked: true,
        });
        expect(h.observe.getExecuteOptions()).toEqual([
          { freshness: "fresh", signal: undefined },
          { freshness: "fresh", signal: undefined },
        ]);
        if (platform === "android") {
          expect(clear.mock.calls.filter(([id]) => id === h.device.deviceId)).toHaveLength(2);
        } else {
          expect(h.events).toEqual([
            "setPosture changed the iPhone Duo hinge angle",
            "observe",
            "observe",
            "setPosture settled on the iPhone Duo display",
          ]);
        }
      } finally {
        clear.mockRestore();
      }
    });

    test("keeps the second stale observation's own generation and warns without a third capture", async () => {
      const h = harness();
      h.observe.setObserveResult((index) => {
        h.events.push("observe");
        return h.stamped(h.sink.revision() - 1, index + 1);
      });
      expect(await h.feature.execute("closed")).toEqual({
        posture: "closed",
        display: h.stamped(0, 2).display,
        locked: true,
        warnings: [
          "The posture changed, but the returned observation predates it. Re-observe before acting.",
        ],
      });
      expect(h.observe.getExecuteOptions()).toHaveLength(2);
      if (platform === "ios") {
        expect(h.events.at(-1)).toBe("setPosture settled on the iPhone Duo display");
        expect(h.sink.identityRevision()).toBe(5);
      }
    });

    test("returns a fresh first observation unchanged with only one capture", async () => {
      const h = harness();
      h.observe.setObserveResult(() => h.stamped());
      expect(await h.feature.execute("closed")).toEqual({
        posture: "closed",
        display: { ...h.stamped().display, generation: h.sink.identityRevision() },
        locked: true,
      });
      expect(h.observe.getExecuteOptions()).toHaveLength(1);
    });

    test("treats missing displayRevision as stale instead of certifying unknown provenance", async () => {
      const h = harness();
      h.observe.setObserveResult(() => ({ ...h.stamped(), displayRevision: undefined }));
      expect(await h.feature.execute("closed")).toMatchObject({
        display: { generation: 1 },
        warnings: [
          "The posture changed, but the returned observation predates it. Re-observe before acting.",
        ],
      });
      expect(h.observe.getExecuteOptions()).toHaveLength(2);
    });

    test("cancellation between final captures rejects through the existing actionable error", async () => {
      const h = harness();
      const controller = new AbortController();
      h.observe.setObserveResult(() => h.stamped(0));
      // Abort when SetPosture checks provenance, after the first observation returned.
      const readRevision = spyOn(h.sink, "revision").mockImplementation(() => {
        controller.abort();
        return 7;
      });
      try {
        const attempt = h.feature.execute("closed", undefined, controller.signal);
        await expect(attempt).rejects.toBeInstanceOf(ActionableError);
        await expect(attempt).rejects.toThrow(
          "Posture request cancelled; device may still complete the change",
        );
        expect(h.observe.getExecuteOptions()).toHaveLength(1);
        expect(h.events).not.toContain("setPosture settled on the iPhone Duo display");
      } finally {
        readRevision.mockRestore();
      }
    });
  });
}

// Run the actual fake-backed feature branch results through the declared contract.
const executeForOutputSchema = SetPosture.prototype.execute;
let outputSchemaSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  outputSchemaSpy = spyOn(SetPosture.prototype, "execute").mockImplementation(async function (
    this: SetPosture,
    ...args: Parameters<SetPosture["execute"]>
  ) {
    const result = await executeForOutputSchema.apply(this, args);
    expect(
      setPostureResultSchema.parse({
        ...result,
        message: "status" in result ? result.message : `Set device posture to ${result.posture}`,
      }),
    ).toBeDefined();
    const payload = {
      ...result,
      message: "status" in result ? result.message : `Set device posture to ${result.posture}`,
    };
    const finalized = finalizeToolResponse(createStructuredToolResponse(payload), {
      name: "setPosture",
      outputSchema: setPostureResultSchema,
      artifactWriter: new FakeArtifactWriter(),
    });
    expect(setPostureResultSchema.parse(finalized.structuredContent)).toBeDefined();
    return result;
  });
});
afterEach(() => outputSchemaSpy.mockRestore());

for (const platform of ["ios", "android"] as const) {
  describe(`${platform} posture serialization across per-call instances`, () => {
    function harness() {
      const device = makeDevice(
        platform === "ios" ? "F4C35F33-224C-4E74-B8C0-668FF03E49F5" : "emulator-posture-lock",
        ["closed", "half_opened", "opened"],
      );
      device.platform = platform;
      if (platform === "ios") {
        device.deviceType = "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo";
      }
      device.displays!.panels = [
        { key: "panel-cover", role: "cover", sizePx: { width: 200, height: 300 } },
        { key: "panel-inner", role: "inner", sizePx: { width: 400, height: 600 } },
      ];
      const timer = new FakeTimer();
      const tracker = new DisplayTransitionTracker(() => {});
      const clear = spyOn(ObservedAndroidDisplayCache, "clear");
      const clears = () => clear.mock.calls.filter(([id]) => id === device.deviceId).length;
      const events: string[] = [];
      const client = new FakeIOSCtrlProxy(timer);
      client.supportedCommands = ["set_hinge_angle"];
      const adb = new FakeAdbExecutor();
      let posture: Posture = "opened";
      let held: { stage: string; started: () => void; promise: Promise<void> } | undefined;
      const wait = async (stage: string) => {
        if (held?.stage === stage) {
          const current = held;
          held = undefined;
          current.started();
          await current.promise;
        }
      };
      const hinge = spyOn(client, "requestSetHingeAngle").mockImplementation(async (angle) => {
        posture = angle === 0 ? "closed" : angle === 130 ? "half_opened" : "opened";
        await wait("hinge");
        return { success: true, angle, totalTimeMs: 0 };
      });
      const commands = spyOn(adb, "executeCommand").mockImplementation(async (command) => {
        if (command === "emu fold") {
          posture = "closed";
        }
        if (command === "emu unfold") {
          posture = "opened";
        }
        await wait(command);
        return createExecResult(
          command === "shell cmd device_state print-states"
            ? foldStates
            : command === "emu sensor get hinge-angle0"
              ? hingeAngleReadBack
              : command === "shell cmd device_state state"
                ? posture === "closed"
                  ? closedState
                  : openedState
                : "",
          "",
        );
      });
      const sink: DisplayTransitionSink = {
        revision: (id) => tracker.revision(id),
        identityRevision: (id) => tracker.identityRevision(id),
        rememberIosPosture: (target, ref, requested) =>
          tracker.rememberIosPosture(target, ref, requested),
        notifyAndroidTransition: () => {},
        notifyTransition: (id, reason) => {
          events.push(reason);
          tracker.notifyTransition(id, reason);
        },
      };
      const create = (target = device) =>
        new SetPosture(target, {
          adbFactory: { create: () => adb },
          iosClientProvider: () => client,
          timer,
          transitionSink: sink,
          observeFactory: () =>
            ({
              execute: async () => {
                await wait("observe");
                return {
                  ...observation,
                  display: {
                    ...display,
                    key: posture === "closed" ? "panel-cover" : "panel-inner",
                    role: posture === "closed" ? "cover" : "inner",
                    posture,
                  },
                  screenSize:
                    posture === "closed"
                      ? { width: 200, height: 300 }
                      : { width: 400, height: 600 },
                  displayRevision: tracker.revision(target.deviceId),
                };
              },
            }) as ObserveScreen,
        });
      const block = (stage = platform === "ios" ? "hinge" : "emu unfold") => {
        const gate = Promise.withResolvers<void>();
        const started = Promise.withResolvers<void>();
        held = { stage, started: started.resolve, promise: gate.promise };
        return { started: started.promise, resolve: gate.resolve };
      };
      const sent = () =>
        platform === "ios" ? hinge.mock.calls.length : commands.mock.calls.length;
      const cleanup = () => {
        hinge.mockRestore();
        commands.mockRestore();
        tracker.reset(device.deviceId);
        ObservedAndroidDisplayCache.release(device.deviceId);
        clear.mockRestore();
      };
      return { create, device, timer, tracker, events, block, sent, clears, cleanup };
    }

    const firstPosture = platform === "ios" ? "half_opened" : "opened";
    async function drainMicrotasks() {
      for (let index = 0; index < 40; index += 1) {
        await Promise.resolve();
      }
    }

    test.each([false, true])(
      "angle-first=%s shares the posture readiness lock",
      async (angleFirst) => {
        const h = harness();
        const gate = h.block(
          angleFirst
            ? platform === "ios"
              ? "hinge"
              : "emu sensor set hinge-angle0 90"
            : undefined,
        );
        const first = angleFirst
          ? h.create().executeHingeAngle(90)
          : h.create().execute(firstPosture);
        await gate.started;
        const before = h.sent();
        const second = angleFirst ? h.create().execute("closed") : h.create().executeHingeAngle(90);
        await drainMicrotasks();
        expect(h.sent()).toBe(before);
        gate.resolve();
        h.timer.enableAutoAdvance();
        try {
          await first;
          await expect(second).resolves.toMatchObject(
            angleFirst ? { posture: "closed" } : { hingeAngle: 90 },
          );
          expect(pendingPostureOperationCountForTest()).toBe(0);
        } finally {
          h.cleanup();
        }
      },
    );

    test("a later angle supersedes a hung posture after the bounded wait", async () => {
      const h = harness();
      const gate = h.block();
      const first = h.create().execute(firstPosture);
      const outcome = first.catch((error: unknown) => error);
      await gate.started;
      const second = h.create().executeHingeAngle(90);
      await drainMicrotasks();
      h.timer.advanceTime(18_000);
      await second;
      const events = [...h.events];
      gate.resolve();
      h.timer.enableAutoAdvance();
      try {
        expect(await outcome).toMatchObject({
          message: "Posture request cancelled; superseded by a later setPosture request",
        });
        expect(h.events).toEqual(events);
        expect(pendingPostureOperationCountForTest()).toBe(0);
      } finally {
        h.cleanup();
      }
    });

    if (platform === "android") {
      test("a later posture supersedes a hung angle read-back without returning a warning", async () => {
        const h = harness();
        const gate = h.block("emu sensor get hinge-angle0");
        const first = h.create().executeHingeAngle(90);
        const outcome = first.catch((error: unknown) => error);
        await gate.started;
        const second = h.create().execute("closed");
        await drainMicrotasks();
        h.timer.advanceTime(18_000);
        await second;
        gate.resolve();
        h.timer.enableAutoAdvance();
        try {
          expect(await outcome).toMatchObject({
            message: "Posture request cancelled; superseded by a later setPosture request",
          });
          expect(pendingPostureOperationCountForTest()).toBe(0);
        } finally {
          h.cleanup();
        }
      });
    }

    test("queues all device work until the preceding operation finishes", async () => {
      const h = harness();
      const gate = h.block();
      const a = h.create().execute(firstPosture);
      await gate.started;
      const sentBefore = h.sent();
      const b = h.create().execute("closed");
      await drainMicrotasks();
      const sentWhileQueued = h.sent();
      gate.resolve();
      h.timer.enableAutoAdvance();
      const results = await Promise.allSettled([a, b]);
      try {
        expect(sentWhileQueued).toBe(sentBefore);
        expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      } finally {
        h.cleanup();
      }
    });

    test("cancellation releases immediately and late command completion cannot change the retry result", async () => {
      const h = harness();
      const gate = h.block();
      const controller = new AbortController();
      const a = h.create().execute(firstPosture, undefined, controller.signal);
      await gate.started;
      controller.abort();
      await expect(a).rejects.toThrow("Posture request cancelled;");
      const b = await h.create().execute("closed");
      const events = [...h.events];
      const clears = h.clears();
      const sent = h.sent();
      gate.resolve();
      await drainMicrotasks();
      try {
        expect(b).toMatchObject({
          posture: "closed",
          display: { generation: h.tracker.identityRevision(h.device.deviceId) },
        });
        expect(h.events).toEqual(events);
        expect(h.clears()).toBe(clears);
        expect(h.sent()).toBe(sent);
        if (platform === "ios") {
          expect(
            ObservedAndroidDisplayCache.iosPosture(h.device, h.device.displays!.panels[0]),
          ).toBe("closed");
          expect(observedIosDisplay(h.device, { pixelWidth: 200, pixelHeight: 300 }).posture).toBe(
            "closed",
          );
        }
      } finally {
        h.cleanup();
      }
    });

    test("aborting a queued caller sends nothing and leaves the holder current", async () => {
      const h = harness();
      const gate = h.block();
      const a = h.create().execute(firstPosture);
      await gate.started;
      const before = h.sent();
      const controller = new AbortController();
      const b = h.create().execute("closed", undefined, controller.signal);
      await drainMicrotasks();
      controller.abort();
      await expect(b).rejects.toThrow("Posture request cancelled;");
      const after = h.sent();
      gate.resolve();
      h.timer.enableAutoAdvance();
      const result = await Promise.allSettled([a]);
      try {
        expect(after).toBe(before);
        expect(result[0]?.status).toBe("fulfilled");
      } finally {
        h.cleanup();
      }
    });

    test("a bounded lock wait proceeds and fences the hung operation when it resolves", async () => {
      const h = harness();
      const gate = h.block();
      const a = h.create().execute(firstPosture);
      const outcome = a.then(
        () => undefined,
        (error: unknown) => error,
      );
      await gate.started;
      const before = h.sent();
      const b = h.create().execute("closed");
      await drainMicrotasks();
      const whileWaiting = h.sent();
      h.timer.advanceTime(17_999);
      await drainMicrotasks();
      const beforeBound = h.sent();
      h.timer.advanceTime(1);
      const result = await b;
      const events = [...h.events];
      const clears = h.clears();
      const sent = h.sent();
      gate.resolve();
      h.timer.enableAutoAdvance();
      try {
        expect(await outcome).toBeInstanceOf(ActionableError);
        await expect(a).rejects.toThrow(
          "Posture request cancelled; superseded by a later setPosture request",
        );
        expect(whileWaiting).toBe(before);
        expect(beforeBound).toBe(before);
        expect(h.events).toEqual(events);
        expect(h.clears()).toBe(clears);
        expect(h.sent()).toBe(sent);
        expect(result).toMatchObject({
          display: { generation: h.tracker.identityRevision(h.device.deviceId) },
        });
      } finally {
        h.cleanup();
      }
    });

    test("a superseded holder finishing cannot retire the retry's current token", async () => {
      const h = harness();
      const gate = h.block();
      const a = h.create().execute(firstPosture);
      const outcome = a.then(
        () => undefined,
        (error: unknown) => error,
      );
      await gate.started;
      const retryGate = h.block(platform === "ios" ? "hinge" : "emu fold");
      const b = h.create().execute("closed");
      h.timer.advanceTime(18_000);
      await retryGate.started;
      gate.resolve();
      const error = await outcome;
      const pending = pendingPostureOperationCountForTest();
      retryGate.resolve();
      try {
        await expect(b).resolves.toMatchObject({ posture: "closed" });
        expect(error).toMatchObject({
          message: "Posture request cancelled; superseded by a later setPosture request",
        });
        expect(pending).toBe(1);
        expect(pendingPostureOperationCountForTest()).toBe(0);
      } finally {
        h.cleanup();
      }
    });

    test("cheap unsupported refusals bypass the held lock and send nothing", async () => {
      const h = harness();
      const gate = h.block();
      const a = h.create().execute(firstPosture);
      await gate.started;
      const before = h.sent();
      const unsupported =
        platform === "ios"
          ? h
              .create({
                ...h.device,
                deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
              })
              .execute("closed")
          : h
              .create({ ...h.device, displays: { panels: [], postures: ["opened"] } })
              .execute("closed");
      if (platform === "ios") {
        await expect(unsupported).resolves.toMatchObject({ status: "unsupported" });
      } else {
        await expect(unsupported).rejects.toThrow("Nothing was changed");
      }
      const after = h.sent();
      gate.resolve();
      try {
        await expect(a).resolves.toMatchObject({ posture: firstPosture });
        expect(after).toBe(before);
      } finally {
        h.cleanup();
      }
    });

    test("sequential calls retire their tokens and leave no queued lock timeout", async () => {
      const h = harness();
      try {
        for (const requested of [firstPosture, "closed", firstPosture] as const) {
          await expect(h.create().execute(requested)).resolves.toMatchObject({
            posture: requested,
          });
          expect(pendingPostureOperationCountForTest()).toBe(0);
          expect(h.timer.getPendingTimeouts()).toEqual([]);
        }
      } finally {
        h.cleanup();
      }
    });

    test("timeout takeover fences a late final observation before it can settle or stamp", async () => {
      const h = harness();
      const gate = h.block("observe");
      const a = h.create().execute("closed");
      const outcome = a.then(
        () => undefined,
        (error: unknown) => error,
      );
      await gate.started;
      const b = h.create().execute("closed");
      h.timer.advanceTime(18_000);
      const result = await b;
      const events = [...h.events];
      const clears = h.clears();
      const before = h.sent();
      gate.resolve();
      const error = await outcome;
      try {
        expect(error).toBeInstanceOf(ActionableError);
        expect(error).toMatchObject({
          message: "Posture request cancelled; superseded by a later setPosture request",
        });
        expect(h.events).toEqual(events);
        expect(h.clears()).toBe(clears);
        expect(h.sent()).toBe(before);
        expect(result).toMatchObject({
          display: { generation: h.tracker.identityRevision(h.device.deviceId) },
        });
        expect(pendingPostureOperationCountForTest()).toBe(0);
      } finally {
        h.cleanup();
      }
    });

    test("different device identities can run independently", async () => {
      const h = harness();
      const gate = h.block();
      const a = h.create().execute(firstPosture);
      await gate.started;
      const otherDevice = {
        ...h.device,
        deviceId: platform === "ios" ? "A4C35F33-224C-4E74-B8C0-668FF03E49F5" : "emulator-other",
      };
      const result = await h.create(otherDevice).execute(firstPosture);
      gate.resolve();
      try {
        await a;
        expect(result).toMatchObject({ posture: firstPosture });
      } finally {
        h.tracker.reset(otherDevice.deviceId);
        ObservedAndroidDisplayCache.release(otherDevice.deviceId);
        h.cleanup();
      }
    });

    if (platform === "android") {
      test("a timed-out readback showing the retry's target cannot report success", async () => {
        const h = harness();
        const gate = h.block("shell cmd device_state state");
        const a = h.create().execute("closed");
        const outcome = a.then(
          () => undefined,
          (error: unknown) => error,
        );
        await gate.started;
        const b = h.create().execute("closed");
        h.timer.advanceTime(18_000);
        await b;
        const before = h.sent();
        gate.resolve();
        const error = await outcome;
        try {
          expect(error).toMatchObject({
            message: "Posture request cancelled; superseded by a later setPosture request",
          });
          expect(h.sent()).toBe(before);
        } finally {
          h.cleanup();
        }
      });

      test("a cancelled readback cannot accept the retry's target posture", async () => {
        const h = harness();
        const gate = h.block("shell cmd device_state state");
        const controller = new AbortController();
        const a = h.create().execute("closed", undefined, controller.signal);
        await gate.started;
        controller.abort();
        await expect(a).rejects.toThrow("Posture request cancelled;");
        const b = await h.create().execute("closed");
        const before = h.sent();
        gate.resolve();
        await drainMicrotasks();
        try {
          await expect(a).rejects.toBeInstanceOf(ActionableError);
          expect(h.sent()).toBe(before);
          expect(b).toMatchObject({ posture: "closed" });
        } finally {
          h.cleanup();
        }
      });
    }
  });
}
