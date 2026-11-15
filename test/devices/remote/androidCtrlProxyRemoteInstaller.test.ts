import { describe, expect, test } from "bun:test";
import { AndroidCtrlProxyRemoteInstaller } from "../../../src/devices/remote/androidCtrlProxyRemoteInstaller";
import type { BootedDevice } from "../../../src/models";
import { FakeCtrlProxyManager } from "../../fakes/FakeCtrlProxyManager";

const device: BootedDevice = {
  name: "127.0.0.1:5001",
  platform: "android",
  deviceId: "127.0.0.1:5001",
};

function installer() {
  const calls: string[] = [];
  const manager = new FakeCtrlProxyManager();
  const subject = new AndroidCtrlProxyRemoteInstaller({
    invalidate: (serial) => calls.push(`invalidate:${serial}`),
    managerFor: (target) => {
      calls.push(`manager:${target.deviceId}`);
      return manager;
    },
  });
  return { calls, manager, subject };
}

describe("AndroidCtrlProxyRemoteInstaller", () => {
  test("forgetDevice invalidates the serial's manager state", () => {
    const { calls, subject } = installer();

    subject.forgetDevice("127.0.0.1:5001");

    expect(calls).toEqual(["invalidate:127.0.0.1:5001"]);
  });

  test("install forces a full setup on the serial's manager", async () => {
    const { calls, manager, subject } = installer();

    const result = await subject.install(device);

    expect(result.success).toBe(true);
    expect(calls).toEqual(["manager:127.0.0.1:5001"]);
    expect(manager.getExecutedOperations()).toContain("setup:force=true");
  });

  test("install reports a failed setup instead of throwing", async () => {
    const { manager, subject } = installer();
    manager.setSetupShouldFail(true);

    const result = await subject.install(device);

    expect(result).toMatchObject({ success: false, error: "Mock setup failure" });
  });
});
