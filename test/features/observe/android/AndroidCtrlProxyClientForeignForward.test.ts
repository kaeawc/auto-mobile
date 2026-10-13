import { installFakeCtrlProxyManagers } from "../../../helpers/hermeticDeviceTools";
import { setCtrlProxyHostPortProbeForTesting } from "../../../../src/features/observe/android/ctrlProxyHostPortProbe";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import type { CtrlProxyForwardLease } from "../../../../src/features/observe/android/CtrlProxyForwardLease";
import { CtrlProxyForwardingLeaseConflictError } from "../../../../src/features/observe/shared/CtrlProxyForwardingLeaseConflictError";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { createSuccessWebSocketFactory } from "../../../fakes/FakeWebSocket";

const device = { deviceId: "foreign-forward-test", name: "Pixel", platform: "android" as const };
let client: AndroidCtrlProxyClient | undefined;
let restoreManagers: () => void;
beforeEach(() => {
  restoreManagers = installFakeCtrlProxyManagers();
  setCtrlProxyHostPortProbeForTesting({ isPortFree: async () => true });
});
afterEach(async () => {
  await client?.close();
  client = undefined;
  AndroidCtrlProxyClient.resetInstances();
  restoreManagers();
  setCtrlProxyHostPortProbeForTesting(null);
});

function harness(acquire = true) {
  const adb = new FakeAdbExecutor();
  adb.setDeviceStates([{ deviceId: device.deviceId, state: "device" }]);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  let listed = true;
  const execute = adb.execute.bind(adb);
  adb.execute = async (args, options) => {
    if (args.join(" ") === "forward --list") {
      adb.setCommandResponse("forward --list", {
        stdout: listed ? `${device.deviceId} tcp:52001 tcp:8765` : "",
        stderr: "",
      });
    }
    if (args.join(" ") === "forward --remove tcp:52001") {
      listed = false;
    }
    return execute(args, options);
  };
  const lease: CtrlProxyForwardLease = {
    tryAcquire: () => acquire,
    release: () => {},
    getLastOwnerPid: () => 4242,
    ownsForward: () => false,
  };
  let recoveries = 0;
  client = AndroidCtrlProxyClient.createForTesting(
    device,
    adb,
    createSuccessWebSocketFactory(),
    timer,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    lease,
    () => {
      recoveries++;
      throw new Error("unexpected recovery");
    },
  );
  return { client, adb, recoveries: () => recoveries };
}

describe("#12220 foreign forward protection", () => {
  test("#12220 retains a live foreign PID across disconnected sweeps and reclaims only after death", async () => {
    const h = harness();
    let connected = true;
    let alive = true;
    h.client.forwardClientProbe = { findClientPids: async () => (connected ? [4242] : []) };
    h.client.forwardClientProcessIsRunning = () => alive;
    await expect(h.client.sweepOrphanedCtrlProxyPortForwards()).rejects.toBeInstanceOf(
      CtrlProxyForwardingLeaseConflictError,
    );
    connected = false;
    await expect(h.client.sweepOrphanedCtrlProxyPortForwards()).rejects.toBeInstanceOf(
      CtrlProxyForwardingLeaseConflictError,
    );
    expect(h.adb.getExecutedCommands().filter((c) => c.startsWith("forward --remove"))).toEqual([]);
    alive = false;
    await h.client.sweepOrphanedCtrlProxyPortForwards();
    expect(h.adb.getExecutedCommands().filter((c) => c.startsWith("forward --remove"))).toEqual([
      "forward --remove tcp:52001",
    ]);
    await h.client.setupPortForwarding();
    expect(
      h.adb.getExecutedCommands().some((command) => /^forward tcp:\d+ tcp:8765$/.test(command)),
    ).toBe(true);
  });

  test("#12220 three forwarding lease conflicts never invoke service recovery", async () => {
    const h = harness(false);
    for (let i = 0; i < 3; i++) {
      h.client.resetConnectionBudget();
      expect(await h.client.waitForConnection(1, 0)).toBe(false);
      expect(h.client.isLastConnectionFailureForwardingLeaseConflict()).toBe(true);
    }
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
    }
    expect(h.recoveries()).toBe(0);
  });
});
