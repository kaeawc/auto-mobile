import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { OpenURL } from "../../../src/features/action/OpenURL";
import { LaunchApp } from "../../../src/features/action/LaunchApp";
import { IOSCtrlProxyManager } from "../../../src/utils/IOSCtrlProxyManager";
import { BootedDevice } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeDeviceCtlClient } from "../../fakes/FakeDeviceCtlClient";

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
  devicectl: FakeDeviceCtlClient,
  url: string
) => {
  const openURL = new OpenURL(device, new FakeAdbExecutor() as unknown as any, simctl as any, devicectl as any);
  return (openURL as any).executeiOSOpenURL(url) as Promise<{ success: boolean; url: string; error?: string }>;
};

describe("OpenURL iOS routing", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length) { restores.pop()!(); }
  });

  test("(a) simulator UDID routes to `simctl openurl` and never touches devicectl", async () => {
    const simctl = new FakeSimCtlClient();
    const devicectl = new FakeDeviceCtlClient();

    const result = await openIos(iosDevice(SIMULATOR_UDID), simctl, devicectl, "https://example.com/x");

    expect(result).toEqual({ success: true, url: "https://example.com/x" });
    const calls = simctl.getMethodCalls("executeCommand");
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(`openurl ${SIMULATOR_UDID} "https://example.com/x"`);
    expect(devicectl.launchCalls).toHaveLength(0);
  });

  test("(b) physical UDID + http URL launches Safari with the payload URL", async () => {
    const simctl = new FakeSimCtlClient();
    const devicectl = new FakeDeviceCtlClient();

    const result = await openIos(iosDevice(PHYSICAL_UDID), simctl, devicectl, "https://example.com/order/123");

    expect(result).toEqual({ success: true, url: "https://example.com/order/123" });
    expect(devicectl.launchCalls).toEqual([
      { deviceUdid: PHYSICAL_UDID, bundleId: "com.apple.mobilesafari", url: "https://example.com/order/123" },
    ]);
    expect(simctl.getMethodCalls("executeCommand")).toHaveLength(0);
  });

  test("(c) physical UDID + custom scheme launches the resolved target bundle id", async () => {
    // The physical custom-scheme branch reads the target with the
    // non-constructing static, so it never spins up a CtrlProxy manager.
    const targetSpy = spyOn(IOSCtrlProxyManager, "getExistingTargetBundleId").mockReturnValue("com.example.MyApp");
    restores.push(() => targetSpy.mockRestore());

    const simctl = new FakeSimCtlClient();
    const devicectl = new FakeDeviceCtlClient();

    const result = await openIos(iosDevice(PHYSICAL_UDID), simctl, devicectl, "myapp://order/123");

    expect(result.success).toBe(true);
    expect(devicectl.launchCalls).toEqual([
      { deviceUdid: PHYSICAL_UDID, bundleId: "com.example.MyApp", url: "myapp://order/123" },
    ]);
  });

  test("(c2) physical UDID + custom scheme with no target bundle falls back to Safari", async () => {
    const targetSpy = spyOn(IOSCtrlProxyManager, "getExistingTargetBundleId").mockReturnValue(undefined);
    restores.push(() => targetSpy.mockRestore());

    const simctl = new FakeSimCtlClient();
    const devicectl = new FakeDeviceCtlClient();

    await openIos(iosDevice(PHYSICAL_UDID), simctl, devicectl, "myapp://order/123");

    expect(devicectl.launchCalls[0].bundleId).toBe("com.apple.mobilesafari");
  });

  test("(c3) physical UDID + mailto: with no target routes to Safari (best-effort, pinned behavior)", async () => {
    const targetSpy = spyOn(IOSCtrlProxyManager, "getExistingTargetBundleId").mockReturnValue(undefined);
    restores.push(() => targetSpy.mockRestore());

    const simctl = new FakeSimCtlClient();
    const devicectl = new FakeDeviceCtlClient();

    const result = await openIos(iosDevice(PHYSICAL_UDID), simctl, devicectl, "mailto:a@b.com");

    // mailto:/tel: are not http(s), so they take the non-http branch. With no
    // target app they fall back to Safari — pinned so a routing change is caught.
    expect(result.success).toBe(true);
    expect(devicectl.launchCalls).toEqual([
      { deviceUdid: PHYSICAL_UDID, bundleId: "com.apple.mobilesafari", url: "mailto:a@b.com" },
    ]);
  });

  test("(d) unavailable devicectl returns an explicit iOS 17+/Xcode 15+ error (no throw, no simctl)", async () => {
    const simctl = new FakeSimCtlClient();
    const devicectl = new FakeDeviceCtlClient();
    devicectl.setAvailable(false);

    const result = await openIos(iosDevice(PHYSICAL_UDID), simctl, devicectl, "https://example.com");

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Xcode 15\+ and iOS 17\+/);
    expect(devicectl.launchCalls).toHaveLength(0);
    expect(simctl.getMethodCalls("executeCommand")).toHaveLength(0);
  });

  test("(e) devicectl launch failure returns { success:false, error }", async () => {
    const simctl = new FakeSimCtlClient();
    const devicectl = new FakeDeviceCtlClient();
    devicectl.setLaunchError(new Error("device locked"));

    const result = await openIos(iosDevice(PHYSICAL_UDID), simctl, devicectl, "https://example.com");

    expect(result.success).toBe(false);
    expect(result.error).toContain("device locked");
  });

  test("(a-neg) simulator simctl failure returns { success:false, error }", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandError(`openurl ${SIMULATOR_UDID} "https://example.com"`, new Error("Invalid device"));
    const devicectl = new FakeDeviceCtlClient();

    const result = await openIos(iosDevice(SIMULATOR_UDID), simctl, devicectl, "https://example.com");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid device");
  });
});

