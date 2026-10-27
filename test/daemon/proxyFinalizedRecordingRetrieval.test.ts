import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/wire/constants";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/daemon/sessionReleaseBroadcast";
import { logger } from "../../src/utils/logger";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

// #11362: an idle release stops the recording and is terminal for the connection, but the agent
// that started it must still retrieve the finalized artifact, before or after it reacquires.

const FIRST = "recording-owner-session";
const SECOND = "reacquired-session";
const FOREIGN = "someone-elses-session";
const RECORDING = "recording-1";
const IDLE = "idle-timeout";

describe("retrieving a finalized recording behind the proxy after a terminal release", () => {
  let timer: FakeTimer;
  let client: FakeDaemonClient;
  let proxy: DaemonMcpProxy;
  let acquired: string;
  let isAvailableSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let infoSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    timer = new FakeTimer();
    acquired = FIRST;
    client = new FakeDaemonClient({
      toolResultFor: (name) =>
        name === "getAndroid"
          ? {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ runtime: { session: { sessionUuid: acquired } } }),
                },
              ],
            }
          : undefined,
    });
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    infoSpy = spyOn(logger, "info").mockImplementation(() => {});
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager,
      autoStartDaemon: false,
      timer,
      idGenerator: new FakeIdGenerator(),
      heartbeatTimeoutMs: 4_000,
      heartbeatIntervalMs: 2_000,
    });
  });

  afterEach(async () => {
    await proxy.close();
    isAvailableSpy.mockRestore();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  function release(sessionUuid: string, recordingIds?: string[]): void {
    client.emitNotification(
      SESSION_RELEASED_NOTIFICATION_METHOD,
      sessionUuid,
      IDLE,
      undefined,
      undefined,
      recordingIds,
    );
  }

  const stop = (args: Record<string, unknown> = {}) =>
    proxy.callTool("videoRecording", { action: "stop", recordingId: RECORDING, ...args });

  function stopCalls() {
    return client.callToolCalls.filter((call) => call.toolName === "videoRecording");
  }

  test("a fenced connection forwards the retrieval under the session that started the recording", async () => {
    await proxy.callTool("getAndroid", {});
    release(FIRST, [RECORDING]);

    await expect(stop()).resolves.toBeDefined();

    expect(stopCalls()).toEqual([
      {
        toolName: "videoRecording",
        params: expect.objectContaining({
          action: "stop",
          recordingId: RECORDING,
          sessionUuid: FIRST,
        }),
      },
    ]);
  });

  test("after a reacquire the retrieval still names the starting session, not the new binding", async () => {
    await proxy.callTool("getAndroid", {});
    release(FIRST, [RECORDING]);
    acquired = SECOND;
    await proxy.callTool("getAndroid", {});

    await expect(stop()).resolves.toBeDefined();
    await expect(stop({ sessionUuid: SECOND })).resolves.toBeDefined();

    expect(stopCalls().map((call) => call.params.sessionUuid)).toEqual([FIRST, FIRST]);
  });

  test("a retrieval does not rebind, hold or un-fence the released session", async () => {
    await proxy.callTool("getAndroid", {});
    release(FIRST, [RECORDING]);
    await stop();

    await expect(proxy.callTool("observe", {})).rejects.toBeDefined();
    await expect(
      proxy.callTool("videoRecording", { action: "start", platform: "android" }),
    ).rejects.toBeDefined();
    expect(client.callToolCalls.map((call) => call.toolName)).toEqual([
      "getAndroid",
      "videoRecording",
    ]);
  });

  test("a recording this connection was not told about is still refused by the fence", async () => {
    await proxy.callTool("getAndroid", {});
    release(FIRST, [RECORDING]);

    await expect(stop({ recordingId: "someone-elses-recording" })).rejects.toBeDefined();
    await expect(
      proxy.callTool("videoRecording", { action: "stop", platform: "android" }),
    ).rejects.toBeDefined();
    expect(stopCalls()).toEqual([]);
  });

  test("a release of a session this connection never held teaches it nothing", async () => {
    await proxy.callTool("getAndroid", {});
    release(FOREIGN, [RECORDING]);
    release(FIRST);

    await expect(stop()).rejects.toBeDefined();
    expect(stopCalls()).toEqual([]);
  });

  test("a release of a derived label session of a held session is remembered under that key", async () => {
    await proxy.callTool("getAndroid", {});
    release(`${FIRST}:left`, [RECORDING]);
    release(FIRST);

    await expect(stop()).resolves.toBeDefined();
    expect(stopCalls().map((call) => call.params.sessionUuid)).toEqual([`${FIRST}:left`]);
  });
});
