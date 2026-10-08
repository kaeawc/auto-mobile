import { withEpilogueWarning } from "../../../src/utils/bestEffortEpilogue";
import { finalizeToolResponse } from "../../../src/server/finalizeToolResponse";
import { createStructuredToolResponse } from "../../../src/utils/toolUtils";
import { FakeArtifactWriter } from "../../fakes/FakeArtifactWriter";
import { formatRotateMessage } from "../../../src/server/interactionTools";
import { rotateResultSchema } from "../../../src/server/toolOutputSchemas";
import { expect, describe, test, beforeEach, afterEach, spyOn } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import { Rotate, type RotationRestoreState } from "../../../src/features/action/Rotate";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { ExecResult, BootedDevice, ObserveResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import { WINDOW_MANAGER_ROTATION_TIMEOUT_MS } from "../../../src/utils/android-cmdline-tools/readWindowManagerRotation";
import { readFileSync } from "fs";
import { join } from "path";

const mirrorLandscape = readFileSync(
  join(__dirname, "..", "observe", "windowDumps", "dumpsys-window-displays-mirror-landscape.txt"),
  "utf8",
);
const mirrorPortrait = readFileSync(
  join(__dirname, "..", "observe", "windowDumps", "dumpsys-window-displays-mirror-portrait.txt"),
  "utf8",
);
const twoDisplays = readFileSync(
  join(__dirname, "..", "observe", "android", "fixtures", "cmd-display-two-displays.txt"),
  "utf8",
);

describe("Rotate", () => {
  let rotate: Rotate;
  let fakeAdb: FakeAdbExecutor;
  let fakeAwaitIdle: FakeAwaitIdle;
  let fakeObserveScreen: FakeObserveScreen;
  let fakeWindow: FakeWindow;
  let fakeTimer: FakeTimer;
  let mockDevice: BootedDevice;

  afterEach(() => {
    AndroidCtrlProxyClient.resetInstances();
  });

  // Helper function to create mock ExecResult
  const createExecResult = (stdout: string = ""): ExecResult => ({
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (searchString: string) => stdout.includes(searchString),
  });

  // Helper function to create mock ObserveResult
  const createObserveResult = (): ObserveResult => ({
    timestamp: Date.now(),
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: { node: {} },
  });

  beforeEach(() => {
    // Create mock BootedDevice
    mockDevice = {
      name: "Test Device",
      platform: "android",
      deviceId: "test-device",
      source: "local",
    };

    // Create fakes for testing
    fakeAdb = new FakeAdbExecutor();
    fakeAwaitIdle = new FakeAwaitIdle();
    fakeObserveScreen = new FakeObserveScreen();
    fakeObserveScreen.enableAutoVaryHierarchy();
    fakeWindow = new FakeWindow();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    // Configure default responses
    fakeWindow.configureCachedActiveWindow(null);
    fakeWindow.configureActiveWindow({
      appId: "com.test.app",
      activityName: "MainActivity",
      layoutSeqSum: 123,
    });

    // Set up default observe screen responses with valid viewHierarchy
    // Use a factory to create different objects on each call (avoids BaseVisualChange
    // comparing same object references and overriding success to false)
    fakeObserveScreen.setObserveResult(() => createObserveResult());

    // Set default responses for common ADB commands
    fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
    fakeAdb.setCommandResponse(
      "shell settings get system accelerometer_rotation",
      createExecResult("1"),
    );

    // Instantiate Rotate with fake ADB
    rotate = new Rotate(mockDevice, fakeAdb, fakeTimer);

    // Inject all fakes to avoid real device operations
    (rotate as any).awaitIdle = fakeAwaitIdle;
    (rotate as any).observeScreen = fakeObserveScreen;
    (rotate as any).window = fakeWindow;
  });

  test("rotate dispatches with a not-fresh pre-read", async () => {
    fakeObserveScreen.setObserveResult(() => ({
      ...createObserveResult(),
      freshness: {
        isFresh: false,
        category: "window_identity",
      },
    }));
    fakeAdb.setCommandResponse("shell dumpsys window displays", createExecResult(mirrorLandscape));
    const result = await rotate.execute("landscape");
    expect(result.success).toBe(true);
  });

  test("non-default display uses per-display rotation without global settings writes", async () => {
    fakeAdb.setCommandResponse("shell cmd display get-displays", createExecResult(twoDisplays));
    fakeAdb.setCommandResponse("shell wm size -d 2", createExecResult("Physical size: 1080x1920"));
    const result = await rotate.execute("landscape", undefined, true, undefined, 2);
    expect(result.success).toBe(true);
    // The display's rotation read-back is covered in Rotate.displayReadBack.test.ts.
    expect(
      fakeAdb.getExecutedCommands().filter((command) => !command.includes("dumpsys window")),
    ).toEqual([
      "shell cmd display get-displays",
      "shell wm size -d 2",
      "shell cmd window user-rotation -d 2 lock 1",
    ]);
  });

  test("non-default display reads its own natural orientation (#10362)", async () => {
    // Display 0 is naturally portrait; display 2 (e.g. a 1280x720 overlay) is naturally
    // landscape, so landscape on display 2 is its natural rotation 0.
    fakeAdb.setCommandResponse("shell cmd display get-displays", createExecResult(twoDisplays));
    // The fake matches by substring in insertion order, so the per-display response goes first.
    fakeAdb.setCommandResponse("shell wm size -d 2", createExecResult("Physical size: 1280x720"));
    fakeAdb.setCommandResponse("shell wm size", createExecResult("Physical size: 1080x1920"));
    const landscape = await rotate.execute("landscape", undefined, true, undefined, 2);
    expect(landscape.value).toBe(0);
    const portrait = await rotate.execute("portrait", undefined, true, undefined, 2);
    expect(portrait.value).toBe(1);
    expect(
      fakeAdb.getExecutedCommands().filter((command) => !command.includes("dumpsys window")),
    ).toEqual([
      "shell cmd display get-displays",
      "shell wm size -d 2",
      "shell cmd window user-rotation -d 2 lock 0",
      "shell cmd display get-displays",
      "shell wm size -d 2",
      "shell cmd window user-rotation -d 2 lock 1",
    ]);
  });

  test("missing non-default display reports available ids without rotating", async () => {
    fakeAdb.setCommandResponse("shell cmd display get-displays", createExecResult(twoDisplays));
    const error = await rotate
      .execute("landscape", undefined, true, undefined, 7)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ActionableError);
    expect((error as Error).message).toBe("display 7 not found; available: 0, 2");
    expect(fakeAdb.getExecutedCommands()).toEqual(["shell cmd display get-displays"]);
  });

  test("omitted display keeps the global rotation settings path", async () => {
    fakeAdb.clearHistory();
    fakeAdb.setCommandResponse("shell wm size", createExecResult("Physical size: 1080x1920"));
    fakeAdb.setCommandResponse("shell dumpsys window displays", createExecResult(mirrorPortrait));
    await rotate.execute("landscape", undefined, true);
    expect(
      fakeAdb.getExecutedCommands().filter((command) => command.includes("settings put system")),
    ).toEqual([
      "shell settings put system accelerometer_rotation 0",
      "shell settings put system user_rotation 1",
    ]);
  });

  test("iOS rejects non-default display", async () => {
    mockDevice.platform = "ios";
    await expect(rotate.execute("portrait", undefined, undefined, undefined, 1)).rejects.toThrow(
      "supported only on Android",
    );
  });

  test("per-display user-rotation failure is surfaced as an ActionableError", async () => {
    fakeAdb.setCommandError("cmd window user-rotation -d 2", new Error("window manager failed"));
    await expect(rotate.execute("landscape", undefined, true, undefined, 2)).rejects.toBeInstanceOf(
      ActionableError,
    );
  });

  describe("live rotation request budget", () => {
    for (const [remainingMs, expectedTimeoutMs] of [
      [3000, 3000],
      [200, 1000],
      [-200, 1000],
    ]) {
      test(`uses timeout ${expectedTimeoutMs} with ${remainingMs} ms remaining`, async () => {
        fakeTimer.advanceTime(7000);
        const budgetedRotate = new Rotate(mockDevice, fakeAdb, fakeTimer, {
          deadlineMs: fakeTimer.now() + remainingMs,
        });
        const signal = new AbortController().signal;
        fakeAdb.setCommandResponse(
          "shell dumpsys window displays",
          createExecResult(mirrorPortrait),
        );

        expect(await budgetedRotate["readLiveRotation"](signal)).toBe(0);

        const reads = fakeAdb.getCommandCalls();
        expect(reads).toHaveLength(1);
        expect(reads[0].command).toBe("shell dumpsys window displays");
        expect(reads[0].timeoutMs).toBe(expectedTimeoutMs);
        expect(reads[0].signal).toBe(signal);
      });
    }

    test("recomputes remaining budget on every settle-wait attempt", async () => {
      fakeTimer.advanceTime(7000);
      const budgetedRotate = new Rotate(mockDevice, fakeAdb, fakeTimer, {
        deadlineMs: fakeTimer.now() + 3000,
      });
      const signal = new AbortController().signal;
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult(mirrorLandscape),
        createExecResult(mirrorPortrait),
        createExecResult(mirrorPortrait),
      ]);

      expect(await budgetedRotate["readLiveRotationWithSettleWait"]("portrait", signal)).toBe(0);

      // A bare settle-wait outside an execute() call re-reads the natural axes per sample.
      const reads = fakeAdb
        .getCommandCalls()
        .filter((read) => read.command === "shell dumpsys window displays");
      expect(reads).toHaveLength(3);
      expect(reads.map((read) => read.timeoutMs)).toEqual([3000, 2850, 2700]);
      expect(reads.every((read) => read.signal === signal)).toBe(true);
    });

    test("retains the reader default timeout without a deadline", async () => {
      fakeAdb.setCommandResponse("shell dumpsys window displays", createExecResult(mirrorPortrait));
      expect(await rotate["readLiveRotation"]()).toBe(0);
      expect(fakeAdb.getCommandCalls()[0].timeoutMs).toBe(WINDOW_MANAGER_ROTATION_TIMEOUT_MS);
    });
  });

  test("rotates to landscape successfully while the mirror is present", async () => {
    fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
      createExecResult(mirrorPortrait),
      createExecResult(mirrorLandscape),
    ]);
    const result = await rotate.execute("landscape");
    expect(result.success).toBe(true);
    expect(result.rotationPerformed).toBe(true);
    expect(result.currentOrientation).toBe("landscape");
    expect(result.previousOrientation).toBe("portrait");
  });

  test("rotates from mirrored landscape to portrait instead of reporting a no-op", async () => {
    fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
      createExecResult(mirrorLandscape),
      createExecResult(mirrorPortrait),
    ]);
    const result = await rotate.execute("portrait");
    expect(result.success).toBe(true);
    expect(result.rotationPerformed).toBe(true);
    expect(result.currentOrientation).toBe("portrait");
    expect(result.previousOrientation).toBe("landscape");
    expect(fakeAdb.getExecutedCommands()).toContain("shell settings put system user_rotation 0");
  });

  test("output schema accepts optional base metadata on a real no-op result", async () => {
    const result = await rotate.execute("portrait");
    expect(result.rotationPerformed).toBe(false);
    const { observation, ...withoutObservation } = result;
    expect(observation).toBeDefined();
    const payload = {
      ...withEpilogueWarning(withoutObservation, "Re-observe before acting."),
      message: formatRotateMessage(result),
    };
    expect(rotateResultSchema.parse(payload)).toEqual(payload);
    expect(
      rotateResultSchema.safeParse({ ...payload, orientationLockState: "enabled" }).success,
    ).toBe(false);
    expect(rotateResultSchema.safeParse({ ...payload, warnings: [1] }).success).toBe(false);
  });

  test("stale post-rotation observation still conforms after finalization", async () => {
    fakeAdb.setDeviceTimestampMs(1000);
    fakeObserveScreen.setObserveResult(() => ({
      ...createObserveResult(),
      freshness: { isFresh: false },
    }));
    const result = await rotate.execute("landscape");
    expect(result.observation?.freshness?.warning).toBe(
      "Observation may be stale after interaction",
    );
  });

  describe("end-of-call Android orientation", () => {
    const liveCommand = "shell dumpsys window displays";

    function scriptLandscapeRotation(afterObservation: () => void = () => {}) {
      fakeAdb.setCommandResponseSequence(liveCommand, [
        createExecResult("mRotation=0"),
        createExecResult("mRotation=1"),
        createExecResult("mRotation=1"),
      ]);
      fakeObserveScreen.setObserveResult((index) => {
        if (index > 0) {
          afterObservation();
        }
        // Hierarchy rotation can be stale even in the post-action observation.
        return { ...createObserveResult(), rotation: 1 };
      });
    }

    test("reports a direct auto-rotate reversion during post-action observation", async () => {
      let commandsAtObservation: string[] = [];
      let observationTime = 0;
      scriptLandscapeRotation(() => {
        commandsAtObservation = fakeAdb.getExecutedCommands();
        fakeTimer.advanceTime(2500);
        observationTime = fakeTimer.now();
        fakeAdb.setCommandResponseSequence(liveCommand, [createExecResult("mRotation=0")]);
      });

      const result = await rotate.execute("landscape");

      expect(result.success).toBe(false);
      expect(result.currentOrientation).toBe("portrait");
      expect(result.previousOrientation).toBe("portrait");
      expect(result.rotationPerformed).toBe(true);
      expect(result.orientationLockHandled).toBe(true);
      expect(result.orientationLockState).toBe("unlocked");
      expect(result.message).toBe(result.error);
      expect(result.message).toContain("rotated to landscape and then returned to portrait");
      expect(result.message).toContain("automatic rotation is on");
      expect(result.message).toContain("at the time the call returned");
      expect(result.message).toContain("lockOrientation: true");
      expect(result.message).toContain("device session");
      expect(result.observation?.rotation).toBe(1);
      expect(commandsAtObservation.filter((command) => command === liveCommand)).toHaveLength(3);
      expect(commandsAtObservation).toContain("shell settings put system accelerometer_rotation 1");
      expect(fakeAdb.getExecutedCommands().slice(commandsAtObservation.length)).toEqual([
        liveCommand,
      ]);
      expect(fakeTimer.getSleepHistory()).toEqual([150]);
      expect(fakeTimer.now()).toBe(observationTime);
      expect(
        fakeAdb
          .getExecutedCommands()
          .filter((command) => command.includes("put system user_rotation")),
      ).toEqual(["shell settings put system user_rotation 1"]);
    });

    test("preserves direct success when auto-rotate never reverts", async () => {
      scriptLandscapeRotation();
      const result = await rotate.execute("landscape");
      expect(result.success).toBe(true);
      expect(result.currentOrientation).toBe("landscape");
      expect(result.warning).toBeUndefined();
      expect(result.error).toBeUndefined();
      expect(result.message).toContain("Successfully rotated from portrait to landscape");
      expect(
        fakeAdb.getExecutedCommands().filter((command) => command === liveCommand),
      ).toHaveLength(4);
      expect(fakeTimer.getSleepHistory()).toEqual([150]);
    });

    test.each(["session", "direct lock"])(
      "confirms %s at return without restoring auto-rotate",
      async (mode) => {
        scriptLandscapeRotation();
        fakeAdb.setCommandResponseSequence("shell settings get system accelerometer_rotation", [
          createExecResult("1"),
          createExecResult("0"),
        ]);
        if (mode === "session") {
          let original: RotationRestoreState | undefined;
          rotate = new Rotate(mockDevice, fakeAdb, fakeTimer, {
            sessionRotation: async (mutation) =>
              mutation({
                get: () => original,
                record: (state) => {
                  original ??= state;
                },
                clear: () => {
                  original = undefined;
                },
              }),
          });
          Object.assign(rotate, {
            awaitIdle: fakeAwaitIdle,
            observeScreen: fakeObserveScreen,
            window: fakeWindow,
          });
        }
        const result = await rotate.execute(
          "landscape",
          undefined,
          mode === "session" ? undefined : true,
        );
        expect(result.success).toBe(true);
        expect(result.currentOrientation).toBe("landscape");
        expect(result.orientationLockState).toBe("locked");
        expect(
          fakeAdb.wasCommandExecuted("shell settings put system accelerometer_rotation 1"),
        ).toBe(false);
        expect(
          fakeAdb.getExecutedCommands().filter((command) => command === liveCommand),
        ).toHaveLength(2);
        expect(fakeTimer.getSleepHistory()).toEqual([]);
      },
    );

    test("does not blame auto-rotate for a reversion under a confirmed lock", async () => {
      scriptLandscapeRotation(() => {
        fakeAdb.setCommandResponseSequence(liveCommand, [createExecResult("mRotation=0")]);
      });
      fakeAdb.setCommandResponseSequence("shell settings get system accelerometer_rotation", [
        createExecResult("1"),
        createExecResult("0"),
      ]);
      const result = await rotate.execute("landscape", undefined, true);
      expect(result.success).toBe(false);
      expect(result.currentOrientation).toBe("portrait");
      expect(result.orientationLockState).toBe("locked");
      expect(result.error).toContain(
        "left the requested landscape orientation after the call confirmed it",
      );
      expect(result.error).toContain("at the time the call returned");
      expect(result.error).not.toContain("automatic rotation is on");
    });

    test.each(["unparseable", "throws", "times out"])(
      "reports unknown when the end-of-call read %s",
      async (outcome) => {
        let observed = false;
        let observationTime = 0;
        scriptLandscapeRotation(() => {
          observed = true;
          observationTime = fakeTimer.now();
          fakeAdb.setCommandResponseSequence(liveCommand, [createExecResult("")]);
        });
        const stalled = Promise.withResolvers<ExecResult>();
        const execute = fakeAdb.executeCommand.bind(fakeAdb);
        const read = spyOn(fakeAdb, "executeCommand").mockImplementation(
          async (command, ...args) => {
            const response = await execute(command, ...args);
            if (observed && command === liveCommand) {
              if (outcome === "throws") {
                throw new Error("end-of-call dumpsys failed");
              }
              if (outcome === "times out") {
                return stalled.promise;
              }
            }
            return response;
          },
        );
        try {
          const result = await rotate.execute("landscape");
          expect(result.success).toBe(true); // Existing unconfirmed-orientation contract.
          expect(result.currentOrientation).toBe("unknown");
          expect(result.warning).toContain("end-of-call orientation could not be confirmed");
          expect(result.message).toContain("end-of-call orientation could not be confirmed");
          expect(result.observation).toBeDefined();
          expect(fakeTimer.getSleepHistory()).toEqual([150]);
          expect(
            fakeAdb.getExecutedCommands().filter((command) => command === liveCommand),
          ).toHaveLength(4);
          if (outcome === "times out") {
            expect(fakeTimer.now() - observationTime).toBe(1000);
          }
        } finally {
          stalled.resolve(createExecResult(""));
          read.mockRestore();
        }
      },
    );

    test("propagates request cancellation during the end-of-call read", async () => {
      const controller = new AbortController();
      scriptLandscapeRotation(() => fakeAdb.abortAfterCommand(liveCommand, controller));
      await expect(
        rotate.execute("landscape", undefined, undefined, controller.signal),
      ).rejects.toThrow("Rotation cancelled");
      expect(
        fakeAdb.getExecutedCommands().filter((command) => command === liveCommand),
      ).toHaveLength(4);
    });

    test.each(["mRotation=0", ""])(
      "leaves in-call result %s unchanged without an extra read",
      async (live) => {
        let commandsAtObservation: string[] = [];
        scriptLandscapeRotation(() => {
          commandsAtObservation = fakeAdb.getExecutedCommands();
          fakeAdb.setCommandResponseSequence(liveCommand, [createExecResult("mRotation=1")]);
        });
        fakeAdb.setCommandResponseSequence(liveCommand, [
          createExecResult("mRotation=0"),
          createExecResult(live),
        ]);
        const result = await rotate.execute("landscape");
        expect(result.success).toBe(live === "");
        expect(result.currentOrientation).toBe(live === "" ? "unknown" : "portrait");
        expect(fakeAdb.getExecutedCommands()).toEqual(commandsAtObservation);
        expect(result.observation).toBeDefined();
      },
    );
  });

  describe("rotation session ownership and rollback", () => {
    function useSession() {
      let original:
        | { accelerometerRotation: 0 | 1 | null; userRotation: number | null }
        | undefined;
      rotate = new Rotate(mockDevice, fakeAdb, fakeTimer, {
        sessionRotation: async (mutation) =>
          mutation({
            get: () => original,
            record: (state) => {
              original ??= state;
            },
            clear: () => {
              original = undefined;
            },
          }),
      });
      Object.assign(rotate, {
        awaitIdle: fakeAwaitIdle,
        observeScreen: fakeObserveScreen,
        window: fakeWindow,
      });
      return () => original;
    }

    function settingsSequence(auto: string[]) {
      fakeAdb.setCommandResponseSequence(
        "shell settings get system accelerometer_rotation",
        auto.map(createExecResult),
      );
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=0"),
        createExecResult("mRotation=1"),
      ]);
    }

    test("session default holds auto-rotate off and records originals before writes", async () => {
      const original = useSession();
      settingsSequence(["1", "0"]);
      const result = await rotate.execute("landscape");
      expect(result.success).toBe(true);
      expect(result.orientationLockState).toBe("locked");
      expect(fakeAdb.wasCommandExecuted("shell settings put system accelerometer_rotation 1")).toBe(
        false,
      );
      expect(original()).toEqual({ accelerometerRotation: 1, userRotation: 0 });
      const calls = fakeAdb.getExecutedCommands();
      expect(calls.indexOf("shell settings get system user_rotation")).toBeLessThan(
        calls.indexOf("shell settings put system accelerometer_rotation 0"),
      );
    });

    test("session true records the same restore slot and stays locked", async () => {
      const original = useSession();
      settingsSequence(["1", "0"]);
      const result = await rotate.execute("landscape", undefined, true);
      expect(result.orientationLockState).toBe("locked");
      expect(original()).toEqual({ accelerometerRotation: 1, userRotation: 0 });
    });

    test("session already-matching orientation locks and records before its first write", async () => {
      const original = useSession();
      fakeAdb.setCommandResponse("shell dumpsys window displays", createExecResult("mRotation=1"));
      fakeAdb.setCommandResponseSequence("shell settings get system accelerometer_rotation", [
        createExecResult("1"),
        createExecResult("0"),
      ]);
      const result = await rotate.execute("landscape");
      expect(result.success).toBe(true);
      expect(result.orientationLockState).toBe("locked");
      expect(original()).toEqual({ accelerometerRotation: 1, userRotation: 0 });
    });

    test("session unknown initial auto-rotate preserves guard and records null", async () => {
      const original = useSession();
      settingsSequence(["null"]);
      const result = await rotate.execute("landscape");
      expect(result.orientationLockState).toBe("unknown");
      expect(original()).toEqual({ accelerometerRotation: null, userRotation: 0 });
      expect(
        fakeAdb
          .getExecutedCommands()
          .filter((command) =>
            command.startsWith("shell settings put system accelerometer_rotation"),
          ),
      ).toEqual([]);
    });

    test.each([
      { key: "accelerometer_rotation", live: 0 },
      { key: "accelerometer_rotation", live: 1 },
      { key: "user_rotation", live: 0 },
      { key: "user_rotation", live: 1 },
    ])(
      "session unreadable $key refuses an explicit lock before any write or slot (live $live)",
      async ({ key, live }) => {
        const original = useSession();
        fakeAdb.setCommandResponse(
          "shell dumpsys window displays",
          createExecResult(`mRotation=${live}`),
        );
        fakeAdb.setCommandResponse(`shell settings get system ${key}`, createExecResult("null"));
        await expect(rotate.execute("landscape", undefined, true)).rejects.toBeInstanceOf(
          ActionableError,
        );
        expect(original()).toBeUndefined();
        expect(
          fakeAdb.getExecutedCommands().filter((c) => c.startsWith("shell settings put system")),
        ).toEqual([]);
        expect(
          fakeAdb.getExecutedCommands().filter((c) => c === `shell settings get system ${key}`),
        ).toHaveLength(2);
      },
    );

    test.each(["accelerometer_rotation", "user_rotation"])(
      "session retries unreadable %s once and records the real original",
      async (key) => {
        const original = useSession();
        settingsSequence(["1", "0"]);
        fakeAdb.setCommandResponseSequence(`shell settings get system ${key}`, [
          createExecResult("null"),
          createExecResult(key === "user_rotation" ? "2" : "1"),
          createExecResult("0"),
        ]);
        const result = await rotate.execute("landscape", undefined, true);
        expect(result.success).toBe(true);
        expect(original()).toEqual({
          accelerometerRotation: 1,
          userRotation: key === "user_rotation" ? 2 : 0,
        });
      },
    );

    test.each(["match", "mismatch", "unreadable"])(
      "waitForRotation exception confirms live outcome %s before deciding rollback",
      async (outcome) => {
        useSession();
        settingsSequence(["1", "0"]);
        fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
          createExecResult("mRotation=0"),
          createExecResult(
            outcome === "unreadable" ? "" : outcome === "match" ? "mRotation=1" : "mRotation=0",
          ),
        ]);
        fakeAdb.setCommandResponseSequence("shell settings get system user_rotation", [
          createExecResult("2"),
          createExecResult("1"),
          createExecResult("2"),
        ]);
        const wait = spyOn(fakeAwaitIdle, "waitForRotation").mockRejectedValue(
          new Error("rotation wait failed"),
        );
        try {
          const result = await rotate.execute("landscape");
          expect(result.success).toBe(outcome === "match");
          expect(result.currentOrientation).toBe(
            outcome === "unreadable" ? "unknown" : outcome === "match" ? "landscape" : "portrait",
          );
          expect(fakeAdb.wasCommandExecuted("shell settings put system user_rotation 2")).toBe(
            outcome === "mismatch",
          );
          if (outcome === "unreadable") {
            expect(result.warning).toContain("unconfirmed");
          }
          if (outcome === "match") {
            expect(result.warning).toContain("rotation wait failed");
          }
        } finally {
          wait.mockRestore();
        }
      },
    );

    test("stalled live confirmation is bounded by FakeTimer and never rolls back", async () => {
      useSession();
      settingsSequence(["1", "0"]);
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("2"));
      const confirmation = Promise.withResolvers<ExecResult>();
      const execute = fakeAdb.executeCommand.bind(fakeAdb);
      let liveReads = 0;
      const read = spyOn(fakeAdb, "executeCommand").mockImplementation(async (command, ...args) => {
        if (command.includes("dumpsys window") && ++liveReads > 1) {
          return confirmation.promise;
        }
        return execute(command, ...args);
      });
      const wait = spyOn(fakeAwaitIdle, "waitForRotation").mockRejectedValue(
        new Error("rotation wait failed"),
      );
      try {
        const result = await rotate.execute("landscape");
        expect(result.success).toBe(false);
        expect(result.currentOrientation).toBe("unknown");
        expect(result.warning).toContain("unconfirmed");
        expect(result.warning).toContain("timed out after 1000ms");
        expect(fakeAdb.wasCommandExecuted("shell settings put system user_rotation 2")).toBe(false);
      } finally {
        confirmation.resolve(createExecResult(""));
        wait.mockRestore();
        read.mockRestore();
      }
    });

    test.each([
      { path: "success path", actorValue: "3" },
      { path: "catch path", actorValue: "3" },
      { path: "success path", actorValue: "2" },
      { path: "catch path", actorValue: "2" },
    ])(
      "confirmed mismatch preserves another actor's user_rotation $actorValue on the $path",
      async ({ path, actorValue }) => {
        fakeAdb.setCommandResponse(
          "shell dumpsys window displays",
          createExecResult("mRotation=0"),
        );
        fakeAdb.setCommandResponseSequence("shell settings get system user_rotation", [
          createExecResult("2"),
          createExecResult(actorValue),
        ]);
        const wait =
          path === "catch path"
            ? spyOn(fakeAwaitIdle, "waitForRotation").mockRejectedValue(
                new Error("rotation wait failed"),
              )
            : undefined;
        try {
          const result = await rotate.execute("landscape");
          expect(result.success).toBe(false);
          expect(result.warning).toContain("another actor");
          expect(fakeAdb.wasCommandExecuted("shell settings put system user_rotation 2")).toBe(
            false,
          );
        } finally {
          wait?.mockRestore();
        }
      },
    );

    test("confirmed direct reversion rolls user_rotation back to its pre-call value", async () => {
      fakeAdb.setCommandResponse("shell dumpsys window displays", createExecResult("mRotation=0"));
      fakeAdb.setCommandResponseSequence("shell settings get system user_rotation", [
        createExecResult("2"),
        createExecResult("1"),
        createExecResult("2"),
      ]);
      const result = await rotate.execute("landscape");
      expect(result.success).toBe(false);
      expect(result.currentOrientation).toBe("portrait");
      expect(fakeAdb.wasCommandExecuted("shell settings put system accelerometer_rotation 1")).toBe(
        true,
      );
      expect(fakeAdb.wasCommandExecuted("shell settings put system user_rotation 2")).toBe(true);
    });

    test("waitForRotation failure rolls user_rotation back only after confirmed mismatch", async () => {
      settingsSequence(["1"]);
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=0"),
      ]);
      fakeAdb.setCommandResponseSequence("shell settings get system user_rotation", [
        createExecResult("2"),
        createExecResult("1"),
        createExecResult("2"),
      ]);
      const wait = spyOn(fakeAwaitIdle, "waitForRotation").mockRejectedValue(
        new Error("rotation wait failed"),
      );
      try {
        const result = await rotate.execute("landscape");
        expect(result.success).toBe(false);
        expect(result.error).toContain("rotation wait failed");
        expect(fakeAdb.wasCommandExecuted("shell settings put system user_rotation 2")).toBe(true);
      } finally {
        wait.mockRestore();
      }
    });

    test("a user_rotation write that applies then rejects still rolls back", async () => {
      settingsSequence(["1"]);
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=0"),
      ]);
      fakeAdb.setCommandResponseSequence("shell settings get system user_rotation", [
        createExecResult("2"),
        createExecResult("1"),
        createExecResult("2"),
      ]);
      const execute = fakeAdb.executeCommand.bind(fakeAdb);
      const write = spyOn(fakeAdb, "executeCommand").mockImplementation(
        async (command, ...args) => {
          const result = await execute(command, ...args);
          if (command === "shell settings put system user_rotation 1") {
            throw new Error("write applied but failed");
          }
          return result;
        },
      );
      try {
        const result = await rotate.execute("landscape");
        expect(result.success).toBe(false);
        expect(result.error).toContain("write applied but failed");
        expect(fakeAdb.wasCommandExecuted("shell settings put system user_rotation 2")).toBe(true);
      } finally {
        write.mockRestore();
      }
    });

    test("rollback write failure adds warning and preserves the original rotation failure", async () => {
      settingsSequence(["1"]);
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=0"),
      ]);
      fakeAdb.setCommandResponseSequence("shell settings get system user_rotation", [
        createExecResult("2"),
        createExecResult("1"),
      ]);
      fakeAdb.setCommandError(
        "shell settings put system user_rotation 2",
        new Error("rollback failed"),
      );
      const wait = spyOn(fakeAwaitIdle, "waitForRotation").mockRejectedValue(
        new Error("rotation wait failed"),
      );
      try {
        const result = await rotate.execute("landscape");
        expect(result.success).toBe(false);
        expect(result.error).toContain("rotation wait failed");
        expect(result.warning).toContain("rollback failed");
      } finally {
        wait.mockRestore();
      }
    });

    test.each(["null", "1"])(
      "failed rotation skips rollback for unreadable or unchanged pre-call user_rotation %s",
      async (previous) => {
        settingsSequence(["1"]);
        fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
          createExecResult("mRotation=0"),
        ]);
        fakeAdb.setCommandResponse(
          "shell settings get system user_rotation",
          createExecResult(previous),
        );
        const wait = spyOn(fakeAwaitIdle, "waitForRotation").mockRejectedValue(
          new Error("rotation wait failed"),
        );
        try {
          const result = await rotate.execute("landscape");
          expect(result.success).toBe(false);
          expect(
            fakeAdb
              .getExecutedCommands()
              .filter((c) => c.startsWith("shell settings put system user_rotation")),
          ).toEqual(["shell settings put system user_rotation 1"]);
        } finally {
          wait.mockRestore();
        }
      },
    );

    test("unknown achieved orientation never rolls user_rotation back", async () => {
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=0"),
        createExecResult(""),
      ]);
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("2"));
      const result = await rotate.execute("landscape");
      expect(result.currentOrientation).toBe("unknown");
      expect(fakeAdb.wasCommandExecuted("shell settings put system user_rotation 2")).toBe(false);
    });

    test("abort after a user_rotation write never rolls it back", async () => {
      settingsSequence(["1"]);
      const controller = new AbortController();
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("2"));
      fakeAdb.abortAfterCommand("shell settings put system user_rotation 1", controller);
      await expect(
        rotate.execute("landscape", undefined, undefined, controller.signal),
      ).rejects.toThrow();
      expect(fakeAdb.wasCommandExecuted("shell settings put system user_rotation 2")).toBe(false);
    });
  });

  describe("getCurrentOrientation", () => {
    test("should return portrait for user_rotation 0", async () => {
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));

      const orientation = await rotate.getCurrentOrientation();

      expect(orientation).toBe("portrait");
      expect(fakeAdb.wasCommandExecuted("shell settings get system user_rotation")).toBe(true);
    });

    test("should return landscape for user_rotation 1", async () => {
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("1"));

      const orientation = await rotate.getCurrentOrientation();

      expect(orientation).toBe("landscape");
    });

    test("should return portrait for user_rotation 2", async () => {
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("2"));

      const orientation = await rotate.getCurrentOrientation();

      expect(orientation).toBe("portrait");
    });

    test("should return landscape for user_rotation 3", async () => {
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("3"));

      const orientation = await rotate.getCurrentOrientation();

      expect(orientation).toBe("landscape");
    });

    test("should prefer live mRotation over stale user_rotation (#6129)", async () => {
      // Auto-rotate has physically rotated the device to landscape, but the
      // `user_rotation` setting (only meaningful while auto-rotate is off)
      // is still stuck at its old portrait value.
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
      fakeAdb.setCommandResponse("shell dumpsys window displays", createExecResult("mRotation=1"));

      const orientation = await rotate.getCurrentOrientation();

      expect(orientation).toBe("landscape");
    });

    test("should fall back to user_rotation when dumpsys window has no mRotation", async () => {
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("2"));
      fakeAdb.setCommandResponse("shell dumpsys window displays", createExecResult(""));

      const orientation = await rotate.getCurrentOrientation();

      expect(orientation).toBe("portrait");
    });

    test("should return portrait as default when ADB command fails", async () => {
      fakeAdb.setDefaultResponse({
        stdout: "",
        stderr: "Error",
        toString() {
          return this.stderr;
        },
        trim() {
          return this.stderr.trim();
        },
        includes(s: string) {
          return this.stderr.includes(s);
        },
      });

      const orientation = await rotate.getCurrentOrientation();

      expect(orientation).toBe("portrait");
    });
  });

  describe("isOrientationLocked", () => {
    test("should return true when accelerometer_rotation is 0", async () => {
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("0"),
      );

      const isLocked = await rotate.isOrientationLocked();

      expect(isLocked).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell settings get system accelerometer_rotation")).toBe(
        true,
      );
    });

    test("should return false when accelerometer_rotation is 1", async () => {
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );

      const isLocked = await rotate.isOrientationLocked();

      expect(isLocked).toBe(false);
    });

    test("should return false as default when ADB command fails", async () => {
      fakeAdb.setDefaultResponse({
        stdout: "",
        stderr: "Error",
        toString() {
          return this.stderr;
        },
        trim() {
          return this.stderr.trim();
        },
        includes(s: string) {
          return this.stderr.includes(s);
        },
      });

      const isLocked = await rotate.isOrientationLocked();

      expect(isLocked).toBe(false);
    });
  });

  describe("execute", () => {
    test("already portrait succeeds without visual change or settings writes", async () => {
      fakeObserveScreen = new FakeObserveScreen();
      fakeObserveScreen.setObserveResult(() => ({
        ...createObserveResult(),
        viewHierarchy: { hierarchy: {} },
      }));
      Object.assign(rotate, { observeScreen: fakeObserveScreen });
      fakeAdb.setCommandResponse("shell dumpsys window displays", createExecResult("mRotation=0"));

      const result = await rotate.execute("portrait");

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(false);
      expect(result.orientation).toBe("portrait");
      expect(result.currentOrientation).toBe("portrait");
      expect(result.previousOrientation).toBe("portrait");
      expect(result.orientationLockState).toBe("unlocked");
      expect(result.observation?.viewHierarchy).toEqual({ hierarchy: {} });
      expect(fakeObserveScreen.getExecuteOptions().at(-1)?.freshness).toBe("fresh");
      expect(
        fakeAdb.getExecutedCommands().filter((command) => command.includes("settings put system")),
      ).toEqual([]);
    });

    test("performed rotation still fails without visual change", async () => {
      fakeObserveScreen = new FakeObserveScreen();
      fakeObserveScreen.setObserveResult(() => ({
        ...createObserveResult(),
        viewHierarchy: { hierarchy: {} },
      }));
      Object.assign(rotate, { observeScreen: fakeObserveScreen });
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=0"),
        createExecResult("mRotation=1"),
      ]);

      const result = await rotate.execute("landscape");

      expect(result.success).toBe(false);
      expect(result.rotationPerformed).toBe(true);
      expect(result.error).toBe("No visual change observed");
    });

    test("an unconfirmed lock remains a failure when orientation and hierarchy are unchanged", async () => {
      fakeObserveScreen = new FakeObserveScreen();
      fakeObserveScreen.setObserveResult(() => ({
        ...createObserveResult(),
        viewHierarchy: { hierarchy: {} },
      }));
      Object.assign(rotate, { observeScreen: fakeObserveScreen });
      fakeAdb.setCommandResponse("shell dumpsys window displays", createExecResult("mRotation=0"));

      const result = await rotate.execute("portrait", undefined, true);

      expect(result.success).toBe(false);
      expect(result.rotationPerformed).toBe(false);
      expect(result.orientationLockState).toBe("unlocked");
      expect(result.error).toBe(
        "Device was already in portrait orientation, but its exact locked rotation could not be confirmed (auto-rotate is unlocked).",
      );
    });

    test("should skip rotation when already in desired orientation", async () => {
      // Setup: device is already in portrait orientation
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult(""), // Preserve the initial user_rotation fallback.
        createExecResult("mRotation=0"), // End-of-call confirmation.
      ]);

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.orientation).toBe("portrait");
      expect(result.rotationPerformed).toBe(false);
      expect(result.message || "").toContain("already in portrait orientation");

      // Verify that we got the current orientation
      expect(fakeAdb.wasCommandExecuted("shell settings get system user_rotation")).toBe(true);
      // Should not have tried to set rotation since already in desired orientation
      expect(fakeAdb.wasCommandExecuted("shell settings put system user_rotation 0")).toBe(false);
    });

    test("should rotate a physically-landscape auto-rotated device instead of no-oping (#6129)", async () => {
      // Auto-rotate is on; the device is physically landscape (mRotation=1)
      // but `user_rotation` is stale at 0 (portrait). A prior bug trusted
      // `user_rotation` here and reported "already in portrait", never rotating.
      // The sensor settles on portrait once auto-rotate is restored (no override).
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=1"),
        createExecResult("mRotation=0"),
      ]);

      const result = await rotate.execute("portrait");

      expect(result.rotationPerformed).toBe(true);
      expect(result.previousOrientation).toBe("landscape");
      expect(result.currentOrientation).toBe("portrait");
      expect(result.warning).toBeUndefined();
      expect(fakeAdb.wasCommandExecuted("shell settings put system user_rotation 0")).toBe(true);
    });

    test("should select the LIVE display mRotation over a stale TaskSnapshot mRotation in realistic dumpsys output (#6199)", async () => {
      // Realistic `dumpsys window | grep -i "mRotation="` output: a cached
      // SnapshotCache entry embeds a historical (stale) TaskSnapshot rotation
      // BEFORE the authoritative WindowManagerService rotation line. A naive
      // "first match anywhere" parse picks the stale value and defeats #6129.
      const dumpsysWindowGrepOutput = [
        "     snapshot=TaskSnapshot{ mId=1749551414267 mCaptureTime=1748344877515 mTopActivityComponent=com.android.settings/.SubSettings mSnapshot=android.hardware.HardwareBuffer@d8e7fad (864x1920) mColorSpace=sRGB IEC61966-2.1 (id=0, model=RGB) mOrientation=1 mRotation=0 mTaskSize=Point(1080, 2400) mContentInsets=[0,74][0,63] mLetterboxInsets=[0,0][0,0] mIsLowResolution=false mIsRealSnapshot=true mWindowingMode=1 mAppearance=24 mIsTranslucent=false mHasImeSurface=false mInternalReferences=2",
        "  mRotation=1",
      ].join("\n");
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponse(
        "shell dumpsys window displays",
        createExecResult(dumpsysWindowGrepOutput),
      );

      const orientation = await rotate.getCurrentOrientation();

      // The authoritative live rotation (1 = landscape) must win over the
      // stale TaskSnapshot rotation (0 = portrait).
      expect(orientation).toBe("landscape");
    });

    test("should report the achieved orientation as unconfirmed when the post-restore live read is unparseable, never falling back to user_rotation (#6199)", async () => {
      // Auto-rotate is on; the device is physically landscape. The FIRST
      // dumpsys read (pre-rotation state check) succeeds and reports
      // landscape. After forcing portrait and restoring auto-rotate, the
      // confirmation dumpsys read is transiently unparseable (e.g. a
      // momentary empty/garbled `dumpsys window` response) — the code must
      // NOT fall back to the just-written `user_rotation` (which would
      // dishonestly echo "portrait" as if the sensor had held it) and must
      // NOT silently report the requested orientation as achieved.
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=1"),
        createExecResult(""),
      ]);

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      expect(result.previousOrientation).toBe("landscape");
      // Must NOT falsely report the requested orientation as achieved/held.
      expect(result.currentOrientation).not.toBe("portrait");
      expect(result.currentOrientation).toBe("unknown");
      expect(result.warning).toBeDefined();
      expect(result.warning ?? "").toMatch(/could not be confirmed/i);
    });

    test("should report achieved orientation as currentOrientation for landscape->portrait (#6057)", async () => {
      // Device starts in landscape (live mRotation=1), rotates to portrait
      // and the sensor settles on portrait (live mRotation=0) once
      // auto-rotate is restored. The post-restore confirmation read is LIVE
      // (mRotation), never a fallback to user_rotation (#6199 review).
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=1"),
        createExecResult("mRotation=0"),
      ]);
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      // currentOrientation must be the ACHIEVED orientation, not the stale prior value.
      expect(result.currentOrientation).toBe("portrait");
      // previousOrientation is legitimately the prior value.
      expect(result.previousOrientation).toBe("landscape");
      // The two fields must not duplicate on a performed rotation.
      expect(result.currentOrientation).not.toBe(result.previousOrientation);
      expect(result.message || "").toContain("Successfully rotated from landscape to portrait");
    });

    test("should report achieved orientation as currentOrientation for portrait->landscape (#6057)", async () => {
      // Device starts in portrait (live mRotation=0), rotates to landscape
      // and the sensor settles on landscape (live mRotation=1) once
      // auto-rotate is restored. The post-restore confirmation read is LIVE
      // (mRotation), never a fallback to user_rotation (#6199 review).
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=0"),
        createExecResult("mRotation=1"),
      ]);
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );

      const result = await rotate.execute("landscape");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      expect(result.currentOrientation).toBe("landscape");
      expect(result.previousOrientation).toBe("portrait");
      expect(result.currentOrientation).not.toBe(result.previousOrientation);
      expect(result.message || "").toContain("Successfully rotated from portrait to landscape");
    });

    test("should coincide currentOrientation and previousOrientation when already in orientation (#6057)", async () => {
      // Device already in portrait: no rotation performed, fields legitimately coincide.
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult(""),
        createExecResult("mRotation=0"),
      ]);

      const result = await rotate.execute("portrait");

      expect(result.rotationPerformed).toBe(false);
      expect(result.currentOrientation).toBe("portrait");
      expect(result.previousOrientation).toBe("portrait");
      expect(result.currentOrientation).toBe(result.previousOrientation);
    });

    test("should get current orientation and lock status before rotation", async () => {
      // Setup: device starts in portrait, needs to rotate to landscape
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponse(
        'shell "settings put system accelerometer_rotation 0; settings put system user_rotation 1"',
        createExecResult(),
      );

      await rotate.execute("landscape");

      // Verify ADB calls were made to check orientation state
      expect(fakeAdb.wasCommandExecuted("shell settings get system user_rotation")).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell settings get system accelerometer_rotation")).toBe(
        true,
      );
    });

    test("should attempt rotation command when orientation differs", async () => {
      // Setup: device is in portrait, rotating to landscape
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponse(
        "shell settings put system accelerometer_rotation 0",
        createExecResult(),
      );
      fakeAdb.setCommandResponse("shell settings put system user_rotation 1", createExecResult());

      await rotate.execute("landscape");

      // Verify both rotation commands were executed
      expect(fakeAdb.wasCommandExecuted("shell settings put system accelerometer_rotation 0")).toBe(
        true,
      );
      expect(fakeAdb.wasCommandExecuted("shell settings put system user_rotation 1")).toBe(true);
    });

    test("disables auto-rotate before writing a persistent target rotation (#6350)", async () => {
      fakeAdb.setCommandResponseSequence("shell settings get system accelerometer_rotation", [
        createExecResult("1"),
        createExecResult("0"),
      ]);
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=0"),
        createExecResult("mRotation=1"),
      ]);

      let releaseDisableWrite: (() => void) | undefined;
      let disableWriteStarted = false;
      let userRotationWriteStarted = false;
      const disableWriteGate = new Promise<void>((resolve) => {
        releaseDisableWrite = resolve;
      });
      const originalExecuteCommand = fakeAdb.executeCommand.bind(fakeAdb);
      fakeAdb.executeCommand = (async (command: string, ...rest: unknown[]) => {
        if (command.includes("settings put system accelerometer_rotation 0")) {
          disableWriteStarted = true;
          await disableWriteGate;
        }
        if (command.includes("settings put system user_rotation 1")) {
          userRotationWriteStarted = true;
        }
        return (originalExecuteCommand as (...args: unknown[]) => Promise<ExecResult>)(
          command,
          ...rest,
        );
      }) as typeof fakeAdb.executeCommand;

      const rotation = rotate.execute("landscape", undefined, true);
      for (let i = 0; i < 50 && !disableWriteStarted; i++) {
        await Promise.resolve();
      }

      expect(disableWriteStarted).toBe(true);
      expect(userRotationWriteStarted).toBe(false);

      releaseDisableWrite!();
      const result = await rotation;
      expect(result.success).toBe(true);
    });

    test("should rotate directly (without unlocking) when orientation is already locked", async () => {
      // Setup: device is landscape with orientation locked
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("1"));
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("0"),
      ); // Locked
      fakeAdb.setCommandResponse(
        "shell settings put system accelerometer_rotation 0",
        createExecResult(),
      );
      fakeAdb.setCommandResponse("shell settings put system user_rotation 0", createExecResult());

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      // Verify the rotation commands were executed
      expect(fakeAdb.wasCommandExecuted("shell settings put system accelerometer_rotation 0")).toBe(
        true,
      );
      expect(fakeAdb.wasCommandExecuted("shell settings put system user_rotation 0")).toBe(true);
      // Locked devices stay locked (to the newly-requested orientation) rather
      // than being unlocked then immediately re-locked, which was a no-op.
      expect(fakeAdb.wasCommandExecuted("shell settings put system accelerometer_rotation 1")).toBe(
        false,
      );
      expect(result.orientationLockHandled).toBe(false);
    });

    test("should restore auto-rotate after forcing a rotation while it was enabled (#6129)", async () => {
      // Device starts landscape with auto-rotate ON (unlocked); the sensor
      // settles on portrait (live mRotation=0) once auto-rotate is restored
      // (no override). The post-restore confirmation read is LIVE
      // (mRotation), never a fallback to user_rotation (#6199 review).
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=1"),
        createExecResult("mRotation=0"),
      ]);
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      expect(result.orientationLockHandled).toBe(true);
      expect(result.orientationLockState).toBe("unlocked");
      expect(result.warning).toBeUndefined();
      // Auto-rotate must be forced off to apply user_rotation, then restored.
      expect(fakeAdb.wasCommandExecuted("shell settings put system accelerometer_rotation 0")).toBe(
        true,
      );
      expect(fakeAdb.wasCommandExecuted("shell settings put system accelerometer_rotation 1")).toBe(
        true,
      );
      // The restore ("1") must be the LAST accelerometer_rotation write, not left at 0.
      const accelWrites = fakeAdb
        .getExecutedCommands()
        .filter((cmd) => cmd.includes("settings put system accelerometer_rotation"));
      expect(accelWrites.at(-1)).toContain("accelerometer_rotation 1");
    });

    test("keeps a requested portrait locked when the sensor prefers landscape (#6350)", async () => {
      // The device begins physically landscape with auto-rotate on. A durable
      // portrait request must leave accelerometer_rotation disabled instead of
      // restoring it and letting the sensor snap back to landscape.
      fakeAdb.setCommandResponseSequence("shell settings get system accelerometer_rotation", [
        createExecResult("1"),
        createExecResult("0"),
      ]);
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=1"),
        createExecResult("mRotation=0"),
      ]);

      const result = await rotate.execute("portrait", undefined, true);

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      expect(result.currentOrientation).toBe("portrait");
      expect(result.orientationLockState).toBe("locked");
      expect(fakeAdb.wasCommandExecuted("shell settings put system accelerometer_rotation 1")).toBe(
        false,
      );
      expect(fakeAwaitIdle.wasMethodCalled("waitForRotation(0")).toBe(true);
    });

    test("keeps a requested landscape locked when the sensor prefers portrait (#6350)", async () => {
      fakeAdb.setCommandResponseSequence("shell settings get system accelerometer_rotation", [
        createExecResult("1"),
        createExecResult("0"),
      ]);
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=0"),
        createExecResult("mRotation=1"),
      ]);

      const result = await rotate.execute("landscape", undefined, true);

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      expect(result.currentOrientation).toBe("landscape");
      expect(result.orientationLockState).toBe("locked");
      expect(fakeAdb.wasCommandExecuted("shell settings put system accelerometer_rotation 1")).toBe(
        false,
      );
      expect(fakeAwaitIdle.wasMethodCalled("waitForRotation(1")).toBe(true);
    });

    test("reports a lock-only request without claiming a rotation (#6350)", async () => {
      fakeObserveScreen = new FakeObserveScreen();
      fakeObserveScreen.setObserveResult(() => ({
        ...createObserveResult(),
        viewHierarchy: { hierarchy: {} },
      }));
      Object.assign(rotate, { observeScreen: fakeObserveScreen });
      // The display is already landscape, but auto-rotate must still be
      // disabled to make that orientation persistent.
      fakeAdb.setCommandResponseSequence("shell settings get system accelerometer_rotation", [
        createExecResult("1"),
        createExecResult("0"),
      ]);
      fakeAdb.setCommandResponse("shell dumpsys window displays", createExecResult("mRotation=1"));

      const result = await rotate.execute("landscape", undefined, true);

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(false);
      expect(result.orientationLockState).toBe("locked");
      expect(result.message).toBe("Locked device orientation to landscape.");
      const commands = fakeAdb.getExecutedCommands();
      expect(commands.indexOf("shell settings put system user_rotation 1")).toBeGreaterThan(-1);
      expect(commands.indexOf("shell settings put system user_rotation 1")).toBeLessThan(
        commands.indexOf("shell settings put system accelerometer_rotation 0"),
      );
      expect(fakeAwaitIdle.wasMethodCalled("waitForRotation(1")).toBe(true);
    });

    test("locks reverse portrait without forcing canonical portrait rotation (#6350)", async () => {
      // mRotation=2 is reverse portrait. Locking it must preserve the exact
      // live rotation by saving user_rotation=2 before disabling auto-rotate,
      // rather than writing canonical user_rotation=0 and rotating 180 degrees.
      fakeAdb.setCommandResponseSequence("shell settings get system accelerometer_rotation", [
        createExecResult("1"),
        createExecResult("0"),
      ]);
      fakeAdb.setCommandResponse("shell dumpsys window displays", createExecResult("mRotation=2"));

      const result = await rotate.execute("portrait", undefined, true);

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(false);
      expect(result.orientationLockState).toBe("locked");
      expect(fakeAdb.wasCommandExecuted("shell settings put system user_rotation 2")).toBe(true);
      expect(fakeAdb.wasCommandExecuted("shell settings put system user_rotation 0")).toBe(false);
      expect(fakeAwaitIdle.wasMethodCalled("waitForRotation(2")).toBe(true);
    });

    test.each([
      { liveRotation: "mRotation=3", expectedOrientation: "landscape" },
      { liveRotation: "unavailable", expectedOrientation: "unknown" },
    ])(
      "reports $expectedOrientation after persistent lock verification fails (#6350)",
      async ({ liveRotation, expectedOrientation }) => {
        // waitForRotation confirmed the requested portrait, but auto-rotate is
        // still enabled: the sensor may already have restored landscape.
        fakeAdb.setCommandResponse(
          "shell settings get system accelerometer_rotation",
          createExecResult("1"),
        );
        fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
          createExecResult("mRotation=1"),
          createExecResult(liveRotation),
          createExecResult(liveRotation),
          createExecResult(liveRotation),
        ]);

        const result = await rotate.execute("portrait", undefined, true);

        expect(result.success).toBe(false);
        expect(result.rotationPerformed).toBe(true);
        expect(result.currentOrientation).toBe(expectedOrientation);
        expect(result.orientationLockState).toBe("unlocked");
        expect(result.error ?? "").toMatch(/persistent.*could not be confirmed/i);
      },
    );

    test("reports the remaining lock state after a persistent target write fails (#6350)", async () => {
      // Disabling auto-rotate can succeed before the target write fails. The
      // failure result must expose that the device remains locked rather than
      // leaving callers unable to determine which cleanup action is needed.
      fakeAdb.setCommandResponseSequence("shell settings get system accelerometer_rotation", [
        createExecResult("1"),
        createExecResult("0"),
      ]);
      fakeAdb.setCommandResponse("shell dumpsys window displays", createExecResult("mRotation=1"));
      fakeAdb.setCommandError(
        "shell settings put system user_rotation 0",
        new Error("settings provider unavailable"),
      );

      const result = await rotate.execute("portrait", undefined, true);

      expect(result.success).toBe(false);
      expect(result.rotationPerformed).toBe(false);
      expect(result.orientationLockState).toBe("locked");
      expect(result.error ?? "").toContain("settings provider unavailable");
    });

    test("explicitly restores automatic rotation after a persistent request (#6350)", async () => {
      fakeObserveScreen = new FakeObserveScreen();
      fakeObserveScreen.setObserveResult(() => ({
        ...createObserveResult(),
        viewHierarchy: { hierarchy: {} },
      }));
      Object.assign(rotate, { observeScreen: fakeObserveScreen });
      // This is the documented inverse of lockOrientation: true. The desired
      // orientation is already applied, so the operation must still re-enable
      // automatic rotation rather than taking the existing no-op return path.
      fakeAdb.setCommandResponseSequence("shell settings get system accelerometer_rotation", [
        createExecResult("0"),
        createExecResult("1"),
      ]);
      fakeAdb.setCommandResponse("shell dumpsys window displays", createExecResult("mRotation=0"));

      const result = await rotate.execute("portrait", undefined, false);

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(false);
      expect(result.orientationLockState).toBe("unlocked");
      expect(fakeAdb.wasCommandExecuted("shell settings put system accelerometer_rotation 1")).toBe(
        true,
      );
    });

    test("should not mutate accelerometer_rotation at all when it is unreadable (#6199)", async () => {
      // accelerometer_rotation is malformed/unreadable — this must be treated
      // as "unknown". We must not force it off (no confirmed prior value to
      // restore afterward), so user_rotation is written on its own and
      // whatever the real device does with it is reported honestly by
      // waitForRotation rather than covered up with a guessed restore.
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("1"));
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("not-a-number"),
      );

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      expect(result.orientationLockHandled).toBe(false);
      // user_rotation is still written...
      expect(fakeAdb.wasCommandExecuted("shell settings put system user_rotation 0")).toBe(true);
      // ...but accelerometer_rotation is never mutated in either direction:
      // no disable, and (necessarily) no unconfirmed "restore" either.
      expect(fakeAdb.wasCommandExecuted("shell settings put system accelerometer_rotation 0")).toBe(
        false,
      );
      expect(fakeAdb.wasCommandExecuted("shell settings put system accelerometer_rotation 1")).toBe(
        false,
      );
    });

    test("settle-waits (retries via the injected Timer) before accepting a transient post-restore read, instead of confirming immediately (#6211)", async () => {
      // Auto-rotate is on; the device starts landscape. After forcing
      // portrait and restoring auto-rotate, the FIRST confirmation read
      // catches a transient not-yet-settled WindowManager still reporting
      // landscape; the SECOND read (after the settle-wait sleep) shows the
      // sensor has settled on portrait. The settle-wait must retry via
      // `this.timer.sleep` rather than confirming off the stale first read.
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=1"), // pre-rotation state check
        createExecResult("mRotation=1"), // post-restore confirm attempt 1: transient/unsettled
        createExecResult("mRotation=0"), // post-restore confirm attempt 2: settled
      ]);

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      // Settled on the requested orientation, not the transient stale read.
      expect(result.currentOrientation).toBe("portrait");
      expect(result.warning).toBeUndefined();
      // The settle-wait must have slept (i.e. actually retried) via the
      // injected Timer before accepting the second read as final.
      expect(fakeTimer.getSleepCallCount()).toBeGreaterThan(0);
    });

    test("does not accept a lone match on the FINAL settle-wait attempt, since there is no later sample to confirm it (#6211)", async () => {
      // Auto-rotate is on; the device starts landscape. After forcing
      // portrait and restoring auto-rotate, the settle-wait budget
      // (SETTLE_WAIT_MAX_ATTEMPTS=3) is exhausted with landscape, landscape,
      // then the requested portrait on the very last attempt — a single,
      // unconfirmed match with no opportunity for a later stability read.
      // Unconditionally returning that final value would falsely report
      // "portrait" held; it must instead be reported as unconfirmed.
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=1"), // pre-rotation state check
        createExecResult("mRotation=1"), // post-restore confirm attempt 1: landscape
        createExecResult("mRotation=1"), // post-restore confirm attempt 2: landscape
        createExecResult("mRotation=0"), // post-restore confirm attempt 3 (final): lone portrait match
      ]);

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      // Must NOT report the requested orientation as confirmed off a single,
      // unconfirmable final-attempt sample.
      expect(result.currentOrientation).toBe("unknown");
      expect(result.warning).toBeDefined();
      expect(result.warning ?? "").toMatch(/could not be confirmed/i);
      // The settle-wait must have exhausted its full retry budget (slept
      // between every attempt) rather than stopping early on the lone match.
      expect(fakeTimer.getSleepCallCount()).toBe(2);
    });

    test("does not report a lone final opposite-orientation sample as a confirmed reversion (#6211)", async () => {
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=1"), // pre-rotation state check
        createExecResult(""), // settle attempt 1: unreadable
        createExecResult(""), // settle attempt 2: unreadable
        createExecResult("mRotation=1"), // settle attempt 3: lone landscape sample
      ]);

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.currentOrientation).toBe("unknown");
      expect(result.warning ?? "").toMatch(/could not be confirmed/i);
      expect(fakeTimer.getSleepCallCount()).toBe(2);
    });

    test("does not accept a lone match on the FINAL settle-wait attempt after an earlier non-adjacent match resets the streak (#6211)", async () => {
      // Alternate sequence from the review finding: portrait, landscape,
      // portrait. The first attempt matches but is immediately broken by the
      // second (non-matching) attempt, resetting the consecutive-match
      // streak; the third (final) attempt matches again but, being the last
      // attempt, has no later sample to confirm it either.
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=1"), // pre-rotation state check
        createExecResult("mRotation=0"), // post-restore confirm attempt 1: portrait (lone, then broken)
        createExecResult("mRotation=1"), // post-restore confirm attempt 2: landscape (breaks the streak)
        createExecResult("mRotation=0"), // post-restore confirm attempt 3 (final): lone portrait match again
      ]);

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      expect(result.currentOrientation).toBe("unknown");
      expect(result.warning).toBeDefined();
      expect(result.warning ?? "").toMatch(/could not be confirmed/i);
    });

    test("gives up after the settle-wait budget and honestly reports unconfirmed when the read never settles (#6211)", async () => {
      // The confirmation read stays unparseable across every settle-wait
      // attempt (persistent, not transient) — must still end up "unknown"
      // rather than retrying forever or fabricating a result.
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=1"), // pre-rotation state check
        createExecResult(""), // every confirm attempt thereafter is unparseable
      ]);

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.currentOrientation).toBe("unknown");
      expect(result.warning ?? "").toMatch(/could not be confirmed/i);
    });

    test("confirms the true live orientation (rather than assuming it held) when the auto-rotate restore write fails, and preserves it when it does hold (#6211)", async () => {
      // waitForRotation has already CONFIRMED the requested rotation while
      // auto-rotate was forced off. The subsequent accelerometer_rotation=1
      // restore write then throws — but a REJECTED write does not prove
      // auto-rotate stayed disabled (the underlying put can time out AFTER
      // CtrlProxy already applied it), so the code must re-read the live
      // orientation rather than assume it held. Here the re-read confirms
      // portrait genuinely still holds, so the confirmed rotation is
      // preserved with a warning noting the ambiguous restore, not
      // discarded as an overall failure.
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=1"), // pre-rotation state check
        createExecResult("mRotation=0"), // post-write-failure confirm reads: portrait genuinely holds
      ]);
      fakeAdb.setCommandError(
        "shell settings put system accelerometer_rotation 1",
        new Error("device offline"),
      );

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      expect(result.currentOrientation).toBe("portrait");
      expect(result.previousOrientation).toBe("landscape");
      expect(result.warning).toBeDefined();
      expect(result.warning ?? "").toMatch(/ambiguous outcome/i);
      // The restore-write failure must NOT skip re-confirming the live
      // orientation — it must be re-queried, not assumed (#6211 review).
      const dumpsysCalls = fakeAdb
        .getExecutedCommands()
        .filter((cmd) => cmd.includes("shell dumpsys window displays")).length;
      expect(dumpsysCalls).toBeGreaterThan(1);
    });

    test("retries the auto-rotate restore write once before treating a transient failure as ambiguous (#6211)", async () => {
      // Auto-rotate is on; the device starts landscape. The FIRST
      // accelerometer_rotation=1 restore write attempt fails transiently
      // (e.g. a momentary CtrlProxy/ADB hiccup), but a retry of the same
      // idempotent write succeeds. This must not be reported as an ambiguous
      // outcome — the retry recovers it cleanly.
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=1"), // pre-rotation state check
        createExecResult("mRotation=0"), // post-restore confirm attempt 1: portrait
        createExecResult("mRotation=0"), // post-restore confirm attempt 2: portrait (confirmed stable)
      ]);

      let restoreWriteAttempts = 0;
      const originalExecuteCommand = fakeAdb.executeCommand.bind(fakeAdb);
      fakeAdb.executeCommand = (async (command: string, ...rest: unknown[]) => {
        if (command.includes("settings put system accelerometer_rotation 1")) {
          restoreWriteAttempts++;
          if (restoreWriteAttempts === 1) {
            throw new Error("transient device offline");
          }
        }
        return (originalExecuteCommand as (...args: unknown[]) => Promise<ExecResult>)(
          command,
          ...rest,
        );
      }) as typeof fakeAdb.executeCommand;

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      expect(result.currentOrientation).toBe("portrait");
      // No ambiguity: the retry recovered the restore write cleanly.
      expect(result.warning).toBeUndefined();
      // The restore write must have been attempted twice: once, then a retry.
      expect(restoreWriteAttempts).toBe(2);
    });

    test("keeps the ambiguous-restore warning state-neutral instead of asserting auto-rotate is enabled (#6211)", async () => {
      // The accelerometer_rotation=1 restore write fails on both the first
      // attempt and the retry (persistent, not transient), and the live
      // confirmation read never settles either. The composed warning must
      // not claim "auto-rotate is enabled" — that state was never actually
      // confirmed — while still explaining the ambiguous outcome.
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=1"), // pre-rotation state check
        createExecResult(""), // every post-restore confirm attempt is unparseable
      ]);
      fakeAdb.setCommandError(
        "shell settings put system accelerometer_rotation 1",
        new Error("device offline"),
      );

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(true);
      expect(result.rotationPerformed).toBe(true);
      expect(result.currentOrientation).toBe("unknown");
      expect(result.warning).toBeDefined();
      const warning = result.warning ?? "";
      expect(warning).toMatch(/ambiguous outcome/i);
      expect(warning).toMatch(/could not be confirmed/i);
      // State-neutral: must not assert a state that was never confirmed.
      expect(warning).not.toMatch(/auto-rotate is enabled/i);
    });

    test("serializes concurrent rotations on the same device so auto-rotate restore is not corrupted (#6199)", async () => {
      // Device starts portrait with auto-rotate ON.
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );

      // Gate the FIRST rotation's waitForRotation call so it parks mid-flight
      // — after reading state and writing accelerometer_rotation=0, but
      // before restoring it — giving a concurrent second rotation on the same
      // device a window to race it if the critical section is not serialized.
      let releaseFirstWait: (() => void) | undefined;
      const firstWaitGate = new Promise<void>((resolve) => {
        releaseFirstWait = resolve;
      });
      let waitForRotationCalls = 0;
      const gatedAwaitIdle = {
        waitForRotation: async () => {
          waitForRotationCalls++;
          if (waitForRotationCalls === 1) {
            await firstWaitGate;
          }
        },
      };
      (rotate as any).awaitIdle = gatedAwaitIdle;

      const secondRotate = new Rotate(mockDevice, fakeAdb, fakeTimer);
      (secondRotate as any).awaitIdle = gatedAwaitIdle;
      (secondRotate as any).observeScreen = fakeObserveScreen;
      (secondRotate as any).window = fakeWindow;

      const lock = (rotate as any).getRotationLock();
      // Same deviceId -> the second instance must resolve to the SAME lock.
      expect((secondRotate as any).getRotationLock()).toBe(lock);

      const firstCall = rotate.execute("landscape");

      // Let the first call's microtasks run until it holds the lock and is
      // parked at the gate.
      for (let i = 0; i < 50 && !lock.isLocked(); i++) {
        await Promise.resolve();
      }
      expect(lock.isLocked()).toBe(true);

      // Same requested orientation as the first call: `user_rotation` is
      // stubbed at a constant stale "0" (portrait) regardless of what either
      // call writes, so both calls see "not yet landscape" and must go
      // through the full write/restore flow rather than short-circuiting.
      const secondCall = secondRotate.execute("landscape");

      // Give the second call every chance to run if it were (incorrectly)
      // unserialized; it must still be blocked on the lock, so it must not
      // have read device state yet.
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }
      const accelGetsWhileFirstHoldsLock = fakeAdb
        .getExecutedCommands()
        .filter((cmd) => cmd.includes("settings get system accelerometer_rotation")).length;
      expect(accelGetsWhileFirstHoldsLock).toBe(1);

      releaseFirstWait!();
      const [firstResult, secondResult] = await Promise.all([firstCall, secondCall]);

      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);
      expect(firstResult.orientationLockHandled).toBe(true);
      expect(secondResult.orientationLockHandled).toBe(true);

      // The second rotation must observe the FIRST rotation's fully-restored
      // state, not its transient accelerometer_rotation=0 — and must end up
      // restoring auto-rotate itself, not stuck at 0.
      const accelWrites = fakeAdb
        .getExecutedCommands()
        .filter((cmd) => cmd.includes("settings put system accelerometer_rotation"));
      expect(accelWrites.at(-1)).toContain("accelerometer_rotation 1");
      expect(lock.isLocked()).toBe(false);
    });
  });

  describe("edge cases", () => {
    test("should handle whitespace in ADB output", async () => {
      fakeAdb.setCommandResponse(
        "shell settings get system user_rotation",
        createExecResult("  1  \n"),
      );

      const orientation = await rotate.getCurrentOrientation();

      expect(orientation).toBe("landscape");
    });

    test("should handle non-numeric ADB output", async () => {
      fakeAdb.setCommandResponse(
        "shell settings get system user_rotation",
        createExecResult("not-a-number"),
      );

      const orientation = await rotate.getCurrentOrientation();

      expect(orientation).toBe("portrait"); // Should default to portrait
    });

    test("should handle empty ADB output", async () => {
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult(""));

      const orientation = await rotate.getCurrentOrientation();

      expect(orientation).toBe("portrait"); // Should default to portrait
    });
  });

  describe("Android post-restore verification (#8768)", () => {
    test("should honestly report the sensor-held orientation when auto-rotate overrides the forced rotation (#6199)", async () => {
      // Auto-rotate is on and the physical sensor stays landscape throughout
      // (e.g. the device is physically held sideways) — restoring auto-rotate
      // after forcing portrait immediately snaps it back to landscape. The
      // result must report the ACHIEVED orientation and warn, not falsely
      // claim portrait succeeded.
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      // mRotation reads landscape both before AND after the forced rotation +
      // restore — the sensor never let go of landscape.
      fakeAdb.setCommandResponse("shell dumpsys window displays", createExecResult("mRotation=1"));

      fakeObserveScreen = new FakeObserveScreen();
      fakeObserveScreen.setObserveResult(() => createObserveResult());
      Object.assign(rotate, { observeScreen: fakeObserveScreen });

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(false);
      expect(result.error).toContain("auto-rotate reverted");
      expect(formatRotateMessage(result)).toBe(`Failed to rotate device: ${result.error}`);
      expect(result.error).toContain("portrait");
      expect(result.error).toContain("landscape");
      expect(result.error).toContain("lockOrientation: true");
      expect(result.error).not.toContain("No visual change observed");
      expect(result.rotationPerformed).toBe(false);
      expect(result.previousOrientation).toBe("landscape");
      // Must report what is ACTUALLY held, not a false "portrait" success.
      expect(result.currentOrientation).toBe("landscape");
      expect(result.warning).toBeDefined();
      expect(result.warning ?? "").toMatch(/auto-rotate/i);
      expect(result.warning ?? "").toContain("landscape");
    });

    test("does not accept a first post-restore sample matching the requested orientation without confirming it is stable (#6211)", async () => {
      // Auto-rotate is on; the device starts landscape. After forcing
      // portrait and restoring auto-rotate, the FIRST confirmation read
      // already matches the requested "portrait" — but the physical sensor
      // swings it back to landscape moments later. A fix that returns on the
      // first matching sample without confirming stability would falsely
      // report "portrait" held; the settle-wait must confirm the match holds
      // across a second read before accepting it.
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=1"), // pre-rotation state check
        createExecResult("mRotation=0"), // post-restore confirm attempt 1: matches requested portrait...
        createExecResult("mRotation=1"), // ...but attempt 2 reveals it swung back to landscape
      ]);

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(false);
      expect(result.error).toContain("portrait");
      expect(result.error).toContain("landscape");
      expect(result.error).toContain("lockOrientation: true");
      expect(result.error).not.toContain("No visual change observed");
      expect(result.rotationPerformed).toBe(false);
      // Must report the ACTUAL orientation (landscape), not the transient
      // first-sample match that was never confirmed stable.
      expect(result.currentOrientation).toBe("landscape");
      expect(result.warning).toBeDefined();
      expect(result.warning ?? "").toMatch(/reverted/i);
      // The settle-wait must have kept sampling past the first match.
      expect(fakeTimer.getSleepCallCount()).toBeGreaterThan(0);
    });

    test("reflects the true reverted orientation, not the requested one, when an ambiguous restore-write failure turns out to have actually re-enabled auto-rotate (#6211)", async () => {
      // The accelerometer_rotation=1 restore write throws (ambiguous outcome:
      // it may have been applied by CtrlProxy before the failure was
      // reported), and the physical sensor genuinely reverts the device once
      // auto-rotate is back on. The code must report the ACTUAL confirmed
      // orientation, not blindly assume the forced rotation still holds just
      // because the restore write appeared to fail.
      fakeAdb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=1"), // pre-rotation state check (landscape before)
        createExecResult("mRotation=1"), // post-write-failure confirm reads: reverted to landscape
      ]);
      fakeAdb.setCommandError(
        "shell settings put system accelerometer_rotation 1",
        new Error("device offline"),
      );

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(false);
      expect(result.error).toContain("portrait");
      expect(result.error).toContain("landscape");
      expect(result.error).toContain("lockOrientation: true");
      expect(result.error).not.toContain("No visual change observed");
      expect(result.rotationPerformed).toBe(false);
      // Must report the TRUE confirmed orientation, not the requested one.
      expect(result.currentOrientation).toBe("landscape");
      expect(result.previousOrientation).toBe("landscape");
      expect(result.warning).toBeDefined();
      expect(result.warning ?? "").toMatch(/reverted/i);
      // The live read confirms landscape, but the rejected restore write does
      // not prove auto-rotate caused it. Keep the evidence without inventing
      // that causal outcome in the public message.
      expect(result.message).toContain("attempting to restore auto-rotate");
      expect(result.message).toContain("confirmed landscape");
      expect(result.message).not.toMatch(/auto-rotate reverted/i);
    });

    test("retains a confirmed stable opposite orientation when the FINAL settle-wait sample fails to read (#6211)", async () => {
      // Auto-rotate is on; the device starts landscape. After forcing
      // portrait and restoring auto-rotate, the first two post-restore
      // samples both read landscape (two consecutive matching samples — a
      // confirmed reversion), but the third (final) settle-wait attempt
      // fails to parse at all. That read FAILURE must not discard the
      // already-confirmed landscape reversion in favor of "unknown".
      fakeAdb.setCommandResponse(
        "shell settings get system accelerometer_rotation",
        createExecResult("1"),
      );
      fakeAdb.setCommandResponseSequence("shell dumpsys window displays", [
        createExecResult("mRotation=1"), // pre-rotation state check
        createExecResult("mRotation=1"), // post-restore confirm attempt 1: landscape
        createExecResult("mRotation=1"), // post-restore confirm attempt 2: landscape (confirmed stable)
        createExecResult(""), // post-restore confirm attempt 3 (final): unparseable
      ]);

      const result = await rotate.execute("portrait");

      expect(result.success).toBe(false);
      expect(result.error).toContain("portrait");
      expect(result.error).toContain("landscape");
      expect(result.error).toContain("lockOrientation: true");
      expect(result.error).not.toContain("No visual change observed");
      expect(result.rotationPerformed).toBe(false);
      // Must report the confirmed landscape reversion, not "unknown".
      expect(result.currentOrientation).toBe("landscape");
      expect(result.warning).toBeDefined();
      expect(result.warning ?? "").toMatch(/reverted/i);
    });
  });

  describe("iOS platform", () => {
    let iosDevice: BootedDevice;
    let fakeIOSCtrlProxy: FakeIOSCtrlProxy;
    let getInstanceSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      iosDevice = {
        name: "iPhone 15",
        platform: "ios",
        deviceId: "ios-device",
        source: "local",
      };

      fakeIOSCtrlProxy = new FakeIOSCtrlProxy();
      getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeIOSCtrlProxy as any,
      );
    });

    test("should use CtrlProxy to rotate to landscape on iOS", async () => {
      fakeObserveScreen.setObserveSequence([
        createObserveResult(),
        { ...createObserveResult(), rotation: 1, screenSize: { width: 874, height: 402 } },
      ]);
      const iosRotate = new Rotate(iosDevice, fakeAdb, fakeTimer);
      (iosRotate as any).observeScreen = fakeObserveScreen;
      (iosRotate as any).window = fakeWindow;
      (iosRotate as any).awaitIdle = fakeAwaitIdle;

      try {
        const result = await iosRotate.execute("landscape");
        expect(result.success).toBe(true);
        expect(result.orientation).toBe("landscape");
        expect(result.rotationPerformed).toBe(true);
        expect(fakeIOSCtrlProxy.getRotateHistory()).toHaveLength(1);
        expect(fakeIOSCtrlProxy.getRotateHistory()[0].orientation).toBe("landscape");
      } finally {
        getInstanceSpy.mockRestore();
      }
    });

    test("surfaces an unsupported-display response from the runner", async () => {
      spyOn(fakeIOSCtrlProxy, "requestRotate").mockResolvedValue({
        success: false,
        totalTimeMs: 1,
        previousOrientation: "unknown",
        currentOrientation: "unknown",
        value: 0,
        rotationPerformed: false,
        error: "Rotation is not supported on this display (the screen size did not change)",
      });
      const iosRotate = new Rotate(iosDevice, fakeAdb, fakeTimer);
      Object.assign(iosRotate, {
        observeScreen: fakeObserveScreen,
        window: fakeWindow,
        awaitIdle: fakeAwaitIdle,
      });
      try {
        const result = await iosRotate.execute("landscape");
        expect(result.success).toBe(false);
        expect(result.error).toBe(
          "Rotation is not supported on this display (the screen size did not change)",
        );
      } finally {
        getInstanceSpy.mockRestore();
      }
    });

    test("rejects a claimed rotation from unknown when display size is unchanged", async () => {
      spyOn(fakeIOSCtrlProxy, "requestRotate").mockResolvedValue({
        success: true,
        totalTimeMs: 1,
        previousOrientation: "unknown",
        currentOrientation: "landscape_left",
        value: 1,
        rotationPerformed: true,
      });
      const iosRotate = new Rotate(iosDevice, fakeAdb, fakeTimer);
      Object.assign(iosRotate, {
        observeScreen: fakeObserveScreen,
        window: fakeWindow,
        awaitIdle: fakeAwaitIdle,
      });
      try {
        const result = await iosRotate.execute("landscape");
        expect(result.success).toBe(false);
        expect(result.error).toContain("screen size did not change");
      } finally {
        getInstanceSpy.mockRestore();
      }
    });

    test("accepts a portrait no-op without a visual change", async () => {
      fakeObserveScreen = new FakeObserveScreen();
      fakeObserveScreen.setObserveResult(() => ({
        ...createObserveResult(),
        viewHierarchy: { hierarchy: {} },
      }));
      const iosRotate = new Rotate(iosDevice, fakeAdb, fakeTimer);
      Object.assign(iosRotate, {
        observeScreen: fakeObserveScreen,
        window: fakeWindow,
        awaitIdle: fakeAwaitIdle,
      });
      try {
        const result = await iosRotate.execute("portrait");
        expect(result.success).toBe(true);
        expect(result.rotationPerformed).toBe(false);
        expect(result.error).toBeUndefined();
        expect(result.orientation).toBe("portrait");
        expect(result.currentOrientation).toBe("portrait");
        expect(result.previousOrientation).toBe("portrait");
        expect(result.observation?.viewHierarchy).toEqual({ hierarchy: {} });
        expect(fakeObserveScreen.getExecuteOptions().at(-1)?.freshness).toBe("fresh");
      } finally {
        getInstanceSpy.mockRestore();
      }
    });

    test("should use CtrlProxy to rotate to portrait on iOS", async () => {
      const iosRotate = new Rotate(iosDevice, fakeAdb, fakeTimer);
      (iosRotate as any).observeScreen = fakeObserveScreen;
      (iosRotate as any).window = fakeWindow;
      (iosRotate as any).awaitIdle = fakeAwaitIdle;

      try {
        const result = await iosRotate.execute("portrait");
        expect(result.success).toBe(true);
        expect(result.orientation).toBe("portrait");
        expect(fakeIOSCtrlProxy.getRotateHistory()).toHaveLength(1);
        expect(fakeIOSCtrlProxy.getRotateHistory()[0].orientation).toBe("portrait");
      } finally {
        getInstanceSpy.mockRestore();
      }
    });

    test("should throw when iOS rotate fails", async () => {
      fakeIOSCtrlProxy.setFailureMode("rotate", new Error("Rotation not supported"));
      const iosRotate = new Rotate(iosDevice, fakeAdb, fakeTimer);
      (iosRotate as any).observeScreen = fakeObserveScreen;
      (iosRotate as any).window = fakeWindow;
      (iosRotate as any).awaitIdle = fakeAwaitIdle;

      try {
        await expect(iosRotate.execute("landscape")).rejects.toThrow("Rotation not supported");
      } finally {
        getInstanceSpy.mockRestore();
      }
    });

    test("should not call ADB for iOS rotation", async () => {
      const iosRotate = new Rotate(iosDevice, fakeAdb, fakeTimer);
      (iosRotate as any).observeScreen = fakeObserveScreen;
      (iosRotate as any).window = fakeWindow;
      (iosRotate as any).awaitIdle = fakeAwaitIdle;

      try {
        await iosRotate.execute("landscape");
        expect(fakeAdb.wasCommandExecuted("shell settings get system user_rotation")).toBe(false);
        expect(fakeAdb.wasCommandExecuted("shell settings get system accelerometer_rotation")).toBe(
          false,
        );
      } finally {
        getInstanceSpy.mockRestore();
      }
    });
  });
});

// Run the actual fake-backed feature branch results through the declared contract.
const executeForOutputSchema = Rotate.prototype.execute;
let outputSchemaSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  outputSchemaSpy = spyOn(Rotate.prototype, "execute").mockImplementation(async function (
    this: Rotate,
    ...args: Parameters<Rotate["execute"]>
  ) {
    const result = await executeForOutputSchema.apply(this, args);
    expect(
      rotateResultSchema.parse({ ...result, message: formatRotateMessage(result) }),
    ).toBeDefined();
    const payload = { ...result, message: formatRotateMessage(result) };
    const finalized = finalizeToolResponse(createStructuredToolResponse(payload), {
      name: "rotate",
      outputSchema: rotateResultSchema,
      artifactWriter: new FakeArtifactWriter(),
    });
    expect(rotateResultSchema.parse(finalized.structuredContent)).toBeDefined();
    return result;
  });
});
afterEach(() => outputSchemaSpy.mockRestore());
