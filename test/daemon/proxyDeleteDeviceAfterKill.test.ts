import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  DaemonBoundSessionExpiredError,
  DaemonConnectionSessionReleasedError,
  DaemonMcpProxy,
} from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client/client";
import { DAEMON_BOUND_SESSION_PARAM, DAEMON_VERSION } from "../../src/daemon/wire/constants";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/daemon/sessionReleaseBroadcast";
import { logger } from "../../src/utils/logger";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

// #19176: after killDevice ends a connection's session, deleteDevice (which names its target by
// stableId and needs no device session) must reach the daemon on that same connection. It is
// forwarded without the released binding or a surviving sibling session, so the daemon's lifecycle
// holder check (assertLifecycleCallerHoldsDevice) still refuses a device another session holds:
// test/server/deviceTools.teardownDevice.test.ts "is refused to a sessionless caller".

interface AcquiredDevice {
  sessionUuid: string;
  deviceId: string;
  platform: "android" | "ios";
}

const ANDROID: AcquiredDevice = {
  sessionUuid: "android-session",
  deviceId: "emulator-5554",
  platform: "android",
};
const IOS: AcquiredDevice = {
  sessionUuid: "ios-session",
  deviceId: "SIM-UDID-1",
  platform: "ios",
};

function deleteArgs(device: AcquiredDevice): Record<string, unknown> {
  return {
    target: {
      platform: device.platform,
      isVirtual: true,
      stableId: device.deviceId,
      stableName: "Device",
    },
    mode: "destroy",
    verifyAbsence: true,
  };
}

describe("deleteDevice after killDevice ended the connection's session (#19176)", () => {
  let proxy: DaemonMcpProxy;
  let client: FakeDaemonClient;
  let acquisitions: AcquiredDevice[];
  let forwarded: Array<{ name: string; params: Record<string, unknown> }>;
  let spies: Array<ReturnType<typeof spyOn>>;

  beforeEach(() => {
    acquisitions = [];
    forwarded = [];
    spies = [
      spyOn(DaemonClient, "isAvailable").mockResolvedValue(true),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "info").mockImplementation(() => {}),
    ];
    client = new FakeDaemonClient({
      onCallTool: (name, params) => {
        // FakeDaemonClient's built-in recording strips the bound-session marker.
        forwarded.push({ name, params: { ...params } });
      },
      toolResultFor: (name) => {
        if (name === "getAndroid" || name === "getApple") {
          const device = acquisitions.shift()!;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  platform: device.platform,
                  runtime: {
                    deviceId: device.deviceId,
                    session: { sessionUuid: device.sessionUuid },
                  },
                }),
              },
            ],
          };
        }
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager,
      autoStartDaemon: false,
      timer: new FakeTimer(),
      idGenerator: new FakeIdGenerator(),
      heartbeatIntervalMs: 2_000,
      heartbeatTimeoutMs: 10_000,
    });
  });

  afterEach(async () => {
    await proxy.close();
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  async function acquire(name: string, device: AcquiredDevice): Promise<void> {
    acquisitions.push(device);
    await proxy.callTool(name, {});
  }

  function killed(device: AcquiredDevice): void {
    client.emitNotification(
      SESSION_RELEASED_NOTIFICATION_METHOD,
      device.sessionUuid,
      "device-killed",
    );
  }

  function lastForward(): { name: string; params: Record<string, unknown> } {
    return forwarded.at(-1)!;
  }

  test("a sessionless deleteDevice is forwarded without the killed binding", async () => {
    await acquire("getApple", IOS);
    killed(IOS);

    await expect(proxy.callTool("deleteDevice", deleteArgs(IOS))).resolves.toBeDefined();

    expect(lastForward().name).toBe("deleteDevice");
    expect(lastForward().params).not.toHaveProperty("sessionUuid");
    expect(lastForward().params).not.toHaveProperty(DAEMON_BOUND_SESSION_PARAM);
    expect(lastForward().params.target).toEqual(deleteArgs(IOS).target);
  });

  test("other control calls stay fenced after the kill", async () => {
    await acquire("getApple", IOS);
    killed(IOS);
    const before = forwarded.length;

    await expect(proxy.callTool("homeScreen", {})).rejects.toBeInstanceOf(
      DaemonConnectionSessionReleasedError,
    );
    expect(forwarded.length).toBe(before);
  });

  test("a deleteDevice naming the killed session stays refused", async () => {
    await acquire("getApple", IOS);
    killed(IOS);
    const before = forwarded.length;

    await expect(
      proxy.callTool("deleteDevice", { ...deleteArgs(IOS), sessionUuid: IOS.sessionUuid }),
    ).rejects.toBeInstanceOf(DaemonBoundSessionExpiredError);
    expect(forwarded.length).toBe(before);
  });

  test("a device a surviving session still holds is not deleted under that session", async () => {
    await acquire("getAndroid", ANDROID);
    await acquire("getApple", IOS);
    killed(IOS);

    await expect(proxy.callTool("deleteDevice", deleteArgs(ANDROID))).resolves.toBeDefined();

    // Neither the survivor nor the killed binding is lent to the call: the daemon judges it as a
    // sessionless caller, which its lifecycle holder check refuses for a held device.
    expect(lastForward().name).toBe("deleteDevice");
    expect(lastForward().params).not.toHaveProperty("sessionUuid");
    expect(lastForward().params).not.toHaveProperty(DAEMON_BOUND_SESSION_PARAM);
  });

  test("while the binding is live deleteDevice keeps carrying it", async () => {
    await acquire("getApple", IOS);

    await proxy.callTool("deleteDevice", deleteArgs(IOS));

    expect(lastForward().params).toMatchObject({
      sessionUuid: IOS.sessionUuid,
      [DAEMON_BOUND_SESSION_PARAM]: IOS.sessionUuid,
    });
  });
});
