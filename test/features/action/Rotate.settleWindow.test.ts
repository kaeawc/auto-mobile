import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { Rotate, type RotationRestoreState } from "../../../src/features/action/Rotate";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { createExecResult as makeExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeTimer } from "../../fakes/FakeTimer";
import { buildObserveResult } from "../../helpers/observeFixture";

const createExecResult = (stdout: string) => makeExecResult(stdout, "");
const portrait = readFileSync(
  join(__dirname, "../observe/windowDumps/dumpsys-window-displays-nomirror-portrait.txt"),
  "utf8",
);
const landscape = readFileSync(
  join(__dirname, "../observe/windowDumps/dumpsys-window-displays-nomirror-landscape.txt"),
  "utf8",
);
const liveCommand = "shell dumpsys window displays";
const restoreCommand = "shell settings put system accelerometer_rotation 1";

describe("Android rotation settle window", () => {
  let adb: FakeAdbExecutor;
  let timer: FakeTimer;
  let idle: FakeAwaitIdle;
  let rotate: Rotate;
  let observe: FakeObserveScreen;
  let window: FakeWindow;
  let beforeRestore: () => string;
  let restoredAt: number | undefined;
  let samples: number[];
  let postRestore: () => string;

  beforeEach(() => {
    adb = new FakeAdbExecutor();
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    idle = new FakeAwaitIdle();
    observe = new FakeObserveScreen();
    observe.enableAutoVaryHierarchy();
    observe.setObserveResult(() =>
      buildObserveResult({
        updatedAt: timer.now(),
        screenSize: { width: 1080, height: 2400 },
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: { hierarchy: { node: {} } },
      }),
    );
    window = new FakeWindow();
    window.configureCachedActiveWindow(null);
    window.configureActiveWindow({
      appId: "com.test.app",
      activityName: "MainActivity",
      layoutSeqSum: 123,
    });
    adb.setCommandResponse(
      "shell settings get system accelerometer_rotation",
      createExecResult("1"),
    );
    adb.setCommandResponseSequence("shell settings get system user_rotation", [
      createExecResult("0"),
      createExecResult("1"),
    ]);
    adb.setCommandResponse("shell wm size", createExecResult("Physical size: 1080x2400"));
    restoredAt = undefined;
    samples = [];
    postRestore = () => landscape;
    beforeRestore = () => portrait;
    const execute = adb.executeCommand.bind(adb);
    spyOn(adb, "executeCommand").mockImplementation(async (command, ...args) => {
      const result = await execute(command, ...args);
      if (command === restoreCommand) {
        restoredAt ??= timer.now();
      }
      if (command !== liveCommand) {
        return result;
      }
      if (restoredAt === undefined) {
        return createExecResult(beforeRestore());
      }
      samples.push(timer.now() - restoredAt);
      return createExecResult(postRestore());
    });
    rotate = new Rotate(
      { name: "Test", platform: "android", deviceId: "test", source: "local" },
      adb,
      timer,
      undefined,
      { awaitIdle: idle, observeScreen: observe, window },
    );
  });

  afterEach(() => {
    AndroidCtrlProxyClient.resetInstances();
  });

  test.each(["unparseable", "throws", "wrong orientation"])(
    "end-of-call failure %s restores only a direct lock",
    async (outcome) => {
      for (const session of [true, false]) {
        let actionCompleted = false;
        adb.clearHistory();
        adb.setCommandResponseSequence("shell settings get system user_rotation", [
          createExecResult("0"),
          createExecResult("1"),
        ]);
        restoredAt = undefined;
        beforeRestore = () => portrait;
        adb.setCommandResponseSequence("shell settings get system accelerometer_rotation", [
          createExecResult("1"),
          createExecResult("0"),
        ]);
        spyOn(idle, "waitForRotation").mockImplementation(async () => {
          beforeRestore = () => landscape;
          actionCompleted = true;
        });
        const originalObserve = observe.execute.bind(observe);
        const observation = spyOn(observe, "execute").mockImplementation(async (...args) => {
          const result = await originalObserve(...args);
          if (actionCompleted) {
            beforeRestore = () => {
              if (outcome === "throws") {
                throw new Error("end-of-call read failed");
              }
              return outcome === "unparseable" ? "" : portrait;
            };
          }
          return result;
        });
        rotate = new Rotate(
          { name: "Test", platform: "android", deviceId: "test", source: "local" },
          adb,
          timer,
          session
            ? {
                sessionRotation: async (mutation) =>
                  mutation({ get: () => undefined, record: () => {}, clear: () => {} }),
              }
            : undefined,
          { awaitIdle: idle, observeScreen: observe, window },
        );
        try {
          const result = await rotate.execute("landscape", { lockOrientation: true });
          expect(result.success).toBe(false);
          expect(result.currentOrientation).toBe(
            outcome === "wrong orientation" ? "portrait" : "unknown",
          );
          expect(adb.getExecutedCommands().includes(restoreCommand)).toBe(!session);
          if (outcome === "wrong orientation" && !session) {
            const rollback = adb
              .getExecutedCommands()
              .indexOf("shell settings put system user_rotation 0");
            expect(rollback).toBeGreaterThan(-1);
            expect(rollback).toBeLessThan(adb.getExecutedCommands().indexOf(restoreCommand));
          }
        } finally {
          observation.mockRestore();
        }
      }
    },
  );

  test.each(["normal", "recovered", "unconfirmed", "reverted"])(
    "session omission restores only after confirmation: %s",
    async (outcome) => {
      let state: RotationRestoreState | undefined;
      rotate = new Rotate(
        { name: "Test", platform: "android", deviceId: "test", source: "local" },
        adb,
        timer,
        {
          sessionRotation: async (mutation) =>
            mutation({
              get: () => state,
              record: (original) => {
                state = original;
              },
              clear: () => {
                state = undefined;
              },
            }),
        },
        { awaitIdle: idle, observeScreen: observe, window },
      );
      adb.setCommandResponse(
        "shell settings get secure device_state_rotation_lock",
        createExecResult("0:2"),
      );
      spyOn(idle, "waitForRotation").mockImplementation(async () => {
        beforeRestore = () => (outcome === "unconfirmed" ? "" : landscape);
        if (outcome === "recovered" || outcome === "unconfirmed") {
          throw new Error("rotation wait failed");
        }
      });
      if (outcome === "reverted") {
        postRestore = () => portrait;
      }
      const result = await rotate.execute("landscape");
      expect(result.success).toBe(outcome === "normal" || outcome === "recovered");
      const commands = adb.getExecutedCommands();
      expect(commands.includes(restoreCommand)).toBe(outcome !== "unconfirmed");
      expect(commands.includes("shell settings put system user_rotation 0")).toBe(
        outcome === "reverted",
      );
      expect(state?.accelerometerRotation).toBe(1);
      if (outcome !== "unconfirmed") {
        const mapRestore = commands.indexOf(
          "shell settings put secure device_state_rotation_lock 0:2",
        );
        expect(mapRestore).toBeGreaterThan(-1);
        expect(mapRestore).toBeLessThan(commands.indexOf(restoreCommand));
      }
    },
  );

  test("bounds post-restore reads when sleep does not advance the clock", async () => {
    spyOn(timer, "sleep").mockResolvedValue(undefined);
    const cap = Math.ceil(3000 / 150) + 2;
    postRestore = () => {
      // Escape a regressed infinite loop even though live-read exceptions are swallowed.
      if (samples.length > cap * 2) {
        timer.advanceTime(3000);
      }
      return landscape;
    };
    const result = await rotate.execute("landscape");
    expect(result.success).toBe(false);
    expect(samples.length).toBeLessThanOrEqual(cap);
    expect(samples).toHaveLength(cap);
  });

  test("rejects a sensor reversion 600 ms after restore and rolls back", async () => {
    postRestore = () => (timer.now() - (restoredAt ?? 0) >= 600 ? portrait : landscape);
    const result = await rotate.execute("landscape");
    expect(result.success).toBe(false);
    expect(result.currentOrientation).toBe("portrait");
    expect(result.error).toContain("reverted");
    expect(adb.getExecutedCommands()).toContain("shell settings put system user_rotation 0");
  });

  test("requires 1000 ms of requested orientation in bounded 150 ms steps", async () => {
    const result = await rotate.execute("landscape");
    expect(result.success).toBe(true);
    expect(result.currentOrientation).toBe("landscape");
    expect(samples).toEqual([0, 150, 300, 450, 600, 750, 900, 1050, 1050]);
    expect(timer.getSleepHistory()).toEqual(Array(7).fill(150));
  });

  test("unreadable post-restore samples fail without rollback within 3000 ms", async () => {
    postRestore = () => "";
    const result = await rotate.execute("landscape");
    expect(result.success).toBe(false);
    expect(result.currentOrientation).toBe("unknown");
    expect(result.error).toContain("could not be confirmed");
    expect(result.message).toBe(result.error);
    expect(result.warning).toBeDefined();
    expect(adb.getExecutedCommands()).not.toContain("shell settings put system user_rotation 0");
    expect(timer.now() - (restoredAt ?? 0)).toBeLessThanOrEqual(3000);
    expect(samples).toHaveLength(20);
  });

  test("already-applied orientation with an unreadable automatic-rotation restore fails", async () => {
    beforeRestore = () => landscape;
    postRestore = () => "";
    adb.setCommandResponse(
      "shell settings get system accelerometer_rotation",
      createExecResult("null"),
    );
    const result = await rotate.execute("landscape", { lockOrientation: false });
    expect(result.success).toBe(false);
    expect(result.currentOrientation).toBe("unknown");
    expect(result.error).toContain("could not be confirmed");
    expect(result.message).toBe(result.error);
    expect(result.warning).toBeDefined();
    expect(adb.getExecutedCommands()).not.toContain("shell settings put system user_rotation 0");
  });

  test("a requested streak shorter than the hold at window exhaustion stays unconfirmed", async () => {
    postRestore = () => (timer.now() - (restoredAt ?? 0) >= 2400 ? landscape : portrait);
    const result = await rotate.execute("landscape");
    expect(result.success).toBe(false);
    expect(result.currentOrientation).toBe("unknown");
    expect(result.error).toContain("could not be confirmed");
    expect(adb.getExecutedCommands()).not.toContain("shell settings put system user_rotation 0");
    expect(samples).toHaveLength(20);
  });

  test("slow reads stop starting new reads at the 3000 ms window", async () => {
    postRestore = () => {
      timer.advanceTime(1200);
      return portrait;
    };
    const result = await rotate.execute("landscape");
    expect(result.success).toBe(false);
    expect(result.currentOrientation).toBe("portrait");
    expect(samples).toEqual([0, 1350, 2700]);
  });

  test.each([false, true])(
    "failed direct lock restores auto-rotate; restore failure=%s",
    async (restoreFails) => {
      spyOn(idle, "waitForRotation").mockRejectedValue(new Error("rotation wait failed"));
      if (restoreFails) {
        adb.setCommandError(restoreCommand, new Error("restore failed"));
      }
      const result = await rotate.execute("landscape", { lockOrientation: true });
      expect(result.success).toBe(false);
      expect(result.error).toContain("rotation wait failed");
      expect(adb.getExecutedCommands()).toContain(restoreCommand);
      expect(adb.getExecutedCommands()).toContain("shell settings put system user_rotation 0");
      if (restoreFails) {
        expect(result.warning).toContain("restore failed");
      }
    },
  );
  test("failed lock of an already-applied orientation restores automatic rotation", async () => {
    beforeRestore = () => landscape;
    spyOn(idle, "waitForRotation").mockRejectedValue(new Error("rotation wait failed"));
    const result = await rotate.execute("landscape", { lockOrientation: true });
    expect(result.success).toBe(false);
    expect(adb.getExecutedCommands()).toContain(restoreCommand);
  });

  test("successful direct lock never restores auto-rotate", async () => {
    spyOn(idle, "waitForRotation").mockImplementation(async () => {
      beforeRestore = () => landscape;
      adb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("0"),
      );
    });
    const result = await rotate.execute("landscape", { lockOrientation: true });
    expect(result.success).toBe(true);
    expect(adb.getExecutedCommands()).not.toContain(restoreCommand);
  });

  test("requested orientation confirmed after wait failure retains the successful lock", async () => {
    spyOn(idle, "waitForRotation").mockImplementation(async () => {
      beforeRestore = () => landscape;
      adb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("0"),
      );
      throw new Error("rotation wait failed");
    });
    const result = await rotate.execute("landscape", { lockOrientation: true });
    expect(result.success).toBe(true);
    expect(adb.getExecutedCommands()).not.toContain(restoreCommand);
    expect(timer.getSleepHistory()).toEqual([150]);
  });

  test("failed session lock leaves auto-rotate restoration to release", async () => {
    rotate = new Rotate(
      { name: "Test", platform: "android", deviceId: "test", source: "local" },
      adb,
      timer,
      {
        sessionRotation: async (mutation) =>
          mutation({ get: () => undefined, record: () => {}, clear: () => {} }),
      },
      { awaitIdle: idle, observeScreen: observe, window },
    );
    spyOn(idle, "waitForRotation").mockRejectedValue(new Error("rotation wait failed"));
    const result = await rotate.execute("landscape", { lockOrientation: true });
    expect(result.success).toBe(false);
    expect(adb.getExecutedCommands()).not.toContain(restoreCommand);
  });

  test("failed direct lock restores the captured device-state map before auto-rotate", async () => {
    adb.setCommandResponse(
      "shell settings get secure device_state_rotation_lock",
      createExecResult("0:2"),
    );
    spyOn(idle, "waitForRotation").mockRejectedValue(new Error("rotation wait failed"));
    const result = await rotate.execute("landscape", { lockOrientation: true });
    expect(result.success).toBe(false);
    const commands = adb.getExecutedCommands();
    const mapRestore = commands.indexOf("shell settings put secure device_state_rotation_lock 0:2");
    expect(mapRestore).toBeGreaterThan(-1);
    expect(mapRestore).toBeLessThan(commands.indexOf(restoreCommand));
  });

  test("reaching the requested orientation after an error still fails if its lock is unconfirmed", async () => {
    spyOn(idle, "waitForRotation").mockImplementation(async () => {
      beforeRestore = () => landscape;
      throw new Error("rotation wait failed");
    });
    const result = await rotate.execute("landscape", { lockOrientation: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain("persistent orientation lock could not be confirmed");
    expect(adb.getExecutedCommands()).toContain(restoreCommand);
  });

  test("unconfirmed failed direct lock restores auto-rotate without rolling back user_rotation", async () => {
    spyOn(idle, "waitForRotation").mockImplementation(async () => {
      beforeRestore = () => "";
      throw new Error("rotation wait failed");
    });
    const result = await rotate.execute("landscape", { lockOrientation: true });
    expect(result.success).toBe(false);
    expect(result.currentOrientation).toBe("unknown");
    expect(adb.getExecutedCommands()).toContain(restoreCommand);
    expect(adb.getExecutedCommands()).not.toContain("shell settings put system user_rotation 0");
  });
});
