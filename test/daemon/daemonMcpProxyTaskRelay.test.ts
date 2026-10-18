import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import {
  DaemonConnectionSessionReleasedError,
  DaemonMcpProxy,
} from "../../src/daemon/daemonMcpProxy";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { logger } from "../../src/utils/logger";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

/*
 * `DaemonMcpProxy` relays the MCP Tasks extension (#4668) under one owner key per proxy, and a
 * task poll is never held back by the state of this proxy's device sessions: a released (fenced)
 * binding still refuses device calls, but tasks/get keeps reaching the daemon.
 */

const ANDROID = { sessionUuid: "android-session", deviceId: "emulator-5554" };

function deviceStartResult() {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          platform: "android",
          runtime: { deviceId: ANDROID.deviceId, session: { sessionUuid: ANDROID.sessionUuid } },
        }),
      },
    ],
  };
}

describe("DaemonMcpProxy task relay (#4668)", () => {
  let client: FakeDaemonClient;
  let proxy: DaemonMcpProxy;
  let spies: Array<ReturnType<typeof spyOn>>;

  beforeEach(() => {
    client = new FakeDaemonClient({
      toolResultFor: (name) => (name === "getAndroid" ? deviceStartResult() : undefined),
      onRelayTaskMethod: (_method, params) => ({ resultType: "complete", ...params }),
    });
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    spies = [
      spyOn(DaemonClient, "isAvailable").mockResolvedValue(true),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "info").mockImplementation(() => {}),
    ];
    proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager,
      autoStartDaemon: false,
      timer: new FakeTimer(),
      idGenerator: new FakeIdGenerator(),
    });
  });

  afterEach(async () => {
    await proxy.close();
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  test("declared calls and relayed tasks/* share one owner key for the proxy's lifetime", async () => {
    await proxy.callTool("observe", {}, undefined, undefined, undefined, { declaresTasks: true });
    await proxy.relayTaskMethod("tasks/get", { taskId: "t-1" }, true);
    await proxy.relayTaskMethod("tasks/cancel", { taskId: "t-1" }, true);

    const ownerKey = client.callToolOptions[0]?.tasks?.ownerKey;
    expect(ownerKey).toStartWith("proxy-tasks:");
    expect(client.relayTaskCalls.map((call) => call.tasks)).toEqual([
      { ownerKey, declared: true },
      { ownerKey, declared: true },
    ]);
  });

  test("an undeclared call carries no relay and mints no owner key", async () => {
    await proxy.callTool("observe", {});

    expect(client.callToolOptions).toEqual([undefined]);
  });

  test("a released binding fences device calls but not task polling", async () => {
    await proxy.callTool("getAndroid", {});
    client.emitNotification(
      SESSION_RELEASED_NOTIFICATION_METHOD,
      ANDROID.sessionUuid,
      "heartbeat-timeout",
    );
    await expect(proxy.callTool("tapOn", { text: "OK" })).rejects.toBeInstanceOf(
      DaemonConnectionSessionReleasedError,
    );

    const polled = await proxy.relayTaskMethod("tasks/get", { taskId: "t-1" }, true);

    expect(polled).toEqual({ resultType: "complete", taskId: "t-1" });
    expect(client.relayTaskCalls).toHaveLength(1);
  });
});
