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
    const managerSpy = spyOn(IOSCtrlProxyManager, "getInstance").mockReturnValue({
      getTargetBundleId: () => "com.example.MyApp",
    } as unknown as IOSCtrlProxyManager);
    restores.push(() => managerSpy.mockRestore());

    const simctl = new FakeSimCtlClient();
    const devicectl = new FakeDeviceCtlClient();

    const result = await openIos(iosDevice(PHYSICAL_UDID), simctl, devicectl, "myapp://order/123");

    expect(result.success).toBe(true);
    expect(devicectl.launchCalls).toEqual([
      { deviceUdid: PHYSICAL_UDID, bundleId: "com.example.MyApp", url: "myapp://order/123" },
    ]);
  });

  test("(c2) physical UDID + custom scheme with no target bundle falls back to Safari", async () => {
    const managerSpy = spyOn(IOSCtrlProxyManager, "getInstance").mockReturnValue({
      getTargetBundleId: () => undefined,
    } as unknown as IOSCtrlProxyManager);
    restores.push(() => managerSpy.mockRestore());

    const simctl = new FakeSimCtlClient();
    const devicectl = new FakeDeviceCtlClient();

    await openIos(iosDevice(PHYSICAL_UDID), simctl, devicectl, "myapp://order/123");

    expect(devicectl.launchCalls[0].bundleId).toBe("com.apple.mobilesafari");
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
