import { getStaticToolDefinitions } from "../../src/daemon/staticToolDefinitions";
import { withProxyOwnerToken } from "../helpers/proxyOwnerToken";
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  DaemonBoundSessionExpiredError,
  DaemonConnectionSessionReleasedError,
  DaemonMcpProxy,
  DaemonSessionStalledError,
} from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { sessionOwnershipLostPayload } from "../../src/server/deviceSessionResult";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { logger } from "../../src/utils/logger";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { managedEndedPayload } from "../../src/server/proxyServer";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";
import { readyManagedSlotsResult } from "../helpers/refusalWireFixtures";

// #11483 items 2 and 3 (stdio proxy contract): reads after a terminal release. Owner contract: reads are never
// refused and never require a session (#10971, docs/using/device-ownership.md "Read and control").
// Non-managed bindings require one call to report the release before reads go sessionless.
// Managed bindings permit deviceId-named reads immediately while keeping other calls fenced.
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
  /** Set to make the gated `tapOn` fail instead of answering. */
  let tapError: Error | undefined;
  /** The result the daemon answers the gated `tapOn` with. */
  let tapResult: unknown;
  let omitReadArgShapes = false;

  function setupHarness(): void {
    omitReadArgShapes = false;
    timer = new FakeTimer();
    tapGate = undefined;
    tapError = undefined;
    tapResult = undefined;
    client = new FakeDaemonClient({
      daemonMethodResults: new Map<string, unknown>([
        ["resources/list", { resources: [{ uri: BOOTED_URI, name: "Booted devices" }] }],
        ["daemon/capabilities", { capabilities: ["managed-slots/v1"] }],
        ["daemon/acquireManagedSlots", readyManagedSlotsResult(ANDROID.sessionUuid)],
      ]),
      resourceResult: BOOTED,
      onCallTool: async (name) => {
        if (name === "tapOn" && tapGate) {
          await tapGate.promise;
          if (tapError) {
            throw tapError;
          }
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
      staticToolDefinitionsProvider: () =>
        getStaticToolDefinitions().map((definition) => {
          if (!omitReadArgShapes || definition.name !== "clipboard") {
            return definition;
          }
          const meta = { ...definition._meta };
          delete meta["automobile/deviceReadOnlyArgs"];
          return { ...definition, _meta: meta };
        }),
      heartbeatTimeoutMs: 4_000,
      heartbeatIntervalMs: INTERVAL_MS,
    });
  }

  async function closeHarness(): Promise<void> {
    tapGate?.resolve();
    await proxy.close();
    for (const spy of spies) {
      spy.mockRestore();
    }
  }

  beforeAll(async () => {
    // Warm one-off proxy/schema initialization outside the per-test 15ms budget.
    setupHarness();
    try {
      await releaseManagedBinding();
    } finally {
      await closeHarness();
    }
  });
  beforeEach(setupHarness);
  afterEach(closeHarness);

  async function acquireManagedBinding(): Promise<void> {
    expect(proxy.getTerminalSessionRelease()).toBeUndefined();
    const result = await proxy.acquireBindings({
      contractVersion: 1,
      managedHostScope: "host",
      runnerNamespace: "runner",
      runnerIncarnation: "boot",
      localBindingCapacity: 1,
      requests: [
        {
          bindingIndex: 1,
          role: "primary",
          platform: "android",
          requestedSpec: { runtime: "system-images;android-35;google_apis;arm64-v8a" },
        },
      ],
    });
    expect(result.outcome).toBe("ready");
  }

  async function releaseManagedBinding(
    surfaceRelease = true,
    reason = "cleanup-expired",
  ): Promise<void> {
    await acquireManagedBinding();
    client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, ANDROID.sessionUuid, reason);
    if (surfaceRelease) {
      await expect(proxy.callTool("observe", {})).rejects.toBeInstanceOf(
        DaemonBoundSessionExpiredError,
      );
    }
    expect(proxy.getTerminalSessionRelease()).toEqual({
      sessionUuid: ANDROID.sessionUuid,
      reason,
    });
    const copy = proxy.getTerminalSessionRelease()!;
    copy.reason = "changed by caller";
    expect(proxy.getTerminalSessionRelease()?.reason).toBe(reason);
  }

  test.each(["tapOn", "observe"])(
    "the first managed deviceId read succeeds and leaves %s reporting the end",
    async (nextTool) => {
      await releaseManagedBinding(false, "heartbeat-timeout");
      const forwardedBefore = client.callToolCalls.length;
      await expect(
        proxy.callTool("observe", { deviceId: ANDROID.deviceId }),
      ).resolves.toMatchObject({
        content: [{ type: "text", text: "ok" }],
      });
      expect(client.callToolCalls.at(-1)?.params).toEqual(
        withProxyOwnerToken({ deviceId: ANDROID.deviceId }, "fake-1"),
      );
      const answer = await proxy.callTool(nextTool, {}).catch((error: unknown) => error);
      expect(answer).toBeInstanceOf(DaemonBoundSessionExpiredError);
      const ended = answer as DaemonBoundSessionExpiredError;
      expect(
        managedEndedPayload(
          readyManagedSlotsResult(ANDROID.sessionUuid),
          ended.sessionUuid,
          ended.reason,
        ),
      ).toMatchObject({
        error: {
          code: "managed_execution_ended",
          sessionUuid: ANDROID.sessionUuid,
          reason: "heartbeat-timeout",
        },
      });
      expect(client.callToolCalls.length).toBe(forwardedBefore + 1);
    },
  );

  test("a first managed deviceId read does not mark release as surfaced for resources", async () => {
    await releaseManagedBinding(false, "heartbeat-timeout");
    await proxy.callTool("observe", { deviceId: ANDROID.deviceId });
    await expect(proxy.readResource(BOOTED_URI)).rejects.toMatchObject({
      sessionUuid: ANDROID.sessionUuid,
      reason: "heartbeat-timeout",
    });
    expect(client.readResourceCalls).toEqual([]);
    await expect(proxy.readResource(BOOTED_URI)).resolves.toEqual(BOOTED);
  });

  test("a non-managed first deviceId read reports release and its second succeeds", async () => {
    await proxy.callTool("getAndroid", {});
    client.emitNotification(
      SESSION_RELEASED_NOTIFICATION_METHOD,
      ANDROID.sessionUuid,
      "heartbeat-timeout",
    );
    const forwardedBefore = client.callToolCalls.length;
    await expect(proxy.callTool("observe", { deviceId: ANDROID.deviceId })).rejects.toBeInstanceOf(
      DaemonConnectionSessionReleasedError,
    );
    expect(client.callToolCalls.length).toBe(forwardedBefore);
    await expect(proxy.callTool("observe", { deviceId: ANDROID.deviceId })).resolves.toBeDefined();
    expect(client.callToolCalls.at(-1)?.params.sessionUuid).toBeUndefined();
    expect(client.callToolCalls.length).toBe(forwardedBefore + 1);
  });

  test("a managed control naming a deviceId still reports release", async () => {
    await releaseManagedBinding(false, "heartbeat-timeout");
    const forwardedBefore = client.callToolCalls.length;
    await expect(proxy.callTool("tapOn", { deviceId: ANDROID.deviceId })).rejects.toMatchObject({
      sessionUuid: ANDROID.sessionUuid,
      reason: "heartbeat-timeout",
    });
    expect(client.callToolCalls.length).toBe(forwardedBefore);
  });

  test("a managed liveness handover wins over a first deviceId read", async () => {
    await acquireManagedBinding();
    const handovers: string[] = [];
    proxy.onLivenessHandover((handover) => handovers.push(handover.code));
    const call = client.callDaemonMethod.bind(client);
    spies.push(
      spyOn(client, "callDaemonMethod").mockImplementation((method, ...args) =>
        method === "daemon/heartbeat" ? new Promise<never>(() => {}) : call(method, ...args),
      ),
    );
    for (let elapsed = 0; elapsed < 40_000 && handovers.length === 0; elapsed += 250) {
      await timer.advanceTimeAsync(250, () => drainUntilQuiescent(timer));
    }
    expect(handovers).toEqual(["daemon_stalled"]);
    client.emitNotification(
      SESSION_RELEASED_NOTIFICATION_METHOD,
      ANDROID.sessionUuid,
      "heartbeat-timeout",
    );
    expect(proxy.getTerminalSessionRelease()).toMatchObject({ sessionUuid: ANDROID.sessionUuid });
    const forwardedBefore = client.callToolCalls.length;
    const answer = await proxy
      .callTool("observe", { deviceId: ANDROID.deviceId })
      .catch((error: unknown) => error);
    expect(answer).toBeInstanceOf(DaemonSessionStalledError);
    expect(answer).toMatchObject({
      handover: {
        code: "proxy_stalled",
        releaseReasons: {
          [ANDROID.sessionUuid]: "heartbeat-timeout",
        },
      },
    });
    expect(client.callToolCalls.length).toBe(forwardedBefore);
  });

  test("a managed read without a deviceId stays fenced every time after release was reported", async () => {
    await releaseManagedBinding();
    const forwardedBefore = client.callToolCalls.length;
    for (const args of [
      {},
      {},
      { deviceId: "" },
      { deviceId: " \t" },
      { deviceId: 123 },
      { device: "A" },
    ]) {
      const answer = await proxy.callTool("observe", args).catch((error: unknown) => error);
      expect(answer).toBeInstanceOf(DaemonBoundSessionExpiredError);
      expect(answer).toMatchObject({
        sessionUuid: ANDROID.sessionUuid,
        reason: "cleanup-expired",
      });
    }
    expect(client.callToolCalls.length).toBe(forwardedBefore);
  });

  test("a managed read naming a deviceId remains sessionless after release", async () => {
    await releaseManagedBinding();
    const forwardedBefore = client.callToolCalls.length;
    await expect(proxy.callTool("observe", { deviceId: ANDROID.deviceId })).resolves.toBeDefined();
    expect(client.callToolCalls.at(-1)?.params).toEqual(
      withProxyOwnerToken({ deviceId: ANDROID.deviceId }, "fake-1"),
    );
    expect(client.callToolCalls.length).toBe(forwardedBefore + 1);
  });

  test("clipboard get is sessionless after release, while set retains the control fence", async () => {
    await releaseManagedBinding();
    const forwardedBefore = client.callToolCalls.length;
    await expect(
      proxy.callTool("clipboard", { action: "get", deviceId: ANDROID.deviceId }),
    ).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(client.callToolCalls.at(-1)).toEqual({
      toolName: "clipboard",
      params: withProxyOwnerToken({ action: "get", deviceId: ANDROID.deviceId }, "fake-1"),
    });
    for (const [name, args] of [
      ["clipboard", { action: "set", deviceId: ANDROID.deviceId, text: "hello" }],
      ["tapOn", { deviceId: ANDROID.deviceId, text: "OK" }],
    ] as const) {
      await expect(proxy.callTool(name, args)).rejects.toMatchObject({
        sessionUuid: ANDROID.sessionUuid,
        reason: "cleanup-expired",
      });
      await expect(proxy.callTool(name, args)).rejects.toBeInstanceOf(
        DaemonBoundSessionExpiredError,
      );
    }
    expect(client.callToolCalls.length).toBe(forwardedBefore + 1);
  });

  test("older clipboard definitions without argument shapes retain the release fence", async () => {
    omitReadArgShapes = true;
    await releaseManagedBinding();
    const forwardedBefore = client.callToolCalls.length;
    await expect(
      proxy.callTool("clipboard", { action: "get", deviceId: ANDROID.deviceId }),
    ).rejects.toBeInstanceOf(DaemonBoundSessionExpiredError);
    expect(client.callToolCalls.length).toBe(forwardedBefore);
  });

  test("a non-managed result-minted read without a device remains sessionless after release", async () => {
    await proxy.callTool("getAndroid", {});
    client.emitNotification(
      SESSION_RELEASED_NOTIFICATION_METHOD,
      ANDROID.sessionUuid,
      "cleanup-expired",
    );
    await expect(proxy.callTool("observe", {})).rejects.toBeInstanceOf(
      DaemonConnectionSessionReleasedError,
    );
    const forwardedBefore = client.callToolCalls.length;
    await expect(proxy.callTool("observe", {})).resolves.toBeDefined();
    expect(client.callToolCalls.at(-1)?.params.sessionUuid).toBeUndefined();
    expect(client.callToolCalls.length).toBe(forwardedBefore + 1);
  });

  test("a non-managed startup binding still forwards no-device reads after reporting release", async () => {
    await proxy.close();
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    proxy = new DaemonMcpProxy({
      initialSessionUuid: ANDROID.sessionUuid,
      clientFactory: () => client,
      daemonManager,
      autoStartDaemon: false,
      timer,
      idGenerator: new FakeIdGenerator(),
    });
    await proxy.claimInitialSession();
    client.emitNotification(
      SESSION_RELEASED_NOTIFICATION_METHOD,
      ANDROID.sessionUuid,
      "cleanup-expired",
    );
    await expect(proxy.callTool("observe", {})).rejects.toBeInstanceOf(
      DaemonBoundSessionExpiredError,
    );
    const forwardedBefore = client.callToolCalls.length;
    await expect(proxy.callTool("observe", {})).resolves.toBeDefined();
    expect(client.callToolCalls.at(-1)?.params.sessionUuid).toBeUndefined();
    expect(client.callToolCalls.length).toBe(forwardedBefore + 1);
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

  // A call still running when its session is released is cut by the daemon and
  // answered with the typed terminal refusal (docs: "A call still running when its session is
  // released ... is cut and answered with session_ownership_lost"). That answer IS the agent being
  // told, so the next read is forwarded.
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
    await expect(proxy.callTool("observe", { deviceId: ANDROID.deviceId })).resolves.toBeDefined();
    expect(client.callToolCalls.length).toBe(forwardedBefore + 1);
    expect(client.callToolCalls.at(-1)?.params.sessionUuid).toBeUndefined();
  });

  // The same for a call the proxy itself answers: its transport failed after the session was
  // released under it, and the fence raised for that call names the session it lost.
  test("a read is forwarded after a fence raised mid-flight reported the release", async () => {
    await proxy.callTool("getAndroid", {});

    tapGate = Promise.withResolvers<void>();
    tapError = new Error("socket hang up");
    const tap = proxy.callTool("tapOn", { text: "OK" });
    await timer.advanceTimeAsync(0);
    client.emitNotification(
      SESSION_RELEASED_NOTIFICATION_METHOD,
      ANDROID.sessionUuid,
      "explicit-release",
    );
    tapGate.resolve();
    const told = await tap.catch((error: unknown) => error);
    expect(told).toBeInstanceOf(DaemonBoundSessionExpiredError);
    expect((told as DaemonBoundSessionExpiredError).sessionUuid).toBe(ANDROID.sessionUuid);

    const forwardedBefore = client.callToolCalls.length;
    await expect(proxy.callTool("observe", { deviceId: ANDROID.deviceId })).resolves.toBeDefined();
    expect(client.callToolCalls.length).toBe(forwardedBefore + 1);
    expect(client.callToolCalls.at(-1)?.params.sessionUuid).toBeUndefined();
  });
});
