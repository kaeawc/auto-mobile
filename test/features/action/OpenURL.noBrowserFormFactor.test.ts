import { describe, expect, test } from "bun:test";
import { OpenURL } from "../../../src/features/action/OpenURL";
import {
  OpenUrlUnsupportedError,
  parseResolvedViewActivity,
  type OpenUrlFormFactorOptions,
} from "../../../src/features/action/OpenUrlUnsupportedError";
import type { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import { CachedAndroidTvDetector } from "../../../src/utils/android-cmdline-tools/androidTvDevice";
import { CachedXrGlassesDetector } from "../../../src/utils/android-cmdline-tools/xrGlassesDevice";
import { buildObserveResult } from "../../helpers/observeFixture";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAndroidTvDetector } from "../../fakes/FakeAndroidTvDetector";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeXrGlassesDetector } from "../../fakes/FakeXrGlassesDetector";

const RESOLVE = "cmd package resolve-activity --brief -a android.intent.action.VIEW";
const AM_START = "am start -a android.intent.action.VIEW";
const URL = "https://example.com";
// `pm query-activities -a VIEW -d https://example.com` on android-36;android-tv (#19233).
const TV_STUB = "com.android.tv.frameworkpackagestubs/.Stubs$BrowserStub";
const briefResolution = (component: string): string =>
  `priority=0 preferredOrder=0 match=0x208000 specificIndex=-1 isDefault=true\n${component}\n`;

const base: BootedDevice = {
  name: "device",
  platform: "android",
  deviceId: "emulator-5570",
  source: "local",
};

function realDetectors(): Required<OpenUrlFormFactorOptions> {
  return {
    tvDetector: new CachedAndroidTvDetector(new FakeTimer()),
    glassesDetector: new CachedXrGlassesDetector(new FakeTimer(), 60_000, () => undefined),
  };
}

function setup(
  device: BootedDevice,
  formFactors: OpenUrlFormFactorOptions,
): { adb: FakeAdbExecutor; observeScreen: FakeObserveScreen; openURL: OpenURL } {
  const adb = new FakeAdbExecutor();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const openURL = new OpenURL(device, { adb, simctl: null, devicectl: null, timer, formFactors });
  const observeScreen = new FakeObserveScreen();
  observeScreen.setObserveResult(
    buildObserveResult({
      observationId: "open-url-form-factor",
      display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
      updatedAt: 0,
      screenSize: { width: 1920, height: 1080 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: { hierarchy: {} },
    }),
  );
  Object.assign(openURL, {
    observeScreen,
    window: new FakeWindow(),
    awaitIdle: new FakeAwaitIdle(),
  });
  return { adb, observeScreen, openURL };
}

const amStarts = (adb: FakeAdbExecutor): string[] =>
  adb.getExecutedCommands().filter((command) => command.includes(AM_START));

describe("openLink on Android TV (#19233)", () => {
  test("refuses a URL that resolves only to the TV BrowserStub before am start", async () => {
    const { adb, observeScreen, openURL } = setup({ ...base, formFactor: "tv" }, realDetectors());
    adb.setCommandResponse(RESOLVE, createExecResult(briefResolution(TV_STUB), ""));

    const error = await openURL.execute(URL).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenUrlUnsupportedError);
    const message = (error as Error).message;
    expect(message).toContain(`on Android TV ${base.deviceId}`);
    expect(message).toContain(TV_STUB);
    expect(message).toContain("no intent was started");
    expect(amStarts(adb)).toEqual([]);
    expect(observeScreen.getExecuteCallCount()).toBe(0);
  });

  test("refuses a URL nothing resolves", async () => {
    const { adb, openURL } = setup({ ...base, formFactor: "tv" }, realDetectors());
    adb.setCommandResponse(RESOLVE, createExecResult("No activity found\n", ""));

    const error = await openURL.execute(URL).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenUrlUnsupportedError);
    expect((error as Error).message).toContain("no installed app handles it");
    expect(amStarts(adb)).toEqual([]);
  });

  test("opens a URL a real activity handles", async () => {
    const { adb, openURL } = setup({ ...base, formFactor: "tv" }, realDetectors());
    adb.setCommandResponse(
      RESOLVE,
      createExecResult(briefResolution("com.example.tvapp/.DeepLinkActivity"), ""),
    );

    const result = await openURL.execute("tvapp://show/1");

    expect(result.success).toBe(true);
    expect(amStarts(adb)).toEqual([`shell ${AM_START} -d 'tvapp://show/1'`]);
  });

  test("an unreadable resolver falls through to am start", async () => {
    const { adb, openURL } = setup({ ...base, formFactor: "tv" }, realDetectors());
    adb.setCommandError(RESOLVE, new Error("cmd: Can't find service: package"));

    const result = await openURL.execute(URL);

    expect(result.success).toBe(true);
    expect(amStarts(adb)).toHaveLength(1);
  });
});

describe("openLink on Android XR glasses (#19233)", () => {
  test("refuses a URL nothing resolves with a typed error, not the raw am start dump", async () => {
    const { adb, openURL } = setup({ ...base, formFactor: "xr-glasses" }, realDetectors());
    adb.setCommandResponse(RESOLVE, createExecResult("No activity found\n", ""));

    const error = await openURL.execute(URL).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenUrlUnsupportedError);
    const message = (error as Error).message;
    expect(message).toContain(`on Android XR glasses ${base.deviceId}`);
    expect(message).not.toContain("exit code");
    expect(amStarts(adb)).toEqual([]);
  });

  test("asks the glasses predicate after the TV predicate", async () => {
    const tvDetector = new FakeAndroidTvDetector(false);
    const glassesDetector = new FakeXrGlassesDetector(true);
    const { adb, openURL } = setup(base, { tvDetector, glassesDetector });
    adb.setCommandResponse(RESOLVE, createExecResult("No activity found\n", ""));

    await expect(openURL.execute(URL)).rejects.toBeInstanceOf(OpenUrlUnsupportedError);
    expect(tvDetector.queries).toEqual([base.deviceId]);
    expect(glassesDetector.queries).toEqual([base.deviceId]);
  });
});

describe("openLink on a phone is unchanged (#19233)", () => {
  for (const formFactor of ["phone", "tablet", "foldable"] as const) {
    test(`a ${formFactor} issues only the am start, with no resolver read`, async () => {
      const { adb, openURL } = setup({ ...base, formFactor }, realDetectors());

      const result = await openURL.execute(URL);

      expect(result.success).toBe(true);
      expect(adb.getExecutedCommands()).toEqual([`shell ${AM_START} -d '${URL}'`]);
    });
  }

  test("an unresolved intent on a phone keeps its untyped failure result", async () => {
    const { adb, openURL } = setup({ ...base, formFactor: "phone" }, realDetectors());
    adb.setCommandResponse(
      AM_START,
      createExecResult("Error: Activity not started, unable to resolve Intent", ""),
    );

    const result = await openURL.execute("myapp://order/1");

    expect(result.success).toBe(false);
    expect(result.error).toContain("unable to resolve Intent");
  });
});

describe("parseResolvedViewActivity", () => {
  test.each([
    [briefResolution(TV_STUB), TV_STUB],
    [
      "com.android.chrome/com.google.android.apps.chrome.IntentDispatcher",
      "com.android.chrome/com.google.android.apps.chrome.IntentDispatcher",
    ],
    ["No activity found", null],
    ["", null],
  ])("parses %p", (stdout, expected) => {
    expect(parseResolvedViewActivity(stdout)).toBe(expected);
  });
});
