import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../../src/daemon/client";
import { DAEMON_VERSION } from "../../../src/daemon/constants";
import { sessionOwnershipLostPayload } from "../../../src/server/deviceSessionResult";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../../src/server/sessionReleaseBroadcast";
import { logger } from "../../../src/utils/logger";
import { FakeDaemonManager } from "../../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";

// Hunt (stdio proxy contract): reads after a terminal release. Owner contract: reads are never
// refused and never require a session (#10971, docs/using/device-ownership.md "Read and control").
// The proxy's own rule (isSessionlessReadAfterRelease) is narrower still: once the binding is
// released and ONE call has been told so, a read that names no session is forwarded without one.
// The harness is the one test/daemon/proxySelectorRoutedSessionActivity.test.ts uses (#10971 block).

const INTERVAL_MS = 2_000;
const ANDROID = { sessionUuid: "android-session", deviceId: "emulator-5554" };
const BOOTED_URI = "automobile:devices/booted";
const BOOTED = {
  contents: [{ uri: BOOTED_URI, mimeType: "application/json", text: '{"devices":[]}' }],
};

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

describe("hunt: reads after a terminal release of a result-minted session", () => {
  let timer: FakeTimer;
  let client: FakeDaemonClient;
  let proxy: DaemonMcpProxy;
  let spies: Array<ReturnType<typeof spyOn>>;
  /** Set to hold the next `tapOn` in flight until the test answers it. */
  let tapGate: PromiseWithResolvers<void> | undefined;
  /** The result the daemon answers the gated `tapOn` with. */
  let tapResult: unknown;

  beforeEach(() => {
    timer = new FakeTimer();
    tapGate = undefined;
    tapResult = undefined;
    client = new FakeDaemonClient({
      daemonMethodResults: new Map<string, unknown>([
        ["resources/list", { resources: [{ uri: BOOTED_URI, name: "Booted devices" }] }],
      ]),
      resourceResult: BOOTED,
      onCallTool: async (name) => {
        if (name === "tapOn" && tapGate) {
          await tapGate.promise;
        }
      },
      toolResultFor: (name) =>
        name === "getAndroid"
          ? deviceStartResult()
          : name === "tapOn" && tapResult !== undefined
            ? tapResult
            : { content: [{ type: "text", text: "ok" }] },
    });
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    spies = [
      spyOn(DaemonClient, "isAvailable").mockResolvedValue(true),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
    ];
    proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager,
      autoStartDaemon: false,
      timer,
      idGenerator: new FakeIdGenerator(),
      heartbeatTimeoutMs: 4_000,
      heartbeatIntervalMs: INTERVAL_MS,
    });
  });

  afterEach(async () => {
    tapGate?.resolve();
    await proxy.close();
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  // Finding A. After an idle release the proxy keeps `resources/list` working (it lists the
  // unbound surface, #9997) and forwards the `listDevices` tool, but every `resources/read` of a
  // resource it just listed is refused with no_active_device_session, on every attempt, until the
  // agent acquires a device again. The booted-device inventory is session-independent and is what
  // an agent reads to decide which device to acquire next.
  test("the booted-device inventory resource is readable after the release was reported", async () => {
    await proxy.callTool("getAndroid", {});
    client.emitNotification(
      SESSION_RELEASED_NOTIFICATION_METHOD,
      ANDROID.sessionUuid,
      "lazy-expiry",
    );

    // One call is told about the release.
    await expect(proxy.callTool("tapOn", { text: "OK" })).rejects.toThrow(/released/);

    // The surfaces that already agree: the list names the resource, and the tool form is served.
    expect((await proxy.listResources()).map((resource) => resource.uri)).toEqual([BOOTED_URI]);
    await expect(proxy.callTool("listDevices", {})).resolves.toBeDefined();
    await expect(proxy.callTool("observe", { deviceId: ANDROID.deviceId })).resolves.toBeDefined();

    // FAILS: rejects with DaemonConnectionSessionReleasedError ("No active device session").
    await expect(proxy.readResource(BOOTED_URI)).resolves.toEqual(BOOTED);
    expect(client.readResourceCalls).toEqual([BOOTED_URI]);
    expect(client.readResourceParams.at(-1)?.sessionUuid).toBeUndefined();
  });

  // Finding B. A call still running when its session is released is cut by the daemon and
  // answered with the typed terminal refusal (docs: "A call still running when its session is
  // released ... is cut and answered with session_ownership_lost"). That answer IS the agent being
  // told. The proxy does not count it: the next read is refused once more before reads go through.
  test("a read is forwarded after the daemon's cut-call answer already reported the release", async () => {
    await proxy.callTool("getAndroid", {});

    // A control call is in flight when another party releases the session explicitly.
    tapGate = Promise.withResolvers<void>();
    const tap = proxy.callTool("tapOn", { text: "OK" });
    await timer.advanceTimeAsync(0);
    expect(client.callToolCalls.at(-1)?.toolName).toBe("tapOn");
    client.emitNotification(
      SESSION_RELEASED_NOTIFICATION_METHOD,
      ANDROID.sessionUuid,
      "explicit-release",
    );
    // The daemon's answer to the cut call (src/server/index.ts sessionReleasedDuringCallPayload).
    tapResult = {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            sessionOwnershipLostPayload({
              message: `Session ${ANDROID.sessionUuid} was released while this call was running.`,
              sessionUuid: ANDROID.sessionUuid,
              reason: "explicit-release",
            }),
          ),
        },
      ],
    };
    tapGate.resolve();
    const told = await tap;
    expect(JSON.parse(told.content[0].text).error).toMatchObject({
      code: "session_ownership_lost",
      nextAction: "acquire_new_session",
      sessionUuid: ANDROID.sessionUuid,
    });

    // The agent was told. Its next read needs no session and must be forwarded.
    const forwardedBefore = client.callToolCalls.length;
    // FAILS: rejects with DaemonConnectionSessionReleasedError; nothing is forwarded.
    await expect(proxy.callTool("observe", { deviceId: ANDROID.deviceId })).resolves.toBeDefined();
    expect(client.callToolCalls.length).toBe(forwardedBefore + 1);
    expect(client.callToolCalls.at(-1)?.params.sessionUuid).toBeUndefined();
  });
});
