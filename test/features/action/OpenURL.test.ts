import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { OpenURL } from "../../../src/features/action/OpenURL";
import { BaseVisualChange } from "../../../src/features/action/BaseVisualChange";
import { LaunchApp } from "../../../src/features/action/LaunchApp";
import { IOSCtrlProxyManager } from "../../../src/utils/IOSCtrlProxyManager";
import { BootedDevice } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeDeviceUrlLauncher } from "../../fakes/FakeDeviceUrlLauncher";

const SIMULATOR_UDID = "ABCDEF01-1234-1234-1234-1234567890AB";
const PHYSICAL_UDID = "00008110-000A4D8E1234567E";

const iosDevice = (deviceId: string): BootedDevice => ({
  name: "iPhone",
  platform: "ios",
  deviceId,
});

// Directly exercise the iOS routing (executeiOSOpenURL) so we assert the
// sim-vs-physical branch without spinning up the observe/visual-change machinery.
const openIos = (
  device: BootedDevice,
  simctl: FakeSimCtlClient,
  devicectl: FakeDeviceUrlLauncher,
  url: string,
) => {
  const openURL = new OpenURL(
    device,
    new FakeAdbExecutor() as unknown as any,
    simctl as any,
    devicectl as any,
  );
  return (openURL as any).executeiOSOpenURL(url) as Promise<{
    success: boolean;
    url: string;
    error?: string;
  }>;
};

describe("OpenURL iOS routing", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length) {
      restores.pop()!();
    }
  });

  test("(a) simulator UDID routes to `simctl openurl` and never touches devicectl", async () => {
    const simctl = new FakeSimCtlClient();
    const devicectl = new FakeDeviceUrlLauncher();

    const result = await openIos(
      iosDevice(SIMULATOR_UDID),
      simctl,
      devicectl,
      "https://example.com/x",
    );

    expect(result).toEqual({ success: true, url: "https://example.com/x" });
    const calls = simctl.getMethodCalls("executeCommandArgs");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["openurl", SIMULATOR_UDID, "https://example.com/x"]);
    expect(devicectl.launchCalls).toHaveLength(0);
  });

  test("(b) physical UDID + http URL launches Safari with the payload URL", async () => {
    const simctl = new FakeSimCtlClient();
    const devicectl = new FakeDeviceUrlLauncher();

    const result = await openIos(
      iosDevice(PHYSICAL_UDID),
      simctl,
      devicectl,
      "https://example.com/order/123",
    );

    expect(result).toEqual({ success: true, url: "https://example.com/order/123" });
    expect(devicectl.launchCalls).toEqual([
      {
        deviceUdid: PHYSICAL_UDID,
        bundleId: "com.apple.mobilesafari",
        url: "https://example.com/order/123",
      },
    ]);
    expect(simctl.getMethodCalls("executeCommandArgs")).toHaveLength(0);
  });

  test("(c) physical UDID + custom scheme launches the resolved target bundle id", async () => {
    // The physical custom-scheme branch reads the target with the
    // non-constructing static, so it never spins up a CtrlProxy manager.
    const targetSpy = spyOn(IOSCtrlProxyManager, "getExistingTargetBundleId").mockReturnValue(
      "com.example.MyApp",
    );
    restores.push(() => targetSpy.mockRestore());

    const simctl = new FakeSimCtlClient();
    const devicectl = new FakeDeviceUrlLauncher();

    const result = await openIos(iosDevice(PHYSICAL_UDID), simctl, devicectl, "myapp://order/123");

    expect(result.success).toBe(true);
    expect(devicectl.launchCalls).toEqual([
      { deviceUdid: PHYSICAL_UDID, bundleId: "com.example.MyApp", url: "myapp://order/123" },
    ]);
  });

  test("(c2) physical UDID + custom scheme with no target bundle falls back to Safari", async () => {
    const targetSpy = spyOn(IOSCtrlProxyManager, "getExistingTargetBundleId").mockReturnValue(
      undefined,
    );
    restores.push(() => targetSpy.mockRestore());

    const simctl = new FakeSimCtlClient();
    const devicectl = new FakeDeviceUrlLauncher();

    await openIos(iosDevice(PHYSICAL_UDID), simctl, devicectl, "myapp://order/123");

    expect(devicectl.launchCalls[0].bundleId).toBe("com.apple.mobilesafari");
  });

  test("(c3) physical UDID + system scheme (mailto:) routes to Safari even when a target app is set", async () => {
    // Regression guard: a prior launchApp sets a cached target bundle. System
    // schemes (mailto:/tel:/sms:) must STILL go to Safari/system resolution —
    // never the app-under-test, which can't open a mailto: payload.
    const targetSpy = spyOn(IOSCtrlProxyManager, "getExistingTargetBundleId").mockReturnValue(
      "com.example.MyApp",
    );
    restores.push(() => targetSpy.mockRestore());

    const simctl = new FakeSimCtlClient();
    const devicectl = new FakeDeviceUrlLauncher();

    const result = await openIos(iosDevice(PHYSICAL_UDID), simctl, devicectl, "mailto:a@b.com");

    expect(result.success).toBe(true);
    expect(devicectl.launchCalls).toEqual([
      { deviceUdid: PHYSICAL_UDID, bundleId: "com.apple.mobilesafari", url: "mailto:a@b.com" },
    ]);
  });

  test("(c4) physical UDID + tel: routes to Safari/system resolver, not the target app", async () => {
    const targetSpy = spyOn(IOSCtrlProxyManager, "getExistingTargetBundleId").mockReturnValue(
      "com.example.MyApp",
    );
    restores.push(() => targetSpy.mockRestore());

    const simctl = new FakeSimCtlClient();
    const devicectl = new FakeDeviceUrlLauncher();

    await openIos(iosDevice(PHYSICAL_UDID), simctl, devicectl, "tel:+15551234567");

    expect(devicectl.launchCalls[0].bundleId).toBe("com.apple.mobilesafari");
  });

  test("(d) unavailable devicectl returns an explicit iOS 17+/Xcode 15+ error (no throw, no simctl)", async () => {
    const simctl = new FakeSimCtlClient();
    const devicectl = new FakeDeviceUrlLauncher();
    devicectl.setAvailable(false);

    const result = await openIos(
      iosDevice(PHYSICAL_UDID),
      simctl,
      devicectl,
      "https://example.com",
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Xcode 15\+ and iOS 17\+/);
    expect(devicectl.launchCalls).toHaveLength(0);
    expect(simctl.getMethodCalls("executeCommandArgs")).toHaveLength(0);
  });

  test("(e) devicectl launch failure returns { success:false, error }", async () => {
    const simctl = new FakeSimCtlClient();
    const devicectl = new FakeDeviceUrlLauncher();
    devicectl.setLaunchError(new Error("device locked"));

    const result = await openIos(
      iosDevice(PHYSICAL_UDID),
      simctl,
      devicectl,
      "https://example.com",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("device locked");
  });

  test("(a-neg) simulator simctl failure returns { success:false, error }", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandError(
      `openurl ${SIMULATOR_UDID} https://example.com`,
      new Error("Invalid device"),
    );
    const devicectl = new FakeDeviceUrlLauncher();

    const result = await openIos(
      iosDevice(SIMULATOR_UDID),
      simctl,
      devicectl,
      "https://example.com",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid device");
  });
});

