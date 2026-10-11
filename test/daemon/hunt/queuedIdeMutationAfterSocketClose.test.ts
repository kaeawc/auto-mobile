import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DaemonRequest } from "../../../src/daemon/types";
import {
  android,
  createDirectFrameRig,
  gestureFrame,
  type DirectFrameRig,
  type FakeSocket,
} from "./directFrameHuntRig";

/**
 * Hunt (socket-frames-4): a device-mutating `ide/*` frame still waiting in its socket's admission
 * queue when the socket closes.
 *
 * An `input/*` frame whose socket closed while it sat in the queue is never dispatched (#10006):
 * its handler runs under the socket's owner signal. A mutating `ide/*` frame is a tracked control
 * call like input (#11486), but it is run without the owner signal, and the per-socket queue only
 * drops a waiting entry on `daemon/cancelRequest`. So once the frame ahead of it finishes, the
 * queued `ide/clearKeyValueFile` of a client that is gone still wipes the app's store.
 */

const DEVICE = "emulator-5554";

function storageFrame(id: string, method: string, extra: Record<string, unknown>): DaemonRequest {
  return {
    id,
    type: "mcp_request",
    method,
    params: {
      platform: "android",
      deviceId: DEVICE,
      appId: "com.example",
      fileName: "prefs",
      ...extra,
    },
  };
}

describe("a queued device-mutating ide/* frame whose socket closed", () => {
  let rig: DirectFrameRig;
  let pane: FakeSocket;
  /** The device is busy with the first write until this resolves. */
  let firstWrite: PromiseWithResolvers<void>;

  beforeEach(async () => {
    firstWrite = Promise.withResolvers<void>();
    rig = createDirectFrameRig([android(DEVICE)], { setPreference: () => firstWrite.promise });
    pane = rig.connect();
    // In flight on the device: every later frame on this socket waits behind it.
    await rig.request(
      pane,
      storageFrame("write", "ide/setKeyValue", { key: "k", value: "v", type: "STRING" }),
    );
    expect(rig.deviceCalls).toEqual([`${DEVICE}:setPreference`]);
  });

  afterEach(async () => {
    firstWrite.resolve();
    await rig.dispose();
  });

  async function finishFirstWrite(): Promise<void> {
    firstWrite.resolve();
    await rig.settle();
  }

  test("control: a queued input/gestureStart is not sent once its socket closed", async () => {
    await rig.request(pane, gestureFrame("Start", DEVICE));
    pane.destroy();
    await finishFirstWrite();

    expect(rig.deviceCalls).toEqual([`${DEVICE}:setPreference`]);
  });

  test("control: a queued ide/clearKeyValueFile cancelled by its client is not run", async () => {
    await rig.request(pane, storageFrame("clear", "ide/clearKeyValueFile", {}));
    await rig.request(pane, {
      id: "cancel",
      type: "daemon_request",
      method: "daemon/cancelRequest",
      params: { requestId: "clear" },
    });
    await finishFirstWrite();

    expect(rig.deviceCalls).toEqual([`${DEVICE}:setPreference`]);
  });

  test("a queued ide/clearKeyValueFile is not run once its socket closed", async () => {
    await rig.request(pane, storageFrame("clear", "ide/clearKeyValueFile", {}));
    pane.destroy();
    await finishFirstWrite();

    expect(rig.deviceCalls).toEqual([`${DEVICE}:setPreference`]);
  });

  test("a queued ide/setKeyValue is not written once its socket closed", async () => {
    await rig.request(
      pane,
      storageFrame("second", "ide/setKeyValue", { key: "k2", value: "v2", type: "STRING" }),
    );
    pane.destroy();
    await finishFirstWrite();

    expect(rig.deviceCalls).toEqual([`${DEVICE}:setPreference`]);
  });
});
