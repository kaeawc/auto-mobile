import { afterEach, describe, expect, test } from "bun:test";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios";
import type { BootedDevice } from "../../../../src/models";
import { createSuccessWebSocketFactory, type PongMode } from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeIOSCtrlProxyManager } from "../../../fakes/FakeIOSCtrlProxyManager";
import { maskRealCtrlProxyWebSocketOptIn } from "../../../helpers/maskRealCtrlProxyWebSocketOptIn";

const device: BootedDevice = { deviceId: "silent-stall-sim", platform: "ios", name: "Sim" };

/**
 * #11247: a runner that stops answering commands (e.g. a SIGSTOPped XCTest
 * process) left the socket open. observe served stale cache and tapAt returned
 * "indeterminate" while recovery waited ~90 s for the supervisor. A command
 * timeout with no inbound frame, confirmed by an unanswered ping, now joins the
 * budgeted force-restart path that readiness checks use.
 */
describe("IOSCtrlProxyClient silent command timeout recovery (#11247)", () => {
  maskRealCtrlProxyWebSocketOptIn();

  let client: IOSCtrlProxyClient | null = null;

  afterEach(async () => {
    await client?.close();
    client = null;
    IOSCtrlProxyClient.resetInstances();
  });

  const connect = async (
    pongMode: PongMode,
  ): Promise<{
    timer: FakeTimer;
    manager: FakeIOSCtrlProxyManager;
    client: IOSCtrlProxyClient;
  }> => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new FakeIOSCtrlProxyManager(timer);
    client = IOSCtrlProxyClient.createForTesting(
      device,
      8765,
      createSuccessWebSocketFactory(timer, pongMode),
      timer,
      () => manager,
    );
    expect(await client.ensureConnected()).toBe(true);
    // Commands follow the handshake; the handshake itself is the last proof of life.
    timer.advanceTime(100);
    return { timer, manager, client };
  };

  const expectUnconfirmedTap = async (c: IOSCtrlProxyClient): Promise<void> => {
    const tap = await c.requestTapCoordinates(10, 20);
    expect(tap).toMatchObject({ success: false, dispatched: true, acknowledged: false });
  };

  test("an unanswered tap starts runner recovery once the stall is confirmed", async () => {
    const h = await connect("withhold");
    await expectUnconfirmedTap(h.client);
    expect(h.manager.getCallCount("forceRestart")).toBe(0);
    await h.timer.advanceTimeAsync(2_000);
    expect(h.manager.getCallCount("forceRestart")).toBe(1);
  });

  test("an unanswered hierarchy read serves the stale result and still starts recovery", async () => {
    const h = await connect("withhold");
    const result = await h.client.getLatestHierarchy(true, 15_000);
    expect(result.hierarchy).toBeNull();
    expect(result.unavailableReason).toBe("request_timed_out");
    await h.timer.advanceTimeAsync(2_000);
    expect(h.manager.getCallCount("forceRestart")).toBe(1);
  });

  test("a runner that answers the confirmation ping is busy, not stalled", async () => {
    const h = await connect("auto");
    await expectUnconfirmedTap(h.client);
    await h.timer.advanceTimeAsync(2_000);
    expect(h.manager.getCallCount("forceRestart")).toBe(0);
  });

  test("a caller's short read budget is not stall evidence", async () => {
    const h = await connect("withhold");
    await h.client.getLatestHierarchy(true, 1_000);
    await h.timer.advanceTimeAsync(2_000);
    expect(h.manager.getCallCount("forceRestart")).toBe(0);
  });

  test("a silent diagnostic hierarchy read on the main connection never starts recovery (#10724)", async () => {
    const h = await connect("withhold");
    expect(
      await h.client.requestHierarchySyncForDiagnostics(undefined, false, undefined, 15_000),
    ).toBeNull();
    await h.timer.advanceTimeAsync(2_000);
    expect(h.manager.getCallCount("forceRestart")).toBe(0);
  });

  test("a silent read-only request such as a screenshot never starts recovery", async () => {
    const h = await connect("withhold");
    await h.client.requestScreenshot();
    await h.timer.advanceTimeAsync(2_000);
    expect(h.manager.getCallCount("forceRestart")).toBe(0);
  });

  test("repeated silent timeouts stay within one in-flight recovery", async () => {
    const h = await connect("withhold");
    await expectUnconfirmedTap(h.client);
    await expectUnconfirmedTap(h.client);
    await h.timer.advanceTimeAsync(2_000);
    expect(h.manager.getCallCount("forceRestart")).toBe(1);
  });
});
