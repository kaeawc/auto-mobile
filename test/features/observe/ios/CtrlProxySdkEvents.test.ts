import { describe, expect, test } from "bun:test";
import { CtrlProxySdkEvents } from "../../../../src/features/observe/ios/CtrlProxySdkEvents";
import { CtrlProxySdkScreenIdentity } from "../../../../src/features/observe/ios/CtrlProxySdkScreenIdentity";
import { FakeIosSdkEventIngestor } from "../../../fakes/FakeIosSdkEventIngestor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { settleByFakeEvents } from "../../../helpers/fakeTimerStepping";

const appId = "com.example.sdk";

function createHarness(available: boolean | undefined) {
  const timer = new FakeTimer();
  const screenIdentity = new CtrlProxySdkScreenIdentity({
    invalidateBuildContext: () => {},
    invalidateAllBuildContexts: () => {},
    invalidateSdkCapabilities: () => {},
  });
  const state = { available, polls: 0, navigationOnPoll: 0 };
  screenIdentity.rememberSdkScreenIdentity("navigation", appId, { destination: "Home" }, 100, 1);
  const ingestor = new FakeIosSdkEventIngestor();
  const events = new CtrlProxySdkEvents({
    timer,
    screenIdentity,
    getSdkAvailability: () => state.available,
    getSdkEventIngestor: () => ingestor,
    getPort: () => 1234,
    resolveWebSocketHost: () => "localhost",
    getSdkScreenIdentity: (id) => screenIdentity.getSdkScreenIdentity(id),
    pollSdkEvents: async () => {
      state.polls++;
      // Model an 8 ms endpoint RTT: the old loop uses six polls / 100 ms.
      timer.advanceTime(8);
      const rememberedApplicationIds = new Set<string>();
      if (state.polls === state.navigationOnPoll) {
        screenIdentity.rememberSdkScreenIdentity(
          "navigation",
          appId,
          { destination: "Details" },
          200,
          2,
        );
        rememberedApplicationIds.add(appId);
      }
      return { receivedEvents: rememberedApplicationIds.size > 0, rememberedApplicationIds };
    },
  });
  const refresh = async (capturedAt?: number) => {
    const before = timer.now();
    const pollsBefore = state.polls;
    const identity = await settleByFakeEvents(
      timer,
      events.refreshSdkScreenIdentity(appId, capturedAt),
      { description: "SDK identity refresh" },
    );
    const metrics = { polls: state.polls - pollsBefore, wallMs: timer.now() - before };
    console.log(
      `SDK identity available=${state.available} capturedAt=${capturedAt}: ${JSON.stringify(metrics)}`,
    );
    return { identity, ...metrics };
  };
  return { state, timer, refresh, screenIdentity };
}

describe("bounded SDK identity refresh", () => {
  test("a known no-SDK app drains once and skips retry sleeps", async () => {
    const h = createHarness(false);
    const result = await h.refresh(200);
    expect(result.polls).toBe(1);
    expect(result.wallMs).toBe(8);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("a cached SDK absence still picks up a navigation the late-started SDK queued", async () => {
    const h = createHarness(false);
    h.state.navigationOnPoll = 1;
    // #14432: the negative probe predates the SDK server, which then queued Details.
    const result = await h.refresh(200);
    expect(result.identity?.components.navigationRoute).toBe("Details");
    expect(result.polls).toBe(1);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("an SDK capture covered by the last identity event drains once", async () => {
    const h = createHarness(true);
    const result = await h.refresh(99);
    expect(result.polls).toBe(1);
    expect(result.wallMs).toBe(8);
    expect(result.identity?.components.navigationRoute).toBe("Home");
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("a capture in the last event's millisecond keeps retrying for a newer navigation", async () => {
    const h = createHarness(true);
    h.state.navigationOnPoll = 2;
    // #14433: equal truncated timestamps give no ordering, so poll one's empty
    // drain must not end the refresh before poll two delivers the navigation.
    const result = await h.refresh(100);
    expect(result.identity?.components.navigationRoute).toBe("Details");
    expect(result.polls).toBe(2);
    expect(h.timer.getSleepHistory()).toEqual([10]);
  });

  test("a newer capture waits for navigation on poll three, then reuses it", async () => {
    const h = createHarness(true);
    h.state.navigationOnPoll = 3;
    // #4463: a navigation event arriving just after capture must reach the diff gate.
    const result = await h.refresh(200);
    expect(result.identity?.components.navigationRoute).toBe("Details");
    expect(result.polls).toBe(3);
    expect(result.wallMs).toBe(44);
    expect(h.timer.getSleepHistory()).toEqual([10, 10]);
    expect((await h.refresh(199)).polls).toBe(1);
  });

  test("a missing navigation stops at 100 ms; an older capture still drains once", async () => {
    const h = createHarness(true);
    const result = await h.refresh(200);
    expect(result.polls).toBe(6);
    expect(result.wallMs).toBe(100);
    expect(result.identity?.components.navigationRoute).toBe("Home");
    expect(h.timer.getSleepHistory()).toEqual([10, 10, 10, 10, 10, 2]);
    expect((await h.refresh(99)).polls).toBe(1);
  });

  test("unknown capability keeps the old bounded retry after a negative is invalidated", async () => {
    const h = createHarness(false);
    const knownNegative = await h.refresh(100);
    h.state.available = undefined;
    const result = await h.refresh(100);
    expect(result.polls).toBe(6);
    expect(result.wallMs).toBe(100);
    expect(knownNegative.polls).toBe(1);
  });
});
