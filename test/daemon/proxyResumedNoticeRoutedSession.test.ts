import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import {
  DAEMON_STALL_RESUMED_CODE,
  type LivenessHandover,
} from "../../src/daemon/proxyLivenessRecovery";
import { logger } from "../../src/utils/logger";
import { isMarkedToolFailure, markToolFailure } from "../../src/utils/toolFailureSignal";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

// Stdio proxy session bookkeeping (#12046): one connection holds an Android and an iOS session. Both are
// handed over as `daemon_stalled` and both are resumed when the daemon answers again. #10989: "the
// first call to reach a session resumed after a daemon_stalled handover carries the warning that
// it resumed". The warning is looked up from the caller's raw args, falling back to the latest
// binding, so a call the proxy routes to the HELD session by its platform (#11907) is given the
// LATEST binding's warning, and each session's own first call is told nothing or the wrong thing.

const LEASE_MS = 10_000;
const INTERVAL_MS = 2_000;
const ANDROID = { sessionUuid: "android-session", deviceId: "emulator-5554", platform: "android" };
const IOS = { sessionUuid: "ios-session", deviceId: "sim-1", platform: "ios" };

class LivenessTimer extends FakeTimer {
  override advanceTimeAsync(ms: number): Promise<void> {
    return super.advanceTimeAsync(ms, () => drainUntilQuiescent(this));
  }
}

function deviceStartResult(session: typeof ANDROID) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          platform: session.platform,
          runtime: { deviceId: session.deviceId, session: { sessionUuid: session.sessionUuid } },
        }),
      },
    ],
  };
}

/** The `daemon_stall_resumed` warnings a tool result carries, by the session each one names. */
function resumedWarningSessions(result: unknown): string[] {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.flatMap((block) => {
    if (block.type !== "text" || !block.text?.includes(DAEMON_STALL_RESUMED_CODE)) {
      return [];
    }
    const parsed = JSON.parse(block.text) as { warning?: { code?: string; sessionUuid?: string } };
    return parsed.warning?.code === DAEMON_STALL_RESUMED_CODE && parsed.warning.sessionUuid
      ? [parsed.warning.sessionUuid]
      : [];
  });
}

describe("the resumed-session warning reaches the session's own first call", () => {
  let timer: LivenessTimer;
  let proxy: DaemonMcpProxy;
  let clients: FakeDaemonClient[];
  let handovers: LivenessHandover[];
  let daemonSilent: boolean;
  let toolResult: { content: Array<{ type: string; text: string }> };
  let spies: Array<ReturnType<typeof spyOn>>;

  const tapForwards = (): Array<Record<string, unknown>> =>
    clients.flatMap((client) =>
      client.callToolCalls.filter((call) => call.toolName === "tapOn").map((call) => call.params),
    );

  beforeEach(async () => {
    timer = new LivenessTimer();
    clients = [];
    handovers = [];
    daemonSilent = false;
    toolResult = { content: [{ type: "text", text: "ok" }] };
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
              ? deviceStartResult(ANDROID)
              : name === "getApple"
                ? deviceStartResult(IOS)
                : toolResult,
          onCallDaemonMethod: (method) => {
            if (method !== "daemon/heartbeat") {
              return undefined;
            }
            // The same daemon process throughout: it stalls, then answers again.
            return daemonSilent ? new Promise<never>(() => {}) : { daemonInstance: "daemon-1" };
          },
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

    await proxy.callTool("getAndroid", {});
    await proxy.callTool("getApple", {});
    await timer.advanceTimeAsync(INTERVAL_MS);

    daemonSilent = true;
    for (let elapsed = 0; elapsed < 60_000 && handovers.length === 0; elapsed += 250) {
      await timer.advanceTimeAsync(250);
    }
    expect(handovers.map((handover) => handover.code)).toEqual(["daemon_stalled"]);
    expect(handovers[0]!.sessions.map((session) => session.sessionUuid).sort()).toEqual([
      ANDROID.sessionUuid,
      IOS.sessionUuid,
    ]);

    // The daemon answers again: the stall probe resumes both sessions with their UUIDs.
    daemonSilent = false;
    await timer.advanceTimeAsync(INTERVAL_MS * 2);
    expect(proxy.getTerminalSessionRelease()).toBeUndefined();
  });

  afterEach(async () => {
    await proxy.close();
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  test.each([true, false])(
    "routes each session's warning and preserves the failure mark: %s",
    async (marked) => {
      if (marked) {
        markToolFailure(toolResult);
      }
      // A deviceId selector reaches daemon routing without a UUID and leaves both notices pending.
      const selectorResult = await proxy.callTool("observe", { deviceId: ANDROID.deviceId });
      expect(clients.at(-1)!.callToolCalls.at(-1)).toMatchObject({ toolName: "observe" });
      expect(clients.at(-1)!.callToolCalls.at(-1)!.params).not.toHaveProperty("sessionUuid");
      expect(resumedWarningSessions(selectorResult)).toEqual([]);

      // First call to reach the Android session: the proxy routes it there by platform.
      const androidResult = await proxy.callTool("tapOn", { platform: "android", text: "OK" });
      expect(tapForwards().at(-1)?.sessionUuid).toBe(ANDROID.sessionUuid);
      // First call to reach the iOS session (the latest binding).
      const iosResult = await proxy.callTool("tapOn", { text: "OK" });
      expect(tapForwards().at(-1)?.sessionUuid).toBe(IOS.sessionUuid);

      for (const result of [androidResult, iosResult]) {
        expect(isMarkedToolFailure(result)).toBe(marked);
        expect(result).toEqual({
          ...toolResult,
          content: [...toolResult.content, expect.objectContaining({ type: "text" })],
        });
        expect(Reflect.ownKeys(result as object)).toEqual(["content"]);
        const content = (result as typeof toolResult).content;
        expect(content).not.toBe(toolResult.content);
        expect(isMarkedToolFailure(content)).toBe(marked);
        expect(Reflect.ownKeys(content)).toEqual(["0", "1", "length"]);
      }

      expect({
        android: resumedWarningSessions(androidResult),
        ios: resumedWarningSessions(iosResult),
      }).toEqual({
        android: [ANDROID.sessionUuid],
        ios: [IOS.sessionUuid],
      });

      const androidAgain = await proxy.callTool("tapOn", { platform: "android", text: "OK" });
      expect(tapForwards().at(-1)?.sessionUuid).toBe(ANDROID.sessionUuid);
      const iosAgain = await proxy.callTool("tapOn", { text: "OK" });
      expect(tapForwards().at(-1)?.sessionUuid).toBe(IOS.sessionUuid);
      expect(resumedWarningSessions(androidAgain)).toEqual([]);
      expect(resumedWarningSessions(iosAgain)).toEqual([]);
    },
  );
});
