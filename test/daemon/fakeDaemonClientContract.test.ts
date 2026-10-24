import { beforeAll, describe, expect } from "bun:test";
import type { DaemonClientLike } from "../../src/daemon/client";
import type { DaemonNotification } from "../../src/daemon/types";
import { ROUTED_SESSION_META_KEY } from "../../src/daemon/routedSessionMeta";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { KEEPER_INTERVAL_MS, LivenessScenario } from "../helpers/livenessScenarioHarness";
import { warmedTests } from "../helpers/warmedTests";

// #11441: a fake daemon client that answers for the daemon by hand drifts from the daemon. This
// runs one proxy session, from acquisition to its release, twice against the real daemon: once with the
// proxy on the real daemon client, once with it on a `FakeDaemonClient` backed by the daemon
// (`daemon` option). Every request the proxy makes must be answered identically (results,
// refusals and their typed fields), and the same frames must be pushed.

const DEVICE = "emulator-5554";
const TOKEN = "contract-proxy-owner";

interface Exchange {
  request: string;
  params: unknown;
  answer?: unknown;
  refusal?: Record<string, unknown>;
}

/** An error as the proxy can see it: its message and every typed field the daemon attached. */
function refusalOf(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { thrown: String(error) };
  }
  return { ...structuredClone({ ...error }), name: error.name, message: error.message };
}

/** Records what `client` answered for every request the proxy made through it. */
function recording(
  client: DaemonClientLike,
  exchanges: Exchange[],
  pushed: DaemonNotification[],
): DaemonClientLike {
  const record = async (request: string, params: unknown, run: () => Promise<unknown>) => {
    const exchange: Exchange = { request, params: structuredClone(params) };
    exchanges.push(exchange);
    try {
      const answer = await run();
      exchange.answer = structuredClone(answer);
      return answer;
    } catch (error) {
      exchange.refusal = refusalOf(error);
      throw error;
    }
  };
  return {
    connect: (timeoutMs, signal) => client.connect(timeoutMs, signal),
    close: () => client.close(),
    callTool: (name, params, progressToken, onRequestId, signal) =>
      record(`tools/call ${name}`, params, () =>
        client.callTool(name, params, progressToken, onRequestId, signal),
      ),
    readResource: (uri, params, options) =>
      record(`resources/read ${uri}`, params, () => client.readResource(uri, params, options)),
    callDaemonMethod: (method, params, options) =>
      record(method, params, () => client.callDaemonMethod(method, params, options)),
    onNotification: (handler) =>
      client.onNotification!((notification) => {
        pushed.push(structuredClone(notification));
        handler(notification);
      }),
    subscribeToNotifications: async () => {
      await record("daemon/subscribe-notifications", {}, () => client.subscribeToNotifications!());
    },
    onConnectionClosed: (handler) => client.onConnectionClosed!(handler),
  };
}

let scenario: LivenessScenario | undefined;

type ProxyRun = Awaited<ReturnType<typeof proxySession>>;
/** The session through the real client: the reference the fake is compared against, run once. */
let real: ProxyRun;
// Declared before warmedTests so its warm-up already finds the reference; the real session is
// one daemon start and one full session, so it stays out of the measured time of the row that
// compares against it.
beforeAll(async () => {
  real = await proxySession((daemon) => daemon);
  await scenario?.stop();
  scenario = undefined;
});

// The first run's module warm-up stays out of the measured time.
const test = warmedTests(async () => {
  await scenario?.stop();
  scenario = undefined;
});

/** One proxy session against a fresh real daemon, from acquisition to its release. */
async function proxySession(client: (daemon: DaemonClientLike) => DaemonClientLike) {
  const exchanges: Exchange[] = [];
  const pushed: DaemonNotification[] = [];
  scenario = await LivenessScenario.start();
  const proxy = scenario.addProxy({
    token: TOKEN,
    client: (daemon) => recording(client(daemon), exchanges, pushed),
  });
  const outcome = (call: Promise<unknown>) =>
    call.then(
      (result) => ({ result }),
      (error: unknown) => ({ refusal: refusalOf(error) }),
    );
  const told: unknown[] = [];

  const acquired = await proxy.callTool("getAndroid", { deviceId: DEVICE });
  const session = JSON.parse(acquired.content[0].text).runtime.session.sessionUuid as string;
  // Heartbeat acks, a control call (activity echo), a read (no echo) and a selector call.
  await scenario.idle(3 * KEEPER_INTERVAL_MS);
  told.push(await outcome(proxy.callTool("homeScreen", { sessionUuid: session })));
  told.push(await outcome(proxy.callTool("observe", { sessionUuid: session })));
  told.push(await outcome(proxy.callTool("rotate", { deviceId: DEVICE, orientation: "portrait" })));
  // A typed refusal: a session the daemon never issued.
  told.push(await outcome(proxy.callTool("homeScreen", { sessionUuid: "never-issued" })));
  // The session is released under the proxy: the pushed frame, then the refused call after.
  await scenario.daemonMethod("daemon/releaseSession", { sessionId: session });
  await scenario.idle(2 * KEEPER_INTERVAL_MS);
  told.push(await outcome(proxy.callTool("homeScreen", { sessionUuid: session })));

  await scenario.stop();
  scenario = undefined;
  return { session, exchanges, pushed, told };
}