describe("OpenURL package: delegation is unchanged", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length) {
      restores.pop()!();
    }
  });

  test("(f) package: URL delegates to LaunchApp on iOS without touching simctl/devicectl", async () => {
    const launchSpy = spyOn(LaunchApp.prototype, "execute").mockResolvedValue({
      success: true,
    } as any);
    restores.push(() => launchSpy.mockRestore());

    const simctl = new FakeSimCtlClient();
    const devicectl = new FakeDeviceUrlLauncher();
    const openURL = new OpenURL(
      iosDevice(PHYSICAL_UDID),
      new FakeAdbExecutor() as unknown as any,
      simctl as any,
      devicectl as any,
    );

    const result = await openURL.execute("package:com.example.MyApp");

    expect(result.success).toBe(true);
    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(launchSpy.mock.calls[0][0]).toBe("com.example.MyApp");
    expect(devicectl.launchCalls).toHaveLength(0);
    expect(simctl.getMethodCalls("executeCommandArgs")).toHaveLength(0);
  });
});

describe("OpenURL Android parity (regression guard)", () => {
  test("executeAndroidOpenURL issues the exact VIEW-intent am start command", async () => {
    const fakeAdb = new FakeAdbExecutor();
    const openURL = new OpenURL(
      { name: "pixel", platform: "android", deviceId: "emulator-5554" },
      fakeAdb as unknown as any,
    );

    const result = (await (openURL as any).executeAndroidOpenURL("https://example.com/x")) as {
      success: boolean;
      url: string;
    };

    expect(result).toEqual({ success: true, url: "https://example.com/x" });
    expect(fakeAdb.getExecutedArgv()).toEqual([
      ["shell", "am start -a android.intent.action.VIEW -d 'https://example.com/x'"],
    ]);
  });
});

