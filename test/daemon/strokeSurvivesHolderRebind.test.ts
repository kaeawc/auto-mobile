import { GestureOwnershipRegistry } from "../../src/daemon/gestureOwnership";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  android,
  createDirectFrameRig,
  gestureFrame,
  type DirectFrameRig,
  type FakeSocket,
} from "../helpers/directFrameRig";

/** #11667: a rebind lifts only strokes admitted under the holder on the device it left. */

const HOLDER = "rebinding-holder-session";
const NEXT_OWNER = "next-owner-session";
const OLD_DEVICE = "emulator-5554";
const NEW_DEVICE = "emulator-5556";
const IDLE_MS = 60_000;

describe("an open input stroke vs. its holder rebinding to another device", () => {
  let rig: DirectFrameRig;
  let pane: FakeSocket;

  beforeEach(async () => {
    rig = createDirectFrameRig([android(OLD_DEVICE), android(NEW_DEVICE)]);
    pane = rig.connect();
    await rig.sessionManager.createSession(HOLDER, OLD_DEVICE, "android", IDLE_MS);
    expect(
      await rig.request(pane, gestureFrame("Start", OLD_DEVICE, { sessionUuid: HOLDER })),
    ).toMatchObject({ success: true });
    expect(rig.deviceCalls).toEqual([`${OLD_DEVICE}:start`]);
  });

  afterEach(() => rig.dispose());

  test("control: releasing the holder lifts the stroke", async () => {
    await rig.sessionManager.releaseSession(HOLDER, "explicit-release", true);
    await rig.settle();

    expect(rig.deviceCalls).toEqual([`${OLD_DEVICE}:start`, `${OLD_DEVICE}:cancel`]);
  });

  test("the holder rebinding away leaves no pointer down on the device it left", async () => {
    await rig.sessionManager.rebindSession(HOLDER, NEW_DEVICE, "android");
    await rig.settle();

    // The session lives on, on the other device; the old one is free.
    expect(rig.sessionManager.getSessionForDevice(NEW_DEVICE)).toBe(HOLDER);
    expect(rig.sessionManager.getSessionForDevice(OLD_DEVICE)).toBeNull();
    // The pane is still connected and its mouse is held still: no further frame arrives.
    expect(pane.destroyed).toBe(false);
    expect(rig.deviceCalls).toEqual([`${OLD_DEVICE}:start`, `${OLD_DEVICE}:cancel`]);
  });

  test("the next session to acquire the old device does not get it with the pointer down", async () => {
    await rig.sessionManager.rebindSession(HOLDER, NEW_DEVICE, "android");
    await rig.sessionManager.createSession(NEXT_OWNER, OLD_DEVICE, "android", IDLE_MS);
    await rig.settle();

    expect(rig.sessionManager.getSessionForDevice(OLD_DEVICE)).toBe(NEXT_OWNER);
    expect(pane.destroyed).toBe(false);
    expect(rig.deviceCalls).toEqual([`${OLD_DEVICE}:start`, `${OLD_DEVICE}:cancel`]);
  });

  test("a same-serial rebind, including force, preserves the stroke", async () => {
    await rig.sessionManager.rebindSession(HOLDER, OLD_DEVICE, "android");
    await rig.sessionManager.rebindSession(HOLDER, OLD_DEVICE, "android", { force: true });
    await rig.settle();
    expect(rig.deviceCalls).toEqual([`${OLD_DEVICE}:start`]);
  });

  test("rebinding queues the old-device cancel before the device is offered to its next owner", async () => {
    await rig.dispose();
    let offeredToNextOwner = false;
    const ownershipAtCancel: Array<{ holder: string | null; offered: boolean }> = [];
    rig = createDirectFrameRig([android(OLD_DEVICE), android(NEW_DEVICE)], {
      onDeviceCall: (deviceId, method) => {
        if (method === "cancel") {
          ownershipAtCancel.push({
            holder: rig.sessionManager.getSessionForDevice(deviceId),
            offered: offeredToNextOwner,
          });
        }
      },
    });
    pane = rig.connect();
    await rig.sessionManager.createSession(HOLDER, OLD_DEVICE, "android", IDLE_MS);
    await rig.request(pane, gestureFrame("Start", OLD_DEVICE, { sessionUuid: HOLDER }));
    expect(rig.isDeviceWorkQueued(OLD_DEVICE)).toBe(false);
    const queuedAtUnbind: boolean[] = [];
    rig.sessionManager.onSessionDeviceUnbound((_sessionId, deviceId) => {
      // This callback runs synchronously after the production lift callback, before pool release.
      queuedAtUnbind.push(rig.isDeviceWorkQueued(deviceId));
    });
    await rig.sessionManager.rebindSession(HOLDER, NEW_DEVICE, "android");
    expect(queuedAtUnbind).toEqual([true]);
    offeredToNextOwner = true;
    await rig.sessionManager.createSession(NEXT_OWNER, OLD_DEVICE, "android", IDLE_MS);
    await rig.request(
      pane,
      gestureFrame("Start", OLD_DEVICE, {
        sessionUuid: NEXT_OWNER,
        gestureId: "next-stroke",
      }),
    );
    expect(ownershipAtCancel).toEqual([{ holder: null, offered: false }]);
    expect(rig.deviceCalls).toEqual([
      `${OLD_DEVICE}:start`,
      `${OLD_DEVICE}:cancel`,
      `${OLD_DEVICE}:start`,
    ]);
  });

  test("a lift awaiting an answer does not block rebind", async () => {
    await rig.dispose();
    const lift = Promise.withResolvers<{ success: boolean }>();
    rig = createDirectFrameRig([android(OLD_DEVICE), android(NEW_DEVICE)], {
      requestGestureEnd: () => lift.promise,
    });
    pane = rig.connect();
    await rig.sessionManager.createSession(HOLDER, OLD_DEVICE, "android", IDLE_MS);
    await rig.request(pane, gestureFrame("Start", OLD_DEVICE, { sessionUuid: HOLDER }));
    try {
      await rig.sessionManager.rebindSession(HOLDER, NEW_DEVICE, "android");
      expect(rig.sessionManager.getSessionForDevice(NEW_DEVICE)).toBe(HOLDER);
      expect(rig.deviceCalls).toEqual([`${OLD_DEVICE}:start`, `${OLD_DEVICE}:cancel`]);
    } finally {
      lift.resolve({ success: true });
    }
  });

  test("a start acked after the holder rebinds is lifted", async () => {
    await rig.dispose();
    const start = Promise.withResolvers<{ success: boolean }>();
    rig = createDirectFrameRig([android(OLD_DEVICE), android(NEW_DEVICE)], {
      requestGestureStart: () => start.promise,
    });
    pane = rig.connect();
    await rig.sessionManager.createSession(HOLDER, OLD_DEVICE, "android", IDLE_MS);
    await rig.request(pane, gestureFrame("Start", OLD_DEVICE, { sessionUuid: HOLDER }));
    await rig.sessionManager.rebindSession(HOLDER, NEW_DEVICE, "android");
    start.resolve({ success: true });
    await rig.settle();
    expect(rig.deviceCalls).toEqual([`${OLD_DEVICE}:start`, `${OLD_DEVICE}:cancel`]);
    expect(pane.answer(`gesture-Start-${OLD_DEVICE}`)).toMatchObject({ success: false });
  });
});

