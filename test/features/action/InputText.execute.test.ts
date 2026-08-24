import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { InputText } from "../../../src/features/action/InputText";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeTimer } from "../../fakes/FakeTimer";
import { serverConfig } from "../../../src/utils/ServerConfig";
import type { BootedDevice, ObserveResult } from "../../../src/models";

describe("InputText.execute", () => {
  const androidDevice: BootedDevice = {
    deviceId: "test-device",
    platform: "android",
    name: "Test Device",
  };
  const iosDevice: BootedDevice = {
    deviceId: "ios-test-device",
    platform: "ios",
    name: "Test iPhone",
  };

  let fakeAdb: FakeAdbExecutor;
  let fakeObserveScreen: FakeObserveScreen;
  let fakeWindow: FakeWindow;
  let fakeAwaitIdle: FakeAwaitIdle;
  let fakeA11yService: FakeCtrlProxy;
  let fakeIosCtrlProxy: FakeIOSCtrlProxy;
  let fakeTimer: FakeTimer;
  let getInstanceSpy: ReturnType<typeof spyOn> | null = null;
  let iosGetInstanceSpy: ReturnType<typeof spyOn> | null = null;
  let savedMarkers: readonly string[];

  const createObserveResult = (): ObserveResult => ({
    timestamp: Date.now(),
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: { hierarchy: { node: { $: {} } } },
  });

  const wireFakes = (inputText: InputText): void => {
    (inputText as any).observeScreen = fakeObserveScreen;
    (inputText as any).window = fakeWindow;
    (inputText as any).awaitIdle = fakeAwaitIdle;
    (inputText as any).timer = fakeTimer;
  };

  beforeEach(() => {
    savedMarkers = serverConfig.getEventAllMarkers();
    fakeAdb = new FakeAdbExecutor();
    fakeAdb.setAndroidApiLevel(34);
    fakeObserveScreen = new FakeObserveScreen();
    fakeObserveScreen.enableAutoVaryHierarchy();
    fakeObserveScreen.setObserveResult(() => createObserveResult());
    fakeWindow = new FakeWindow();
    fakeWindow.configureCachedActiveWindow(null);
    fakeWindow.configureActiveWindow({
      appId: "com.test.app",
      activityName: "MainActivity",
      layoutSeqSum: 1,
    });
    fakeAwaitIdle = new FakeAwaitIdle();
    fakeA11yService = new FakeCtrlProxy();
    fakeIosCtrlProxy = new FakeIOSCtrlProxy();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
  });

  afterEach(() => {
    serverConfig.setEventAllMarkers(savedMarkers);
    getInstanceSpy?.mockRestore();
    iosGetInstanceSpy?.mockRestore();
    getInstanceSpy = null;
    iosGetInstanceSpy = null;
  });

  test("returns a no-text failure without invoking any transport when text is undefined", async () => {
    const inputText = new InputText(androidDevice, fakeAdb as any);
    wireFakes(inputText);

    const result = await inputText.execute(undefined as any);

    expect(result).toMatchObject({
      success: false,
      text: "",
      error: "No text provided",
      method: "a11y",
    });
    // Early return: never reaches the accessibility service or ADB.
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });

  test("uses the atomic a11y setText (no key events) when no marker matches", async () => {
    serverConfig.setEventAllMarkers([]);
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      fakeA11yService as unknown as AndroidCtrlProxyClient,
    );

    const inputText = new InputText(androidDevice, fakeAdb as any);
    wireFakes(inputText);

    const result = await inputText.execute("/a");

    expect(result.success).toBe(true);
    expect(result.method).toBe("a11y");
    // a11y mode sets the whole string atomically and issues no per-character keyevents.
    expect(fakeA11yService.getTextInputHistory()).toEqual([{ text: "/a", resourceId: undefined }]);
    expect(fakeAdb.getExecutedCommands().some((cmd) => cmd.includes("keyevent"))).toBe(false);
  });

  test("auto-promotes to eventAll key events when the text matches a configured marker", async () => {
    serverConfig.setEventAllMarkers(["/"]);
    getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
      fakeA11yService as unknown as AndroidCtrlProxyClient,
    );

    const inputText = new InputText(androidDevice, fakeAdb as any);
    wireFakes(inputText);

    const result = await inputText.execute("/a");

    expect(result.success).toBe(true);
    expect(result.method).toBe("eventAll");
    // eventAll types character-by-character via real key events so keystroke-driven
    // autocomplete (slash/@ popups) actually opens.
    expect(fakeAdb.getExecutedCommands().some((cmd) => cmd.includes("keyevent"))).toBe(true);
  });

  test("routes iOS input through the CtrlProxy client and ignores Android modes", async () => {
    iosGetInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      fakeIosCtrlProxy as unknown as IOSCtrlProxyClient,
    );

    const inputText = new InputText(iosDevice, fakeAdb as any);
    wireFakes(inputText);

    const result = await inputText.execute("hello", undefined, false, "eventAll");

    expect(result.success).toBe(true);
    // iOS always reports the a11y method regardless of the requested Android mode.
    expect(result.method).toBe("a11y");
    expect(fakeIosCtrlProxy.getTextInputHistory()).toEqual([
      { text: "hello", resourceId: undefined },
    ]);
    expect(fakeAdb.getExecutedCommands()).toEqual([]);
  });
});
