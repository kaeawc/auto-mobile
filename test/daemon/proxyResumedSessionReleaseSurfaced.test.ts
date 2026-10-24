import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  DaemonBoundSessionExpiredError,
  DaemonConnectionSessionReleasedError,
  DaemonMcpProxy,
  DaemonSessionStalledError,
} from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/wire/constants";
import type { LivenessHandover } from "../../src/daemon/proxyLivenessRecovery";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/daemon/sessionReleaseBroadcast";
import { logger } from "../../src/utils/logger";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

// Stdio proxy session bookkeeping (#12045): a session that was handed over for a daemon stall and then
// resumed with the same UUID keeps the proxy's "this release was already reported" marker
// (`releaseSurfacedFor`) from the handover. When the daemon later releases that session for good,
// the first sessionless read is forwarded with no session and the agent is never told the session
// ended. Contract (#11483, isSessionlessReadAfterRelease): a read is forwarded without a session
// only "once the binding is released and ONE call has been told so".

const LEASE_MS = 10_000;
const INTERVAL_MS = 2_000;
const SESSION = "android-session";
const DEVICE = "emulator-5554";

class LivenessTimer extends FakeTimer {
  override advanceTimeAsync(ms: number): Promise<void> {
    return super.advanceTimeAsync(ms, () => drainUntilQuiescent(this));
  }
}