// Seed admitted strokes directly to exercise scoping independent of one-device session routing.
describe("rebind stroke selection (#11667)", () => {
  test("kept-device and other-holder strokes survive the old-device lift", async () => {
    const cancelled: string[] = [];
    const registry = new GestureOwnershipRegistry({
      isSocketLive: () => true,
      cancelGesture: async (device, id) => {
        cancelled.push(`${device.deviceId}:${id}`);
      },
    });
    await registry.onStartAcked("pane", android(OLD_DEVICE), "left", HOLDER);
    await registry.onStartAcked("pane", android(NEW_DEVICE), "kept", HOLDER);
    await registry.onStartAcked("other-pane", android(OLD_DEVICE), "other", NEXT_OWNER);
    await registry.cancelAllHeldByOn(HOLDER, OLD_DEVICE);
    expect(cancelled).toEqual([`${OLD_DEVICE}:left`]);
    expect(registry.ownerCount).toBe(2);
    await registry.cancelAllHeldByOn(HOLDER, OLD_DEVICE);
    expect(cancelled).toEqual([`${OLD_DEVICE}:left`]);
    await registry.cancelAllHeldBy(HOLDER);
    expect(cancelled).toEqual([`${OLD_DEVICE}:left`, `${NEW_DEVICE}:kept`]);
    await registry.cancelAllHeldBy(NEXT_OWNER);
    expect(cancelled).toEqual([`${OLD_DEVICE}:left`, `${NEW_DEVICE}:kept`, `${OLD_DEVICE}:other`]);
  });
});
