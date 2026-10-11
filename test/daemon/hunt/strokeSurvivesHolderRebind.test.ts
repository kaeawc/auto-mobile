import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  android,
  createDirectFrameRig,
  gestureFrame,
  type DirectFrameRig,
  type FakeSocket,
} from "./directFrameHuntRig";

/**
 * Hunt (socket-frames-4): an open streamed stroke vs. its holder session REBINDING to another
 * device (`setActiveDevice` on a session that already holds one, `DevicePool` ->
 * `SessionManager.rebindSession`).
 *
 * A stroke never outlives the device holder it was admitted under (#11448): the release of the
 * holder lifts it, and an acquisition lifts the strokes no session held (#11541). A rebind is the
 * third way a holder leaves a device, and it is neither: the session stays live (no release
 * notification), and the stroke is recorded under a holder, so the acquisition lift of the next
 * session skips it. The runner parks a continued stroke with no ceiling, so with no further frame
 * from the pane the pointer stays down on a device that is free, and then on the next owner's.
 */

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
});
