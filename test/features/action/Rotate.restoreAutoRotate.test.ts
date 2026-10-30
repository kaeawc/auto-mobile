import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
const accelerometerGet = "shell settings get system accelerometer_rotation";
const accelerometerPut = "shell settings put system accelerometer_rotation ";

describe("Android rotation restores prior auto-rotate", () => {
  afterEach(() => AndroidCtrlProxyClient.resetInstances());

  for (const session of [false, true]) {
    for (const prior of ["1", "0", "unreadable"]) {
      test.each([
        { lockOrientation: undefined, label: "omitted" },
        { lockOrientation: false, label: "false" },
        { lockOrientation: true, label: "true" },
      ])(
        `session=${session}, prior=${prior}, lockOrientation=$label`,
        async ({ lockOrientation }) => {
          const adb = new FakeAdbExecutor();
          const timer = new FakeTimer();
          timer.enableAutoAdvance();
          const idle = new FakeAwaitIdle();
          const observe = new FakeObserveScreen();
          observe.enableAutoVaryHierarchy();
          observe.setObserveResult(() =>
            buildObserveResult({
              updatedAt: timer.now(),
              screenSize: { width: 1080, height: 2400 },
              systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
              viewHierarchy: { hierarchy: { node: {} } },
            }),
          );
          const window = new FakeWindow();
          window.configureCachedActiveWindow(null);
          window.configureActiveWindow({
            appId: "com.test.app",
            activityName: "MainActivity",
            layoutSeqSum: 123,
          });
          let state: RotationRestoreState | undefined;
          let live = portrait;
          let accelerometer = prior;
          adb.setCommandResponse(accelerometerGet, createExecResult(prior));
          adb.setCommandResponse("shell settings get system user_rotation", createExecResult("0"));
          adb.setCommandResponse("shell wm size", createExecResult("Physical size: 1080x2400"));
          const execute = adb.executeCommand.bind(adb);
          spyOn(adb, "executeCommand").mockImplementation(async (command, ...args) => {
            const result = await execute(command, ...args);
            if (command === accelerometerGet && prior === "unreadable") {
              throw new Error("prior auto-rotate read failed");
            }
            if (command.startsWith(accelerometerPut)) {
              accelerometer = command.slice(accelerometerPut.length);
              adb.setCommandResponse(accelerometerGet, createExecResult(accelerometer));
            }
            return command === "shell dumpsys window displays" ? createExecResult(live) : result;
          });
          spyOn(idle, "waitForRotation").mockImplementation(async () => {
            live = landscape;
          });
          const rotate = new Rotate(
            { name: "Test", platform: "android", deviceId: "test", source: "local" },
            {
              adb,
              timer,
              options: session
                ? {
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
                  }
                : undefined,
              collaborators: { awaitIdle: idle, observeScreen: observe, window },
            },
          );
          const execution = rotate.execute("landscape", { lockOrientation });
          if (prior === "unreadable" && session && lockOrientation !== undefined) {
            await expect(execution).rejects.toThrow("accelerometer_rotation could not be read");
            expect(
              adb.getExecutedCommands().filter((command) => command.startsWith(accelerometerPut)),
            ).toEqual([]);
            return;
          }
          const result = await execution;
          const writes = adb
            .getExecutedCommands()
            .filter((command) => command.startsWith(accelerometerPut));
          if (prior === "unreadable") {
            // Omission never guesses an unknown baseline; explicit requests own their state.
            if (lockOrientation === undefined) {
              expect(result.success).toBe(true);
              expect(writes).toEqual([]);
            } else {
              expect(result.success).toBe(false);
              expect(writes).toEqual([
                `${accelerometerPut}0`,
                ...(lockOrientation === false ? [`${accelerometerPut}1`] : []),
              ]);
            }
            return;
          }
          expect(result.success).toBe(true);
          expect(result.currentOrientation).toBe("landscape");
          // Explicit false is the documented unlock: it enables auto-rotate even from a locked prior.
          const expected = lockOrientation === true ? "0" : lockOrientation === false ? "1" : prior;
          expect(accelerometer).toBe(expected);
          expect(writes).toEqual([
            `${accelerometerPut}0`,
            ...(expected === "1" ? [`${accelerometerPut}1`] : []),
          ]);
        },
      );
    }
  }
});
