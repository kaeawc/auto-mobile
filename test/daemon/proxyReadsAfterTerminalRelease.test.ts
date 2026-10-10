import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  DaemonConnectionSessionReleasedError,
  DaemonMcpProxy,
} from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { logger } from "../../src/utils/logger";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

// #11483 items 2 and 3 (stdio proxy contract): reads after a terminal release. Owner contract: reads are never
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

describe("reads after a terminal release of a result-minted session (#11483)", () => {
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

  // After an idle release the proxy keeps `resources/list` working (it lists the unbound surface,
  // #9997) and forwards the `listDevices` tool; a `resources/read` of a resource it just listed
  // must be served too. The booted-device inventory is session-independent and is what an agent
  // reads to decide which device to acquire next.
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

    await expect(proxy.readResource(BOOTED_URI)).resolves.toEqual(BOOTED);
    expect(client.readResourceCalls).toEqual([BOOTED_URI]);
    expect(client.readResourceParams.at(-1)).toEqual({});
  });

  test("a resource read is refused until one call was told, and a read naming the released session stays refused", async () => {
    await proxy.callTool("getAndroid", {});
    client.emitNotification(
      SESSION_RELEASED_NOTIFICATION_METHOD,
      ANDROID.sessionUuid,
      "lazy-expiry",
    );

    // The first read is the call that is told; it is answered with the typed refusal.
    await expect(proxy.readResource(BOOTED_URI)).rejects.toBeInstanceOf(
      DaemonConnectionSessionReleasedError,
    );
    await expect(proxy.readResource(BOOTED_URI)).resolves.toEqual(BOOTED);

    // The released session's own observation went with it: that read keeps the typed answer.
    await expect(
      proxy.readResource(`automobile:observation/session/${ANDROID.sessionUuid}/latest`),
    ).rejects.toBeInstanceOf(DaemonConnectionSessionReleasedError);
    expect(client.readResourceCalls).toEqual([BOOTED_URI]);
  });
});