describe("FakeDaemonClient backed by the daemon answers as the daemon does (#11441)", () => {
  test("a proxy session gets the same answers, refusals and pushed frames through the fake as through the real client", async () => {
    const fakes: FakeDaemonClient[] = [];
    const faked = await proxySession((daemon) => {
      const fake = new FakeDaemonClient({ daemon });
      fakes.push(fake);
      return fake;
    });

    expect(faked.exchanges).toEqual(real.exchanges);
    expect(faked.pushed).toEqual(real.pushed);
    expect(faked.told).toEqual(real.told);

    // The run exercised what a hand-written fake gets wrong, so the equality above is about
    // real answers: acks that carry the daemon's idle instant, the activity echo, the pushed
    // release frame, and typed refusals.
    const answersTo = (request: string) =>
      real.exchanges.filter((exchange) => exchange.request === request);
    const beats = answersTo("daemon/heartbeat");
    expect(
      beats.some((beat) => typeof Reflect.get(beat.answer ?? {}, "idleReleaseAt") === "number"),
    ).toBe(true);
    const control = answersTo("tools/call homeScreen")[0]?.answer as { _meta?: object };
    expect(Reflect.get(control._meta ?? {}, ROUTED_SESSION_META_KEY)).toBe(real.session);
    const read = answersTo("tools/call observe")[0]?.answer as { _meta?: object };
    expect(Reflect.get(read._meta ?? {}, ROUTED_SESSION_META_KEY)).toBeUndefined();
    expect(real.pushed.map((frame) => [frame.method, frame.sessionId])).toContainEqual([
      "notifications/session/released",
      real.session,
    ]);
    // A refusal the daemon answered (a session it never issued) and one the proxy built from the
    // pushed release frame.
    expect(JSON.stringify(real.told)).toContain("is not an active daemon session");
    expect(real.told.at(-1)).toMatchObject({
      refusal: { name: "DaemonBoundSessionExpiredError", reason: "explicit-release" },
    });
    // The fake still recorded the proxy's requests, as its unrouted form does.
    expect(fakes.flatMap((fake) => fake.callToolCalls.map((call) => call.toolName))).toContain(
      "homeScreen",
    );
  });

  test("the same request is refused identically by the real client and the fake: a heartbeat for a released session names the release", async () => {
    scenario = await LivenessScenario.start();
    const released = await scenario.acquireTokenless();
    await scenario.daemonMethod("daemon/releaseSession", { sessionId: released });
    const real = scenario.daemonConnection("contract-real");
    const fake = new FakeDaemonClient({ daemon: scenario.daemonConnection("contract-fake") });
    await real.connect();
    await fake.connect();
    const refused = (client: DaemonClientLike, sessionId: string) =>
      client.callDaemonMethod("daemon/heartbeat", { sessionId }).then(
        () => undefined,
        (error: unknown) => refusalOf(error),
      );

    for (const sessionId of [released, "never-issued"]) {
      const fromDaemon = await refused(real, sessionId);
      expect(fromDaemon).toMatchObject({ code: "daemon_session_not_found" });
      expect(await refused(fake, sessionId)).toEqual(fromDaemon!);
    }
    expect(await refused(real, released)).toHaveProperty("releaseReason");
  });

  test("a scripted answer and a hook still win over the daemon, and a pushed frame arrives unchanged", async () => {
    scenario = await LivenessScenario.start();
    const frames: DaemonNotification[] = [];
    const fake = new FakeDaemonClient({
      daemon: scenario.daemonConnection("contract-scripted"),
      toolResultFor: (tool) =>
        tool === "homeScreen" ? { content: [], scripted: true } : undefined,
      daemonMethodResults: new Map([["daemon/tokenOwnedSessions", { sessions: ["scripted"] }]]),
      onCallDaemonMethod: (method) =>
        method === "daemon/releaseSession" ? { hooked: true } : undefined,
    });
    fake.onNotification((frame) => frames.push(frame));
    await fake.connect();

    expect(await fake.callTool("homeScreen", { sessionUuid: "any" })).toEqual({
      content: [],
      scripted: true,
    });
    expect(await fake.callDaemonMethod("daemon/tokenOwnedSessions", {})).toEqual({
      sessions: ["scripted"],
    });
    expect(await fake.callDaemonMethod("daemon/releaseSession", { sessionId: "any" })).toEqual({
      hooked: true,
    });

    const release = {
      sessionId: "s",
      deviceId: DEVICE,
      releaseReason: "idle-timeout",
      releasedAtMs: 1,
      terminal: true,
      heartbeat: { lastHeartbeatMs: 1, hasReceivedHeartbeat: true, timeoutMs: 1_000, ageMs: 0 },
    };
    fake.emitNotification(
      "notifications/session/released",
      "s",
      "idle-timeout",
      release,
      undefined,
      ["recording-1"],
    );
    expect(frames).toEqual([
      {
        type: "daemon_notification",
        method: "notifications/session/released",
        recordingIds: ["recording-1"],
        sessionId: "s",
        reason: "idle-timeout",
        release,
      },
    ]);
    await fake.close();
  });
});