describe("OpenURL input validation", () => {
  const openAndroid = (url: string) =>
    new OpenURL(
      { name: "pixel", platform: "android", deviceId: "emulator-5554" },
      new FakeAdbExecutor() as unknown as any,
    ).execute(url);

  test("empty URL returns an explicit error without dispatching", async () => {
    const result = await openAndroid("");
    expect(result).toEqual({ success: false, url: "", error: "Invalid URL provided" });
  });

  test("whitespace-only URL returns an explicit error", async () => {
    const result = await openAndroid("   ");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Invalid URL provided");
  });

  test("bare package: URL (no package name) returns an explicit error", async () => {
    const result = await openAndroid("package:");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Invalid package URL - no package name specified");
  });
});

// Issue #4166: execute() trimmed the URL for validation/logging but dispatched
// the RAW value, so surrounding whitespace reached `am start -d` / `simctl
// openurl` while the logs and the returned result showed the clean URL. These
// tests assert the COMMAND STRING ACTUALLY ISSUED — the return value already
// looked correct before the fix, which is exactly why this went unnoticed.
describe("OpenURL trims the dispatched URL (issue #4166)", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length) {
      restores.pop()!();
    }
  });

  // Run execute() without the observe/visual-change machinery: the block is the
  // platform dispatch we want to observe, and it is the only part under test.
  const stubObservedInteraction = () => {
    const spy = spyOn(BaseVisualChange.prototype, "observedInteraction").mockImplementation(
      async (block: any) => block({} as any),
    );
    restores.push(() => spy.mockRestore());
  };

  const whitespaceCases: Array<[string, string, string]> = [
    ["no whitespace (control)", "https://example.com/x", "https://example.com/x"],
    ["leading space", " https://example.com/x", "https://example.com/x"],
    ["trailing space", "https://example.com/x ", "https://example.com/x"],
    ["leading and trailing spaces", "  https://example.com/x  ", "https://example.com/x"],
    ["tab", "\thttps://example.com/x\t", "https://example.com/x"],
    ["newline", "\nhttps://example.com/x\n", "https://example.com/x"],
    ["carriage return + newline", "\r\nhttps://example.com/x\r\n", "https://example.com/x"],
    // Inner whitespace is NOT surrounding whitespace: trim() must leave it alone.
    ["inner whitespace is preserved", " https://example.com/a b ", "https://example.com/a b"],
  ];

  test.each(whitespaceCases)("android dispatch: %s", async (_label, input, expectedUrl) => {
    stubObservedInteraction();
    const fakeAdb = new FakeAdbExecutor();
    const openURL = new OpenURL(
      { name: "pixel", platform: "android", deviceId: "emulator-5554" },
      fakeAdb as unknown as any,
    );

    const result = await openURL.execute(input);

    expect(fakeAdb.getExecutedArgv()).toEqual([
      ["shell", `am start -a android.intent.action.VIEW -d '${expectedUrl}'`],
    ]);
    expect(result).toEqual({ success: true, url: expectedUrl });
  });

  test.each(whitespaceCases)("ios simulator dispatch: %s", async (_label, input, expectedUrl) => {
    stubObservedInteraction();
    const simctl = new FakeSimCtlClient();
    const devicectl = new FakeDeviceUrlLauncher();
    const openURL = new OpenURL(
      iosDevice(SIMULATOR_UDID),
      new FakeAdbExecutor() as unknown as any,
      simctl as any,
      devicectl as any,
    );

    const result = await openURL.execute(input);

    const calls = simctl.getMethodCalls("executeCommandArgs");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["openurl", SIMULATOR_UDID, expectedUrl]);
    expect(result).toEqual({ success: true, url: expectedUrl });
  });

  test.each(whitespaceCases)("ios physical dispatch: %s", async (_label, input, expectedUrl) => {
    stubObservedInteraction();
    const simctl = new FakeSimCtlClient();
    const devicectl = new FakeDeviceUrlLauncher();
    const openURL = new OpenURL(
      iosDevice(PHYSICAL_UDID),
      new FakeAdbExecutor() as unknown as any,
      simctl as any,
      devicectl as any,
    );

    const result = await openURL.execute(input);

    expect(devicectl.launchCalls).toEqual([
      { deviceUdid: PHYSICAL_UDID, bundleId: "com.apple.mobilesafari", url: expectedUrl },
    ]);
    expect(result).toEqual({ success: true, url: expectedUrl });
  });

  test("package: URL with surrounding whitespace still delegates to LaunchApp", async () => {
    const launchSpy = spyOn(LaunchApp.prototype, "execute").mockResolvedValue({
      success: true,
    } as any);
    restores.push(() => launchSpy.mockRestore());

    const openURL = new OpenURL(
      { name: "pixel", platform: "android", deviceId: "emulator-5554" },
      new FakeAdbExecutor() as unknown as any,
    );

    const result = await openURL.execute("  package:com.example.MyApp  ");

    expect(launchSpy.mock.calls[0][0]).toBe("com.example.MyApp");
    expect(result).toEqual({ success: true, url: "package:com.example.MyApp" });
  });
});