describe("a release after a stall resume is reported before reads go sessionless", () => {
  let timer: LivenessTimer;
  let proxy: DaemonMcpProxy;
  let clients: FakeDaemonClient[];
  let handovers: LivenessHandover[];
  let daemonSilent: boolean;
  let spies: Array<ReturnType<typeof spyOn>>;

  const latest = (): FakeDaemonClient => clients[clients.length - 1]!;
  const observeForwards = (): Array<Record<string, unknown>> =>
    clients.flatMap((client) =>
      client.callToolCalls.filter((call) => call.toolName === "observe").map((call) => call.params),
    );

  beforeEach(() => {
    timer = new LivenessTimer();
    clients = [];
    handovers = [];
    daemonSilent = false;
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    spies = [
      spyOn(DaemonClient, "isAvailable").mockResolvedValue(true),
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
    ];
    proxy = new DaemonMcpProxy({
      clientFactory: () => {
        const client = new FakeDaemonClient({
          toolResultFor: (name) =>
            name === "getAndroid"
              ? {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        platform: "android",
                        runtime: { deviceId: DEVICE, session: { sessionUuid: SESSION } },
                      }),
                    },
                  ],
                }
              : { content: [{ type: "text", text: "ok" }] },
          onCallDaemonMethod: (method) =>
            method === "daemon/heartbeat" && daemonSilent
              ? new Promise<never>(() => {})
              : undefined,
        });
        clients.push(client);
        return client;
      },
      daemonManager,
      autoStartDaemon: false,
      timer,
      idGenerator: new FakeIdGenerator(["proxy-token"]),
      heartbeatTimeoutMs: LEASE_MS,
      heartbeatIntervalMs: INTERVAL_MS,
    });
    proxy.onLivenessHandover((handover) => handovers.push(handover));
  });

  afterEach(async () => {
    await proxy.close();
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  async function settle<T>(pending: Promise<T>): Promise<T> {
    let done = false;
    const tracked = pending.finally(() => {
      done = true;
    });
    tracked.catch(() => {});
    for (let elapsed = 0; elapsed < 20_000 && !done; elapsed += 250) {
      await timer.advanceTimeAsync(250);
    }
    return tracked;
  }

  function releaseForIdle(): void {
    latest().emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, SESSION, "cleanup-expired");
  }

  test("control: with no stall, the first sessionless read after an idle release is told", async () => {
    await proxy.callTool("getAndroid", {});
    releaseForIdle();

    await expect(proxy.callTool("observe", {})).rejects.toBeInstanceOf(
      DaemonConnectionSessionReleasedError,
    );
    expect(observeForwards()).toEqual([]);
    await proxy.callTool("observe", {});
    expect(observeForwards()).toHaveLength(1);
    expect(observeForwards()[0]).not.toHaveProperty("sessionUuid");
  });

  /** Stall the daemon to a reported `daemon_stalled` handover, then resume the session by name. */
  async function stallReportAndResume(): Promise<number> {
    await proxy.callTool("getAndroid", {});

    // The daemon stops answering heartbeats: recovery runs out and hands the session over.
    daemonSilent = true;
    for (let elapsed = 0; elapsed < 40_000 && handovers.length === 0; elapsed += 250) {
      await timer.advanceTimeAsync(250);
    }
    expect(handovers.map((handover) => handover.code)).toEqual(["daemon_stalled"]);
    // One call is told about the handover (this is what marks the "release" as surfaced).
    await expect(settle(proxy.callTool("observe", {}))).rejects.toBeInstanceOf(
      DaemonSessionStalledError,
    );

    // The daemon answers again; the harness resumes the session by naming it (#10989).
    daemonSilent = false;
    await settle(proxy.callTool("observe", { sessionUuid: SESSION }));
    expect(proxy.getTerminalSessionRelease()).toBeUndefined();
    await proxy.callTool("observe", {});
    const forwardedWhileLive = observeForwards().length;
    expect(forwardedWhileLive).toBe(2);
    return forwardedWhileLive;
  }

  test("control: with no stall, the first sessionless resource read after an idle release is told", async () => {
    await proxy.callTool("getAndroid", {});
    releaseForIdle();

    await expect(proxy.readResource("automobile:devices/booted")).rejects.toBeInstanceOf(
      DaemonConnectionSessionReleasedError,
    );
    expect(clients.flatMap((client) => client.readResourceCalls)).toEqual([]);
    await proxy.readResource("automobile:devices/booted");
    expect(clients.flatMap((client) => client.readResourceCalls)).toEqual([
      "automobile:devices/booted",
    ]);
    expect(clients.flatMap((client) => client.readResourceParams)).toEqual([{}]);
  });

  test("after a reported stall and a resume, the first sessionless resource read after the idle release is still told", async () => {
    await stallReportAndResume();
    releaseForIdle();

    const read = await proxy.readResource("automobile:devices/booted").then(
      () => "forwarded",
      (error: unknown) => error,
    );
    expect(clients.flatMap((client) => client.readResourceCalls)).toEqual([]);
    expect(read).toBeInstanceOf(DaemonConnectionSessionReleasedError);
    expect(read).toMatchObject({ reason: "cleanup-expired" });
    await proxy.readResource("automobile:devices/booted");
    expect(clients.flatMap((client) => client.readResourceCalls)).toEqual([
      "automobile:devices/booted",
    ]);
    expect(clients.flatMap((client) => client.readResourceParams)).toEqual([{}]);
  });

  test("after a daemon_stalled handover was reported and the session resumed, its later idle release is still told to the first read", async () => {
    const forwardedWhileLive = await stallReportAndResume();

    // Much later the daemon releases the session for good (its idle window ran out).
    releaseForIdle();
    expect(proxy.getTerminalSessionRelease()).toEqual({
      sessionUuid: SESSION,
      reason: "cleanup-expired",
    });

    // Nobody has been told about THIS release yet, so the first read must report it, exactly as
    // in the control above, and must not be forwarded with no session.
    const firstReadAfterRelease = await proxy.callTool("observe", {}).then(
      (result) => ({ forwarded: true as const, result }),
      (error: unknown) => ({ forwarded: false as const, error }),
    );
    expect(observeForwards().slice(forwardedWhileLive)).toEqual([]);
    expect(firstReadAfterRelease.forwarded).toBe(false);
    expect(
      !firstReadAfterRelease.forwarded &&
        (firstReadAfterRelease.error instanceof DaemonConnectionSessionReleasedError ||
          firstReadAfterRelease.error instanceof DaemonBoundSessionExpiredError),
    ).toBe(true);
    expect(!firstReadAfterRelease.forwarded && firstReadAfterRelease.error).toMatchObject({
      reason: "cleanup-expired",
    });
    await proxy.callTool("observe", {});
    const afterRelease = observeForwards().slice(forwardedWhileLive);
    expect(afterRelease).toHaveLength(1);
    expect(afterRelease[0]).not.toHaveProperty("sessionUuid");
  });
});
