import { describe, expect, test } from "bun:test";
import {
  MAX_WATCH_APP_STATE_BUNDLES,
  readWatchAppStates,
  RunnerWatchForegroundProbe,
} from "../../../src/features/watch/WatchForegroundApps";
import type { WatchCommand } from "../../../src/features/watch/WatchRunnerClient";
import { WatchRunnerError } from "../../../src/features/watch/WatchRunnerError";
import { WebSocketWatchRunnerClient } from "../../../src/features/watch/WatchRunnerClient";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWatchRunnerClient } from "../../fakes/FakeWatchRunnerClient";
import { FakeWatchSocket } from "../../fakes/FakeWatchSocket";
// Verbatim runner replies captured on a watchOS 27.2 simulator (#19359).
import runnerInFront from "../../fixtures/watchos-xcuitest/app-states-runner-foreground-watchos27.json";
import settingsInFront from "../../fixtures/watchos-xcuitest/app-states-settings-foreground-watchos27.json";
import clockFace from "../../fixtures/watchos-xcuitest/app-states-clock-face-watchos27.json";

const RUNNER = "dev.jasonpearson.automobile.ctrlproxy.watch";
const SETTINGS = "com.apple.NanoSettings";
const CALCULATOR = "com.apple.NanoCalculator.watchkitapp";
const LISTED = [RUNNER, SETTINGS, CALCULATOR];
const CAROUSEL = "com.apple.Carousel";
const CLOCK_FACE = "com.apple.clockface";

/** Answers appStates with a captured reply's states, as the socket client resolves them. */
class CapturedStatesRunner extends FakeWatchRunnerClient {
  constructor(private readonly reply: { states: Record<string, string> }) {
    super();
  }
  override async request(
    command: WatchCommand,
    signal?: AbortSignal,
    options?: Parameters<FakeWatchRunnerClient["request"]>[2],
  ): Promise<unknown> {
    await super.request(command, signal, options);
    return command.type === "appStates" ? this.reply.states : undefined;
  }
}

/** A connected runner built before appStates: it stays usable and rejects the command. */
class RunnerWithoutAppStates extends FakeWatchRunnerClient {
  override async request(...args: Parameters<FakeWatchRunnerClient["request"]>): Promise<unknown> {
    await super.request(...args);
    throw new WatchRunnerError("unsupported", "unsupported_on_watchos");
  }
}

function probeFor(client: FakeWatchRunnerClient | undefined) {
  return new RunnerWatchForegroundProbe({ get: () => client });
}

describe("watch foreground apps", () => {
  test.each([
    ["the runner app", runnerInFront, [RUNNER]],
    ["Settings", settingsInFront, [SETTINGS]],
    ["no listed app (clock face)", clockFace, []],
  ] as const)("marks %s as foreground from a captured reply", async (_name, reply, expected) => {
    const client = new CapturedStatesRunner(reply);
    const foreground = await probeFor(client).foregroundBundleIds("watch", LISTED);
    expect([...foreground]).toEqual([...expected]);
    expect(client.commands).toEqual([{ type: "appStates", bundleIds: LISTED }]);
  });

  test("only listed apps are asked about, so always-foreground system processes never show", async () => {
    // The capture reports Carousel and clockface as runningForeground too; they are not listed apps.
    const client = new CapturedStatesRunner(runnerInFront);
    const foreground = await probeFor(client).foregroundBundleIds("watch", [SETTINGS]);
    expect([...foreground]).toEqual([]);
  });

  test("listing never starts a runner and tolerates one without appStates", async () => {
    expect([...(await probeFor(undefined).foregroundBundleIds("watch", LISTED))]).toEqual([]);
    const closed = new FakeWatchRunnerClient();
    closed.close();
    expect([...(await probeFor(closed).foregroundBundleIds("watch", LISTED))]).toEqual([]);
    expect(closed.commands).toEqual([]);
    const old = new RunnerWithoutAppStates();
    expect(old.isUsable()).toBe(true);
    expect([...(await probeFor(old).foregroundBundleIds("watch", LISTED))]).toEqual([]);
    expect(old.commands).toEqual([{ type: "appStates", bundleIds: LISTED }]);
  });

  test.each([
    ["the runner app", runnerInFront, RUNNER],
    ["Settings", settingsInFront, SETTINGS],
  ] as const)(
    "a listing with Carousel and clockface marks only %s, not the always-foreground system apps",
    async (_name, reply, expected) => {
      const listed = [...LISTED, CAROUSEL, CLOCK_FACE];
      const foreground = await probeFor(new CapturedStatesRunner(reply)).foregroundBundleIds(
        "watch",
        listed,
      );
      expect([...foreground]).toEqual([expected]);
    },
  );

  test("only system bundles in front: a lone one is marked, two cannot be told apart", async () => {
    const probe = probeFor(new CapturedStatesRunner(settingsInFront));
    expect([...(await probe.foregroundBundleIds("watch", [CLOCK_FACE, CALCULATOR]))]).toEqual([
      CLOCK_FACE,
    ]);
    expect([...(await probe.foregroundBundleIds("watch", [CAROUSEL, CLOCK_FACE]))]).toEqual([]);
  });

  test("splits a large listing into runner-sized requests and drops unknown states", async () => {
    const client = new FakeWatchRunnerClient();
    const sent: string[][] = [];
    const ids = Array.from(
      { length: MAX_WATCH_APP_STATE_BUNDLES + 2 },
      (_, index) => `app.${index}`,
    );
    const states = await readWatchAppStates(
      {
        request: async (command) => {
          if (command.type !== "appStates") {
            throw new Error("unexpected");
          }
          sent.push(command.bundleIds);
          return Object.fromEntries(
            command.bundleIds.map((id) => [id, id === "app.1" ? "runningForeground" : "bogus"]),
          );
        },
      },
      [...ids, "app.0"],
    );
    expect(sent.map((chunk) => chunk.length)).toEqual([MAX_WATCH_APP_STATE_BUNDLES, 2]);
    expect([...states]).toEqual([["app.1", "runningForeground"]]);
    expect(client.commands).toEqual([]);
  });

  test("the socket client resolves an appStates reply to its states", async () => {
    const socket = new FakeWatchSocket();
    const client = new WebSocketWatchRunnerClient("ws://127.0.0.1:8765/ws", {
      factory: () => socket,
      timer: new FakeTimer(),
      timeoutMs: 50,
    });
    socket.receive({ type: "connected", platform: "watchos", supportedCommands: ["appStates"] });
    const pending = client.request({ type: "appStates", bundleIds: [SETTINGS] });
    await drainMicrotasks(2);
    expect(socket.sent[0]).toEqual({ type: "appStates", bundleIds: [SETTINGS], requestId: "1" });
    socket.receive({ ...settingsInFront, requestId: "1" });
    expect(await pending).toEqual(settingsInFront.states);
    client.close();
  });
});
