import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  readWindowManagerRotation,
  WINDOW_MANAGER_ROTATION_COMMAND,
  WINDOW_MANAGER_ROTATION_FALLBACK_COMMAND,
  WINDOW_MANAGER_ROTATION_TIMEOUT_MS,
  WINDOW_MANAGER_ROTATION_MAX_BUFFER,
} from "../../../src/utils/android-cmdline-tools/readWindowManagerRotation";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { createExecResult } from "../../../src/utils/execResult";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";

const WINDOW_DUMPS_DIR = join(__dirname, "..", "..", "features", "observe", "windowDumps");

function fixtureResult(file: string) {
  return createExecResult(readFileSync(join(WINDOW_DUMPS_DIR, file), "utf8"), "");
}

describe("readWindowManagerRotation", () => {
  test.each([
    ["landscape", 1],
    ["portrait", 0],
  ] as const)(
    "reads mirrored %s with bounded, cancellable ADB arguments",
    async (orientation, rotation) => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse(
        "shell dumpsys window displays",
        fixtureResult(`dumpsys-window-displays-mirror-${orientation}.txt`),
      );
      const signal = new AbortController().signal;

      expect(await readWindowManagerRotation(adb, { signal })).toBe(rotation);
      expect(WINDOW_MANAGER_ROTATION_COMMAND).toBe("shell dumpsys window displays");
      expect(WINDOW_MANAGER_ROTATION_TIMEOUT_MS).toBe(5_000);
      expect(WINDOW_MANAGER_ROTATION_MAX_BUFFER).toBe(16 * 1024 * 1024);
      expect(adb.getCommandCalls()).toEqual([
        {
          command: "shell dumpsys window displays",
          timeoutMs: 5_000,
          maxBuffer: 16 * 1024 * 1024,
          noRetry: undefined,
          signal,
          waitForProcessSettlementAfterAbort: undefined,
        },
      ]);
    },
  );

  test.each([undefined, 1234])(
    "uses the default or supplied timeout for primary and fallback (timeoutMs=%s)",
    async (timeoutMs) => {
      const adb = new FakeAdbExecutor();
      adb.setCommandError(WINDOW_MANAGER_ROTATION_COMMAND, new Error("displays unavailable"));
      adb.setCommandResponse(
        WINDOW_MANAGER_ROTATION_FALLBACK_COMMAND,
        fixtureResult("api28-settings-window-dump.log"),
      );

      expect(await readWindowManagerRotation(adb, { timeoutMs })).toBe(3);
      expect(adb.getExecutedCommands()).toEqual([
        WINDOW_MANAGER_ROTATION_COMMAND,
        WINDOW_MANAGER_ROTATION_FALLBACK_COMMAND,
      ]);
      expect(adb.getCommandCalls().map((call) => call.timeoutMs)).toEqual([
        timeoutMs ?? WINDOW_MANAGER_ROTATION_TIMEOUT_MS,
        timeoutMs ?? WINDOW_MANAGER_ROTATION_TIMEOUT_MS,
      ]);
    },
  );

  test("passes an explicitly requested display to the parser", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell dumpsys window displays",
      fixtureResult("dumpsys-window-displays-mirror-landscape.txt"),
    );
    expect(await readWindowManagerRotation(adb, { displayId: 3 })).toBe(0);
    expect(adb.getExecutedCommands()).toEqual([WINDOW_MANAGER_ROTATION_COMMAND]);
  });

  test("returns null when the requested display is absent", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell dumpsys window displays",
      fixtureResult("dumpsys-window-displays-mirror-landscape.txt"),
    );
    expect(await readWindowManagerRotation(adb, { displayId: 99 })).toBeNull();
    expect(adb.getExecutedCommands()).toEqual([WINDOW_MANAGER_ROTATION_COMMAND]);
  });

  test("reads a header-less legacy fixture with exactly one command", async () => {
    const adb = new FakeAdbExecutor();
    const legacy = fixtureResult("api28-settings-window-dump.log");
    expect(legacy.stdout).not.toContain("Display:");
    adb.setCommandResponse(WINDOW_MANAGER_ROTATION_COMMAND, legacy);

    expect(await readWindowManagerRotation(adb)).toBe(3);
    expect(adb.getExecutedCommands()).toEqual([WINDOW_MANAGER_ROTATION_COMMAND]);
  });

  test("reads the API 36 nomirror portrait capture without fallback", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      WINDOW_MANAGER_ROTATION_COMMAND,
      fixtureResult("dumpsys-window-displays-nomirror-portrait.txt"),
    );

    expect(await readWindowManagerRotation(adb)).toBe(0);
    expect(adb.getExecutedCommands()).toEqual([WINDOW_MANAGER_ROTATION_COMMAND]);
  });

  test.each([undefined, 0])(
    "falls back when display 0 rotation is missing (displayId=%s)",
    async (displayId) => {
      const adb = new FakeAdbExecutor();
      const capture = fixtureResult("dumpsys-window-displays-nomirror-landscape.txt");
      const lines = capture.stdout.split("\n");
      // Remove only the captured standalone display 0 mRotation=1 mDeferredRotationPauseCount=0 line.
      const withoutRotation = lines.filter(
        (line) => line.trim() !== "mRotation=1 mDeferredRotationPauseCount=0",
      );
      expect(lines.length - withoutRotation.length).toBe(1);
      adb.setCommandResponse(
        WINDOW_MANAGER_ROTATION_COMMAND,
        createExecResult(withoutRotation.join("\n"), ""),
      );
      adb.setCommandResponse(
        WINDOW_MANAGER_ROTATION_FALLBACK_COMMAND,
        createExecResult("mRotation=1", ""),
      );
      const signal = new AbortController().signal;

      expect(await readWindowManagerRotation(adb, { displayId, signal })).toBe(1);
      expect(WINDOW_MANAGER_ROTATION_FALLBACK_COMMAND).toBe(
        'shell dumpsys window | grep -i "mRotation="',
      );
      expect(adb.getExecutedCommands()).toEqual([
        WINDOW_MANAGER_ROTATION_COMMAND,
        WINDOW_MANAGER_ROTATION_FALLBACK_COMMAND,
      ]);
      expect(adb.getCommandCalls()).toEqual(
        [WINDOW_MANAGER_ROTATION_COMMAND, WINDOW_MANAGER_ROTATION_FALLBACK_COMMAND].map(
          (command) => ({
            command,
            timeoutMs: 5_000,
            maxBuffer: 16 * 1024 * 1024,
            noRetry: undefined,
            signal,
            waitForProcessSettlementAfterAbort: undefined,
          }),
        ),
      );
    },
  );

  test.each([undefined, 0])(
    "falls back on a non-abort displays error (displayId=%s)",
    async (displayId) => {
      const adb = new FakeAdbExecutor();
      adb.setCommandError(WINDOW_MANAGER_ROTATION_COMMAND, new Error("displays unavailable"));
      adb.setCommandResponse(
        WINDOW_MANAGER_ROTATION_FALLBACK_COMMAND,
        createExecResult("mRotation=3", ""),
      );

      expect(await readWindowManagerRotation(adb, { displayId })).toBe(3);
      expect(adb.getExecutedCommands()).toEqual([
        WINDOW_MANAGER_ROTATION_COMMAND,
        WINDOW_MANAGER_ROTATION_FALLBACK_COMMAND,
      ]);
    },
  );

  test("rethrows a non-default display command error without fallback", async () => {
    const adb = new FakeAdbExecutor();
    const error = new Error("displays unavailable");
    adb.setCommandError(WINDOW_MANAGER_ROTATION_COMMAND, error);

    await expect(readWindowManagerRotation(adb, { displayId: 99 })).rejects.toBe(error);
    expect(adb.getExecutedCommands()).toEqual([WINDOW_MANAGER_ROTATION_COMMAND]);
  });

  test("propagates the fallback command error", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError(WINDOW_MANAGER_ROTATION_COMMAND, new Error("displays unavailable"));
    const error = new Error("grep read failed");
    adb.setCommandError(WINDOW_MANAGER_ROTATION_FALLBACK_COMMAND, error);

    await expect(readWindowManagerRotation(adb)).rejects.toBe(error);
    expect(adb.getExecutedCommands()).toEqual([
      WINDOW_MANAGER_ROTATION_COMMAND,
      WINDOW_MANAGER_ROTATION_FALLBACK_COMMAND,
    ]);
  });

  test("propagates AbortError without a signal or fallback", async () => {
    const adb = new FakeAdbExecutor();
    const error = new DOMException("rotation read aborted", "AbortError");
    adb.setCommandError(WINDOW_MANAGER_ROTATION_COMMAND, error);

    await expect(readWindowManagerRotation(adb)).rejects.toBe(error);
    expect(adb.getExecutedCommands()).toEqual([WINDOW_MANAGER_ROTATION_COMMAND]);
  });

  test("preserves the displays rejection for an already-aborted signal without fallback", async () => {
    const adb = new FakeAdbExecutor();
    const controller = new AbortController();
    const error = new Error("rotation read cancelled");
    controller.abort(error);
    adb.setCommandError(WINDOW_MANAGER_ROTATION_COMMAND, error);

    await expect(readWindowManagerRotation(adb, { signal: controller.signal })).rejects.toBe(error);
    expect(adb.getExecutedCommands()).toEqual([WINDOW_MANAGER_ROTATION_COMMAND]);
  });

  test("rethrows an ordinary displays error when the signal is aborted", async () => {
    const adb = new FakeAdbExecutor();
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    const error = new Error("read rejected after cancellation");
    adb.setCommandError(WINDOW_MANAGER_ROTATION_COMMAND, error);

    await expect(readWindowManagerRotation(adb, { signal: controller.signal })).rejects.toBe(error);
    expect(adb.getExecutedCommands()).toEqual([WINDOW_MANAGER_ROTATION_COMMAND]);
  });

  test("does not dispatch fallback when cancellation follows an unparseable read", async () => {
    const adb = new FakeAdbExecutor();
    const controller = new AbortController();
    adb.abortAfterCommand(WINDOW_MANAGER_ROTATION_COMMAND, controller);

    await expect(readWindowManagerRotation(adb, { signal: controller.signal })).rejects.toThrow(
      OPERATION_CANCELLED_MESSAGE,
    );
    expect(adb.getExecutedCommands()).toEqual([WINDOW_MANAGER_ROTATION_COMMAND]);
  });
});
