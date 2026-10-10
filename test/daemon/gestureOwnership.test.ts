import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { GestureOwnershipRegistry } from "../../src/daemon/gestureOwnership";
import { FakeTimer } from "../fakes/FakeTimer";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };

/** Fake daemon seams: a mutable live-socket set and a recording cancel forward. */
function createHarness(options: { failCancel?: boolean } = {}) {
  const liveSockets = new Set<string>();
  const cancels: Array<{ deviceId: string; gestureId: string }> = [];
  const registry = new GestureOwnershipRegistry({
    isSocketLive: (id) => liveSockets.has(id),
    cancelGesture: async (target, gestureId) => {
      cancels.push({ deviceId: target.deviceId, gestureId });
      if (options.failCancel) {
        throw new Error("runner unreachable");
      }
    },
  });
  return { liveSockets, cancels, registry };
}

describe("GestureOwnershipRegistry", () => {
  test("records a start acked for a live socket and cancels it at socket close", async () => {
    const { liveSockets, cancels, registry } = createHarness();
    liveSockets.add("s1");

    expect(await registry.onStartAcked("s1", device, "g1")).toBe("owned");
    expect(registry.ownerCount).toBe(1);
    expect(cancels).toEqual([]);

    liveSockets.delete("s1");
    await registry.cancelAllFor("s1");

    expect(cancels).toEqual([{ deviceId: "emulator-5554", gestureId: "g1" }]);
    expect(registry.ownerCount).toBe(0);
  });

  test("a start acked after its socket closed is cancelled immediately and never recorded", async () => {
    const { cancels, registry } = createHarness();
    // "s1" is not in the live set: the socket closed before the runner acked the start.

    expect(await registry.onStartAcked("s1", device, "g1")).toBe("cancelled");

    expect(cancels).toEqual([{ deviceId: "emulator-5554", gestureId: "g1" }]);
    expect(registry.ownerCount).toBe(0);
    // Nothing is left for a later teardown to find, so no second cancel is issued.
    await registry.cancelAllFor("s1");
    expect(cancels).toHaveLength(1);
  });

  test("an in-flight start whose socket closes while the runner is still acking is cancelled", async () => {
    const timer = new FakeTimer();
    const { liveSockets, cancels, registry } = createHarness();
    liveSockets.add("s1");

    // The runner takes 100ms to ack; the socket closes (and its close-time cancel finds nothing
    // yet) before the ack lands.
    const ack = timer.sleep(100).then(() => registry.onStartAcked("s1", device, "g1"));
    liveSockets.delete("s1");
    await registry.cancelAllFor("s1");
    expect(cancels).toEqual([]);

    timer.advanceTime(100);

    expect(await ack).toBe("cancelled");
    expect(cancels).toEqual([{ deviceId: "emulator-5554", gestureId: "g1" }]);
    expect(registry.ownerCount).toBe(0);
  });

  test("an acked end clears ownership so socket close issues no cancel", async () => {
    const { liveSockets, cancels, registry } = createHarness();
    liveSockets.add("s1");
    await registry.onStartAcked("s1", device, "g1");

    registry.onEndAcked("s1", device.deviceId, "g1");
    expect(registry.ownerCount).toBe(0);

    await registry.cancelAllFor("s1");
    expect(cancels).toEqual([]);
  });

  test("close cancels every gesture the socket owns and leaves other sockets untouched", async () => {
    const { liveSockets, cancels, registry } = createHarness();
    liveSockets.add("s1");
    liveSockets.add("s2");
    await registry.onStartAcked("s1", device, "g1");
    await registry.onStartAcked("s1", device, "g2");
    await registry.onStartAcked("s2", device, "g3");

    liveSockets.delete("s1");
    await registry.cancelAllFor("s1");

    expect(cancels.map((c) => c.gestureId)).toEqual(["g1", "g2"]);
    expect(registry.ownerCount).toBe(1);
  });

  test("a failed cancel is logged, not thrown, for both close-time and late-ack paths", async () => {
    const { liveSockets, registry } = createHarness({ failCancel: true });
    liveSockets.add("s1");
    await registry.onStartAcked("s1", device, "g1");

    liveSockets.delete("s1");
    await registry.cancelAllFor("s1");
    expect(await registry.onStartAcked("s1", device, "g2")).toBe("cancelled");
    expect(registry.ownerCount).toBe(0);
  });

  test("releasing a holder session cancels the strokes admitted under it, on every socket", async () => {
    const { liveSockets, cancels, registry } = createHarness();
    liveSockets.add("s1");
    liveSockets.add("s2");
    await registry.onStartAcked("s1", device, "g1", "session-a");
    await registry.onStartAcked("s2", device, "g2", "session-a");
    await registry.onStartAcked("s2", device, "g3", "session-b");
    await registry.onStartAcked("s2", device, "g4");

    await registry.cancelAllHeldBy("session-a");

    expect(cancels.map((c) => c.gestureId)).toEqual(["g1", "g2"]);
    expect(registry.ownerCount).toBe(1);
    // The lifted strokes are no longer owned: socket close cancels only what is still open.
    await registry.cancelAllFor("s1");
    await registry.cancelAllFor("s2");
    expect(cancels.map((c) => c.gestureId)).toEqual(["g1", "g2", "g3", "g4"]);
  });

  test("a refused frame cancels its socket's stroke only once the device has changed hands", async () => {
    const { liveSockets, cancels, registry } = createHarness();
    liveSockets.add("s1");
    await registry.onStartAcked("s1", device, "g1", "session-a");
    const refused = (socketSessionId: string, holder: string | undefined) =>
      registry.cancelIfDeviceChangedHands(socketSessionId, device.deviceId, "g1", holder);

    // Still held by the session the start was admitted under: the refusal is not a handover.
    expect(await refused("s1", "session-a")).toBe(false);
    // Another socket naming the same gesture id owns nothing and lifts nothing.
    expect(await refused("s2", "session-b")).toBe(false);
    expect(cancels).toEqual([]);

    expect(await refused("s1", "session-b")).toBe(true);
    expect(cancels).toEqual([{ deviceId: "emulator-5554", gestureId: "g1" }]);
    expect(registry.ownerCount).toBe(0);
  });

  test("a stroke started on an unheld device is cancelled when a session has since acquired it", async () => {
    const { liveSockets, cancels, registry } = createHarness();
    liveSockets.add("s1");
    await registry.onStartAcked("s1", device, "g1");
    const refused = (holder: string | undefined) =>
      registry.cancelIfDeviceChangedHands("s1", device.deviceId, "g1", holder);

    expect(await refused(undefined)).toBe(false);
    expect(await refused("session-a")).toBe(true);
    expect(cancels).toHaveLength(1);
  });

  test("a failed release-time or handover cancel is logged, not thrown", async () => {
    const { liveSockets, registry } = createHarness({ failCancel: true });
    liveSockets.add("s1");
    await registry.onStartAcked("s1", device, "g1", "session-a");
    await registry.onStartAcked("s1", device, "g2", "session-b");

    await registry.cancelAllHeldBy("session-a");
    expect(
      await registry.cancelIfDeviceChangedHands("s1", device.deviceId, "g2", "session-c"),
    ).toBe(true);
    expect(registry.ownerCount).toBe(0);
  });
});