describe("OpenURL package: delegation is unchanged", () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length) { restores.pop()!(); }
  });

  test("(f) package: URL delegates to LaunchApp on iOS without touching simctl/devicectl", async () => {
    const launchSpy = spyOn(LaunchApp.prototype, "execute").mockResolvedValue({ success: true } as any);
    restores.push(() => launchSpy.mockRestore());

    const simctl = new FakeSimCtlClient();
    const devicectl = new FakeDeviceCtlClient();
    const openURL = new OpenURL(
      iosDevice(PHYSICAL_UDID),
      new FakeAdbExecutor() as unknown as any,
      simctl as any,
      devicectl as any
    );

    const result = await openURL.execute("package:com.example.MyApp");

    expect(result.success).toBe(true);
    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(launchSpy.mock.calls[0][0]).toBe("com.example.MyApp");
    expect(devicectl.launchCalls).toHaveLength(0);
    expect(simctl.getMethodCalls("executeCommand")).toHaveLength(0);
  });
});

describe("OpenURL Android parity (regression guard)", () => {
  test("executeAndroidOpenURL issues the exact VIEW-intent am start command", async () => {
    const fakeAdb = new FakeAdbExecutor();
    const openURL = new OpenURL(
      { name: "pixel", platform: "android", deviceId: "emulator-5554" },
      fakeAdb as unknown as any
    );

    const result = await (openURL as any).executeAndroidOpenURL("https://example.com/x") as { success: boolean; url: string };

    expect(result).toEqual({ success: true, url: "https://example.com/x" });
    expect(fakeAdb.getExecutedCommands()).toContain(
      'shell am start -a android.intent.action.VIEW -d "https://example.com/x"'
    );
  });
});

describe("OpenURL input validation", () => {
  const openAndroid = (url: string) =>
    new OpenURL(
      { name: "pixel", platform: "android", deviceId: "emulator-5554" },
      new FakeAdbExecutor() as unknown as any
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
