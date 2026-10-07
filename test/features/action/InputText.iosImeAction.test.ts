import { typedObservation } from "./IosTypedTextTestHarness";
import { runWithTextRequestContext } from "../../../src/features/action/textTransportTimeout";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { InputText } from "../../../src/features/action/InputText";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import type { BootedDevice, SendTextResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";

describe("InputText iOS IME action", () => {
  const iosDevice: BootedDevice = {
    deviceId: "ios-ime-test-device",
    platform: "ios",
    name: "Test iPhone",
  };
  let inputText: InputText;
  let fakeAdb: FakeAdbExecutor;
  let fakeIosCtrlProxy: FakeIOSCtrlProxy;
  let fakeTimer: FakeTimer;
  let iosGetInstanceSpy: ReturnType<typeof spyOn>;
  let androidGetInstanceSpy: ReturnType<typeof spyOn> | undefined;
  let imeActionSpy: ReturnType<typeof spyOn>;

  const createInputText = (device: BootedDevice): InputText => {
    const action = new InputText(device, fakeAdb, undefined, fakeTimer);
    const fakeObserveScreen = new FakeObserveScreen();
    fakeObserveScreen.enableAutoVaryHierarchy();
    fakeObserveScreen.setObserveResult(() =>
      typedObservation(fakeIosCtrlProxy.getTextInputHistory().at(-1)?.text ?? ""),
    );
    const fakeWindow = new FakeWindow();
    fakeWindow.configureCachedActiveWindow(null);
    fakeWindow.configureActiveWindow({
      appId: "com.test.app",
      activityName: "MainActivity",
      layoutSeqSum: 1,
    });
    const seams = action as unknown as {
      observeScreen: FakeObserveScreen;
      window: FakeWindow;
      awaitIdle: FakeAwaitIdle;
    };
    seams.observeScreen = fakeObserveScreen;
    seams.window = fakeWindow;
    seams.awaitIdle = new FakeAwaitIdle();
    return action;
  };

  beforeEach(() => {
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    fakeAdb = new FakeAdbExecutor();
    fakeAdb.setAndroidApiLevel(34);
    fakeIosCtrlProxy = new FakeIOSCtrlProxy(fakeTimer);
    iosGetInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      fakeIosCtrlProxy as unknown as IOSCtrlProxyClient,
    );
    imeActionSpy = spyOn(fakeIosCtrlProxy, "requestImeAction");
    inputText = createInputText(iosDevice);
  });

  afterEach(() => {
    imeActionSpy.mockRestore();
    iosGetInstanceSpy.mockRestore();
    androidGetInstanceSpy?.mockRestore();
    androidGetInstanceSpy = undefined;
    AndroidCtrlProxyClient.resetInstances();
  });

  test.each([
    ["unchanged", "old", false, undefined],
    ["mask", "(123) 456", true, undefined],
    ["truncated", "123", true, '\"123\"'],
    ["unreadable", undefined, true, "not verified"],
    ["secure", "secret", true, "skipped"],
  ] as const)("iOS InputText verification: %s", async (name, after, success, warning) => {
    const observation =
      name === "secure" ? typedObservation("secret", true) : typedObservation("old");
    inputText.observeScreen = new FakeObserveScreen();
    const execute = spyOn(inputText.observeScreen, "execute").mockImplementation(async () => {
      const delivered = fakeIosCtrlProxy.getTextInputHistory().length > 0;
      if (!delivered || name === "secure") {
        return observation;
      }
      if (after === undefined) {
        throw new Error("Unavailable hierarchy");
      }
      return typedObservation(after);
    });
    try {
      const result = await (
        inputText as unknown as {
          executeiOSTextInput(text: string): Promise<SendTextResult>;
        }
      ).executeiOSTextInput("123456");
      expect(result.success).toBe(success);
      if (!success) {
        expect(result.error).toContain("nothing was typed");
      }
      if (warning) {
        expect(result.warnings?.join(" ")).toContain(warning);
      } else {
        expect(result.warnings).toBeUndefined();
      }
      if (name === "secure") {
        expect(JSON.stringify(result)).not.toContain("secret");
      }
    } finally {
      execute.mockRestore();
    }
  });

  test("carries the requested action on success without warnings", async () => {
    const result = await inputText.execute("hello", "next");

    expect(result).toMatchObject({
      success: true,
      text: "hello",
      imeAction: "next",
      method: "a11y",
    });
    expect(result.error).toBeUndefined();
    expect(result.warnings).toBeUndefined();
    expect(fakeIosCtrlProxy.getImeActionHistory()).toEqual([{ action: "next" }]);
  });

  test("reports a failed runner action after typing without inviting a retype", async () => {
    fakeIosCtrlProxy.setFailureMode("imeAction", new Error("no focused field"));

    const result = await inputText.execute("hello", "next");

    expect(result).toMatchObject({ success: false, text: "hello", method: "a11y" });
    expect(result.error).toBe(
      "IME action 'next' failed after the text was entered: no focused field. Do not retype the text.",
    );
    expect(result.imeAction).toBeUndefined();
    expect(result.warnings).toBeUndefined();
    expect(fakeIosCtrlProxy.getTextInputHistory()).toEqual([
      { text: "hello", resourceId: undefined },
    ]);
    expect(imeActionSpy).toHaveBeenCalledWith("next");
  });

  test("uses a stable fallback when the runner omits its error", async () => {
    imeActionSpy.mockResolvedValue({ success: false, action: "done", totalTimeMs: 0 });

    const result = await inputText.execute("hello", "done");

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "IME action 'done' failed after the text was entered: unknown error. Do not retype the text.",
    );
  });

  test("reports a thrown transport error as an IME failure after typing", async () => {
    imeActionSpy.mockRejectedValue(new Error("runner disconnected"));

    const result = await inputText.execute("hello", "done");

    expect(result).toMatchObject({ success: false, text: "hello", method: "a11y" });
    expect(result.error).toBe(
      "IME action 'done' failed after the text was entered: runner disconnected. Do not retype the text.",
    );
    expect(result.imeAction).toBeUndefined();
    expect(result.warnings).toBeUndefined();
  });

  test("leaves text-only input unchanged and never requests an action", async () => {
    const result = await inputText.execute("hello");

    expect(result).toMatchObject({ success: true, text: "hello", method: "a11y" });
    expect(result.imeAction).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.warnings).toBeUndefined();
    expect(imeActionSpy).not.toHaveBeenCalled();
    expect(fakeIosCtrlProxy.getTextInputHistory()).toEqual([
      { text: "hello", resourceId: undefined },
    ]);
  });

  test.each([5, 1000])(
    "passes scaled text timeout and caller signal for length %s",
    async (length) => {
      const setText = spyOn(fakeIosCtrlProxy, "requestSetText");
      const controller = new AbortController();
      try {
        expect(
          (
            await inputText.execute(
              "a".repeat(length),
              undefined,
              false,
              undefined,
              controller.signal,
            )
          ).success,
        ).toBe(true);
        expect(setText.mock.calls[0][1]).toEqual({
          timeoutMs: length === 5 ? 5000 : 102000,
          abortSignal: controller.signal,
        });
      } finally {
        setText.mockRestore();
      }
    },
  );

  test("iOS input forwards the remaining request deadline", async () => {
    const setText = spyOn(fakeIosCtrlProxy, "requestSetText");
    const deadline = fakeTimer.now() + 4000;
    try {
      await runWithTextRequestContext({ getDeadlineMs: () => deadline }, () =>
        inputText.execute("a".repeat(1000)),
      );
      expect(setText.mock.calls[0][1]).toMatchObject({
        timeoutMs: 3000,
        deadlineMs: deadline - 1000,
      });
    } finally {
      setText.mockRestore();
    }
  });

  test.each([false, true])(
    "preserves indeterminate text guidance after cancellation=%s",
    async (cancelled) => {
      const error =
        "Text outcome is indeterminate: the text may have been entered. Do not retry automatically. Observe before retrying.";
      const controller = new AbortController();
      const setText = spyOn(fakeIosCtrlProxy, "requestSetText").mockImplementation(async () => {
        if (cancelled) {
          controller.abort(new Error("Request timed out after 30000ms"));
        }
        return { success: false, totalTimeMs: 5000, retryable: false, error };
      });
      try {
        const result = await inputText.execute(
          "hello",
          "done",
          false,
          undefined,
          controller.signal,
        );
        expect(result).toMatchObject({ success: false, error, retryable: false });
        expect(setText).toHaveBeenCalledTimes(1);
        expect(imeActionSpy).not.toHaveBeenCalled();
      } finally {
        setText.mockRestore();
      }
    },
  );

  for (const throws of [false, true]) {
    test(`abort wins over an IME ${throws ? "exception" : "failed reply"}`, async () => {
      const controller = new AbortController();
      const abortError = new DOMException("input cancelled", "AbortError");
      imeActionSpy.mockImplementation(async () => {
        controller.abort(abortError);
        if (throws) {
          throw new Error("runner disconnected");
        }
        return { success: false, action: "next", error: "no focused field", totalTimeMs: 0 };
      });

      await expect(
        inputText.execute("hello", "next", false, undefined, controller.signal),
      ).rejects.toBe(abortError);
      expect(fakeIosCtrlProxy.getTextInputHistory()).toEqual([
        { text: "hello", resourceId: undefined },
      ]);
    });
  }

  test("Android also reports failure when text lands but the action fails", async () => {
    const fakeCtrlProxy = new FakeCtrlProxy();
    androidGetInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      fakeCtrlProxy as unknown as AndroidCtrlProxyClient,
    );
    fakeAdb.setCommandError("shell input keyevent KEYCODE_TAB", new Error("key event failed"));
    const androidInputText = createInputText({ ...iosDevice, platform: "android" });

    const result = await androidInputText.execute("hello", "next", false, "a11y");

    expect(result).toMatchObject({
      success: false,
      text: "hello",
      method: "a11y",
      error: "Failed to send text input: key event failed",
    });
    expect(result.imeAction).toBeUndefined();
    expect(fakeCtrlProxy.getTextInputHistory()).toEqual([{ text: "hello", resourceId: undefined }]);
  });
});
