import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  ClearText,
  clearTextWithKeyEvents,
  DELETE_KEYEVENT_CHUNK_SIZE,
} from "../../../src/features/action/ClearText";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { BootedDevice, ObserveResult } from "../../../src/models";

const deleteCommand = (count: number): string =>
  `shell input keyevent ${Array<string>(count).fill("KEYCODE_DEL").join(" ")}`;

const deleteCommands = (count: number): string[] => {
  const commands: string[] = [];
  for (let remaining = count; remaining > 0; remaining -= DELETE_KEYEVENT_CHUNK_SIZE) {
    commands.push(deleteCommand(Math.min(remaining, DELETE_KEYEVENT_CHUNK_SIZE)));
  }
  return commands;
};

describe("clearTextWithKeyEvents", () => {
  test.each([7, DELETE_KEYEVENT_CHUNK_SIZE, DELETE_KEYEVENT_CHUNK_SIZE + 1])(
    "batches %i deletes into exact chunks",
    async (count) => {
      const adb = new FakeAdbExecutor();

      await clearTextWithKeyEvents(adb, count);

      expect(adb.getExecutedCommands()).toEqual([
        "shell input keyevent KEYCODE_MOVE_END",
        ...deleteCommands(count),
      ]);
      expect(deleteCommands(count)).toHaveLength(Math.ceil(count / DELETE_KEYEVENT_CHUNK_SIZE));
    },
  );

  test("uses exact Ctrl+End before batched deletes when supported", async () => {
    const adb = new FakeAdbExecutor();
    await clearTextWithKeyEvents(adb, 51, undefined, undefined, true);
    expect(adb.getExecutedCommands()).toEqual([
      "shell input keycombination KEYCODE_CTRL_LEFT KEYCODE_MOVE_END",
      ...deleteCommands(51),
    ]);
  });

  test("keeps MOVE_END as the only call for zero or negative counts", async () => {
    const adb = new FakeAdbExecutor();

    await clearTextWithKeyEvents(adb, 0);
    await clearTextWithKeyEvents(adb, -1);

    expect(adb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_MOVE_END",
      "shell input keyevent KEYCODE_MOVE_END",
    ]);
  });

  test("stops between chunks when aborted and reports the completed chunk", async () => {
    const adb = new FakeAdbExecutor();
    const controller = new AbortController();
    const executeCommand = adb.executeCommand.bind(adb);
    const completedChunks: number[] = [];
    adb.executeCommand = async (command, ...options) => {
      const result = await executeCommand(command, ...options);
      if (command !== "shell input keyevent KEYCODE_MOVE_END") {
        controller.abort();
      }
      return result;
    };

    await expect(
      clearTextWithKeyEvents(adb, DELETE_KEYEVENT_CHUNK_SIZE + 1, controller.signal, () => {
        completedChunks.push(1);
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(adb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_MOVE_END",
      deleteCommand(DELETE_KEYEVENT_CHUNK_SIZE),
    ]);
    expect(completedChunks).toHaveLength(1);
  });

  test("makes no calls when the signal is already aborted", async () => {
    const adb = new FakeAdbExecutor();
    const controller = new AbortController();
    controller.abort();

    await expect(clearTextWithKeyEvents(adb, 1, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("calls onDelete once after each successfully completed chunk", async () => {
    const adb = new FakeAdbExecutor();
    let completedChunks = 0;

    await clearTextWithKeyEvents(
      adb,
      DELETE_KEYEVENT_CHUNK_SIZE * 2 + 1,
      undefined,
      () => completedChunks++,
    );

    expect(completedChunks).toBe(3);
  });
});

describe("ClearText Android ADB fallback", () => {
  const device: BootedDevice = {
    deviceId: "test-device",
    platform: "android",
    name: "Test Device",
  };

  let fakeAdb: FakeAdbExecutor;
  let fakeA11yService: FakeCtrlProxy;
  let getInstanceSpy: ReturnType<typeof spyOn> | null = null;
  let observedSpy: ReturnType<typeof spyOn> | null = null;
  let refreshSpy: ReturnType<typeof spyOn> | null = null;

  const focusedFieldObserve = (text: string): ObserveResult => ({
    timestamp: 0,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    viewHierarchy: {
      hierarchy: {
        node: {
          $: {
            focused: "true",
            text: text,
            class: "android.widget.EditText",
          },
        },
      },
    },
  });

  const noHierarchyObserve = (): ObserveResult => ({
    timestamp: 0,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  });

  const noFocusedFieldObserve = (): ObserveResult => ({
    timestamp: 0,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    viewHierarchy: {
      updatedAt: 100,
      hierarchy: {
        node: {
          $: {
            class: "android.widget.TextView",
            focused: "false",
            text: "Home",
          },
        },
      },
    },
  });

  const hierarchyErrorObserve = (): ObserveResult => ({
    timestamp: 0,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    viewHierarchy: {
      hierarchy: { error: "Accessibility hierarchy unavailable" },
    } as any,
  });

  const runClearText = (
    observeResult: ObserveResult,
    configure?: (clearText: ClearText) => void,
    signal?: AbortSignal,
  ) => {
    const clearText = new ClearText(device, fakeAdb as any, undefined, new FakeTimer());
    observedSpy = spyOn(
      clearText as unknown as {
        observedInteraction: (fn: (o: ObserveResult) => Promise<unknown>) => Promise<unknown>;
      },
      "observedInteraction",
    ).mockImplementation(async (fn: (o: ObserveResult) => Promise<unknown>) => fn(observeResult));
    refreshSpy = spyOn(clearText.observeScreen, "execute").mockResolvedValue(
      focusedFieldObserve(""),
    );
    configure?.(clearText);
    return clearText.execute(undefined, signal);
  };

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
    fakeAdb.setAndroidApiLevel(30);
    fakeA11yService = new FakeCtrlProxy();
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      fakeA11yService as unknown as AndroidCtrlProxyClient,
    );
  });

  afterEach(() => {
    getInstanceSpy?.mockRestore();
    observedSpy?.mockRestore();
    refreshSpy?.mockRestore();
    getInstanceSpy = null;
    observedSpy = null;
    refreshSpy = null;
  });

  test.each([31, 34, 30, null])(
    "resolves API %s once across repeated clears before exact key events",
    async (apiLevel) => {
      fakeAdb.setAndroidApiLevel(apiLevel);
      fakeA11yService.setClearTextResult({ success: false, totalTimeMs: 0, error: "unavailable" });
      const controller = new AbortController();
      let instance: ClearText | undefined;
      const result = await runClearText(
        focusedFieldObserve("x".repeat(51)),
        (clearText) => {
          instance = clearText;
        },
        controller.signal,
      );
      expect(result.success).toBe(true);
      expect((await instance!.execute(undefined, controller.signal)).success).toBe(true);
      const move =
        apiLevel !== null && apiLevel >= 31
          ? "shell input keycombination KEYCODE_CTRL_LEFT KEYCODE_MOVE_END"
          : "shell input keyevent KEYCODE_MOVE_END";
      expect(fakeAdb.getExecutedCommands()).toEqual([
        ...(apiLevel === null ? ["shell getprop ro.build.version.sdk"] : []),
        move,
        ...deleteCommands(51),
        move,
        ...deleteCommands(51),
      ]);
      expect(fakeAdb.getApiLevelCalls()).toEqual([{ timeoutMs: 1000, signal: undefined }]);
    },
  );

  test("first caller abort does not cancel a concurrent clear's shared capability probe", async () => {
    fakeAdb.setAndroidApiLevel(34);
    fakeA11yService.setClearTextResult({ success: false, totalTimeMs: 0, error: "unavailable" });
    let releaseProbe!: () => void;
    const probePending = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let probeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    const readApiLevel = fakeAdb.getAndroidApiLevel.bind(fakeAdb);
    fakeAdb.getAndroidApiLevel = async (...options) => {
      const level = await readApiLevel(...options);
      probeStarted();
      await probePending;
      return level;
    };
    const controller = new AbortController();
    let instance!: ClearText;
    const first = runClearText(
      focusedFieldObserve("old"),
      (clearText) => {
        instance = clearText;
      },
      controller.signal,
    );
    const second = Promise.allSettled([instance.execute(undefined, new AbortController().signal)]);
    await started;
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
    releaseProbe();
    expect(await second).toMatchObject([{ status: "fulfilled", value: { success: true } }]);
    expect(fakeAdb.getApiLevelCalls()).toEqual([{ timeoutMs: 1000, signal: undefined }]);
    expect(fakeAdb.getExecutedCommands()).toEqual([
      "shell input keycombination KEYCODE_CTRL_LEFT KEYCODE_MOVE_END",
      deleteCommand(3),
    ]);
  });

  test("falls back after a failed bounded API read before clearing", async () => {
    fakeAdb.setAndroidApiLevel(null);
    fakeAdb.setCommandError("shell getprop ro.build.version.sdk", new Error("disconnected"));
    fakeA11yService.setClearTextResult({ success: false, totalTimeMs: 0, error: "unavailable" });
    expect((await runClearText(focusedFieldObserve("old"))).success).toBe(true);
    expect(fakeAdb.getExecutedCommands()).toEqual([
      "shell getprop ro.build.version.sdk",
      "shell input keyevent KEYCODE_MOVE_END",
      deleteCommand(3),
    ]);
    expect(fakeAdb.getApiLevelCalls()).toEqual([{ timeoutMs: 1000, signal: undefined }]);
  });

  test("cancels capability discovery before any caret or delete event", async () => {
    const controller = new AbortController();
    fakeAdb.abortAfterApiLevel(controller);
    fakeA11yService.setClearTextResult({ success: false, totalTimeMs: 0, error: "unavailable" });
    let instance: ClearText | undefined;
    await expect(
      runClearText(
        focusedFieldObserve("old"),
        (clearText) => {
          instance = clearText;
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
    expect(fakeAdb.getApiLevelCalls()).toEqual([{ timeoutMs: 1000, signal: undefined }]);
    expect((await instance!.execute()).success).toBe(true);
    expect(fakeAdb.getApiLevelCalls()).toHaveLength(1);
  });

  test("clears via the accessibility service and never touches ADB when a11y succeeds", async () => {
    // Default FakeCtrlProxy.requestClearText returns success.
    const result = await runClearText(focusedFieldObserve("hello"));

    expect(result.success).toBe(true);
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });

  test("propagates an abort during the accessibility clear", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel clear");
    const clearSpy = spyOn(fakeA11yService, "requestClearText").mockImplementation(async () => {
      controller.abort(reason);
      return { success: true, totalTimeMs: 0 };
    });
    try {
      await expect(
        runClearText(focusedFieldObserve("hello"), undefined, controller.signal),
      ).rejects.toBe(reason);
      expect(fakeAdb.getExecutedCommands()).toEqual([]);
    } finally {
      clearSpy.mockRestore();
    }
  });

  test("stops ADB deletes as soon as the signal aborts", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel deletes");
    await expect(
      clearTextWithKeyEvents(fakeAdb, 20, controller.signal, () => controller.abort(reason)),
    ).rejects.toBe(reason);
    expect(fakeAdb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_MOVE_END",
      deleteCommand(20),
    ]);
  });

  test("rejects an accessibility success when no editable field remains focused after refresh", async () => {
    const result = await runClearText(noFocusedFieldObserve(), (clearText) => {
      refreshSpy = spyOn(clearText.observeScreen, "execute").mockResolvedValue(
        noFocusedFieldObserve(),
      );
    });

    expect(result).toEqual({
      success: false,
      error: "No focused editable node found",
    });
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });

  test("uses a refreshed focused field before accepting accessibility success", async () => {
    const result = await runClearText(noFocusedFieldObserve(), (clearText) => {
      refreshSpy = spyOn(clearText.observeScreen, "execute").mockResolvedValue(
        focusedFieldObserve("hello"),
      );
    });

    expect(result.success).toBe(true);
    expect(refreshSpy).toHaveBeenCalledWith({
      freshness: "fresh",
      minTimestamp: 101,
    });
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });

  test("uses the refreshed focused field for the ADB fallback when a11y clear fails", async () => {
    fakeA11yService.setClearTextResult({
      success: false,
      totalTimeMs: 0,
      error: "no focused node",
    });

    const result = await runClearText(noFocusedFieldObserve(), (clearText) => {
      refreshSpy = spyOn(clearText.observeScreen, "execute")
        .mockResolvedValue(focusedFieldObserve(""))
        .mockResolvedValueOnce(focusedFieldObserve("hello"));
    });

    expect(result.success).toBe(true);
    expect(fakeAdb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_MOVE_END",
      deleteCommand(5),
    ]);
  });

  test("does not treat a stale refreshed hierarchy as proof that no field is focused", async () => {
    const staleNoFocusObserve = {
      ...noFocusedFieldObserve(),
      freshness: { isFresh: false },
    };
    const result = await runClearText(noFocusedFieldObserve(), (clearText) => {
      refreshSpy = spyOn(clearText.observeScreen, "execute").mockResolvedValue(staleNoFocusObserve);
    });

    expect(result.success).toBe(true);
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });

  test.each([noHierarchyObserve(), hierarchyErrorObserve()])(
    "preserves live clearing when the refreshed hierarchy is unavailable: %j",
    async (refreshed) => {
      const result = await runClearText(noFocusedFieldObserve(), (clearText) => {
        refreshSpy = spyOn(clearText.observeScreen, "execute").mockResolvedValue(refreshed);
      });
      expect(result.success).toBe(true);
      expect(fakeAdb.getExecutedCommands()).toEqual([]);
    },
  );

  test("preserves live clearing when only a host timestamp is available", async () => {
    const observation = noFocusedFieldObserve();
    delete observation.viewHierarchy!.updatedAt;
    fakeAdb.setDeviceTimestampSource("host");
    const result = await runClearText(observation);
    expect(result.success).toBe(true);
  });

  test("preserves live clearing when the refresh throws", async () => {
    const result = await runClearText(noFocusedFieldObserve(), (clearText) => {
      refreshSpy = spyOn(clearText.observeScreen, "execute").mockRejectedValue(
        new Error("disconnected"),
      );
    });
    expect(result.success).toBe(true);
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });

  test("uses the unavailable-hierarchy fallback after an inconclusive refresh", async () => {
    fakeA11yService.setClearTextResult({ success: false, totalTimeMs: 0, error: "unavailable" });
    const result = await runClearText(noFocusedFieldObserve(), (clearText) => {
      refreshSpy = spyOn(clearText.observeScreen, "execute").mockResolvedValue(
        noHierarchyObserve(),
      );
    });
    expect(result.success).toBe(false);
    expect(fakeAdb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_MOVE_END",
      ...deleteCommands(200),
    ]);
  });

  test("preserves the accessibility path when the hierarchy contains an error", async () => {
    const result = await runClearText(hierarchyErrorObserve());

    expect(result.success).toBe(true);
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });

  test("falls back to ADB deletes sized to the focused field when a11y clear fails", async () => {
    fakeA11yService.setClearTextResult({
      success: false,
      totalTimeMs: 0,
      error: "no focused node",
    });

    const result = await runClearText(focusedFieldObserve("hello"));

    expect(result.success).toBe(true);
    // MOVE_END once, then one batched command containing five DEL events.
    expect(fakeAdb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_MOVE_END",
      deleteCommand(5),
    ]);
  });

  test.each([
    { after: "later\nlines", success: false },
    { after: "", success: true },
    { after: undefined, success: false },
  ])("verifies the focused field after ADB deletes: %j", async ({ after, success }) => {
    fakeAdb.setAndroidApiLevel(34);
    fakeA11yService.setClearTextResult({ success: false, totalTimeMs: 0, error: "unavailable" });
    const result = await runClearText(focusedFieldObserve("first\nlater\nlines"), (clearText) => {
      refreshSpy = spyOn(clearText.observeScreen, "execute").mockResolvedValue(
        after === undefined ? noHierarchyObserve() : focusedFieldObserve(after),
      );
    });
    expect(result.success).toBe(success);
    if (after !== undefined && !success) {
      expect(result.error).toContain("not fully cleared");
      expect(result.error).toContain("11 UTF-16 units remain");
    }
    if (after === undefined) {
      expect(result.error).toContain("Cannot verify");
    }
    expect(fakeAdb.getExecutedCommands()).toEqual([
      "shell input keycombination KEYCODE_CTRL_LEFT KEYCODE_MOVE_END",
      deleteCommand(17),
    ]);
  });

  test.each(["stale", "unreadable", "unfocused", "errored", "throws"] as const)(
    "refuses success when post-clear verification is %s",
    async (unavailable) => {
      fakeA11yService.setClearTextResult({ success: false, totalTimeMs: 0, error: "unavailable" });
      const result = await runClearText(focusedFieldObserve("hello"), (clearText) => {
        const observation = focusedFieldObserve("");
        if (unavailable === "stale") {
          observation.freshness = { isFresh: false };
        } else if (unavailable === "unreadable") {
          delete observation.viewHierarchy!.hierarchy.node!.$!.text;
        }
        refreshSpy = spyOn(clearText.observeScreen, "execute");
        if (unavailable === "throws") {
          refreshSpy.mockRejectedValue(new Error("capture unavailable"));
        } else {
          refreshSpy.mockResolvedValue(
            unavailable === "unfocused"
              ? noFocusedFieldObserve()
              : unavailable === "errored"
                ? hierarchyErrorObserve()
                : observation,
          );
        }
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot verify key-event clear");
    },
  );

  test("propagates cancellation during the post-clear observation", async () => {
    fakeA11yService.setClearTextResult({ success: false, totalTimeMs: 0, error: "unavailable" });
    const controller = new AbortController();
    const reason = new Error("cancelled verification");
    await expect(
      runClearText(
        focusedFieldObserve("hello"),
        (clearText) => {
          refreshSpy = spyOn(clearText.observeScreen, "execute").mockImplementation(async () => {
            controller.abort(reason);
            return focusedFieldObserve("");
          });
        },
        controller.signal,
      ),
    ).rejects.toBe(reason);
  });

  test("issues no key events when the focused field is already empty", async () => {
    fakeA11yService.setClearTextResult({
      success: false,
      totalTimeMs: 0,
      error: "no focused node",
    });

    const result = await runClearText(focusedFieldObserve(""));

    expect(result.success).toBe(true);
    // A zero-length field must not spam MOVE_END/DEL key events.
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });

  test("issues no key events when the focused field is already empty and showing its hint", async () => {
    fakeA11yService.setClearTextResult({ success: false, totalTimeMs: 0, error: "unavailable" });
    const observation = focusedFieldObserve("Type here");
    observation.viewHierarchy!.hierarchy.node!.$!["hint-text"] = "Type here";

    expect(await runClearText(observation)).toEqual({ success: true });
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  test("uses the 200-delete default when no view hierarchy is available", async () => {
    fakeA11yService.setClearTextResult({
      success: false,
      totalTimeMs: 0,
      error: "no focused node",
    });

    const result = await runClearText(noHierarchyObserve());

    expect(result.success).toBe(true);
    const commands = fakeAdb.getExecutedCommands();
    expect(commands[0]).toBe("shell input keyevent KEYCODE_MOVE_END");
    expect(commands).toEqual(["shell input keyevent KEYCODE_MOVE_END", ...deleteCommands(200)]);
  });

  test("uses the 200-delete fallback when the hierarchy is errored", async () => {
    fakeA11yService.setClearTextResult({ success: false, totalTimeMs: 0, error: "unavailable" });
    const result = await runClearText(hierarchyErrorObserve());

    expect(result.success).toBe(true);
    expect(fakeAdb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_MOVE_END",
      ...deleteCommands(200),
    ]);
  });
  test("unsupported platform result includes the platform name", async () => {
    const unsupportedDevice = { ...device, platform: "tvos" } as unknown as BootedDevice;
    const clearText = new ClearText(unsupportedDevice, fakeAdb as any);
    observedSpy = spyOn(
      clearText as unknown as {
        observedInteraction: (fn: (o: ObserveResult) => Promise<unknown>) => Promise<unknown>;
      },
      "observedInteraction",
    ).mockImplementation(async (fn: (o: ObserveResult) => Promise<unknown>) =>
      fn(noHierarchyObserve()),
    );

    const result = await clearText.execute();
    expect(result.success).toBe(false);
    expect(result.error).toContain("tvos");
    expect(result.error).not.toBe("Failed to clear text");
  });
});
