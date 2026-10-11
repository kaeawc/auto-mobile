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
 * Hunt (socket-frames-4): a device-mutating `ide/*` frame whose sender left before it reached the
 * device: the socket closed while the frame waited in its admission queue, or the client
 * cancelled it (`daemon/cancelRequest`) while its device was still being resolved.
 *
 * An `input/*` frame in either state is never dispatched (#10006): its handler runs under the
 * socket's owner signal, which both the close and the cancel abort. A mutating `ide/*` frame is a
 * tracked control call like input (#11486), but `runLocalSocketRequest` runs it without that
 * signal, and the per-socket queue drops a waiting entry only on `daemon/cancelRequest`. So the
 * queued `ide/clearKeyValueFile` of a client that is gone still wipes the app's store once the
 * frame ahead of it finishes, and a cancelled one, already answered as abandoned, still runs.
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

describe("a device-mutating ide/* frame whose sender left before it reached the device", () => {
  let rig: DirectFrameRig;
  let pane: FakeSocket;
  /** The device is busy with the first write until this resolves. */
  let firstWrite: PromiseWithResolvers<void>;
  /** When set, device discovery does not answer until it resolves. */
  let discovery: PromiseWithResolvers<void> | undefined;

  beforeEach(async () => {
    firstWrite = Promise.withResolvers<void>();
    discovery = undefined;
    rig = createDirectFrameRig([android(DEVICE)], {
      setPreference: () => firstWrite.promise,
      discovery: async () => discovery?.promise,
    });
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

  const cancel = (requestId: string): DaemonRequest => ({
    id: `cancel-${requestId}`,
    type: "daemon_request",
    method: "daemon/cancelRequest",
    params: { requestId },
  });

  test("control: an input/gestureStart cancelled while its device was resolved is not sent", async () => {
    await finishFirstWrite();
    discovery = Promise.withResolvers<void>();
    await rig.request(pane, gestureFrame("Start", DEVICE));
    expect(await rig.request(pane, cancel(`gesture-Start-${DEVICE}`))).toMatchObject({
      result: { cancelled: true },
    });
    discovery.resolve();
    await rig.settle();

    expect(rig.deviceCalls).toEqual([`${DEVICE}:setPreference`]);
  });

  test("an ide/clearKeyValueFile cancelled while its device was resolved is not run", async () => {
    await finishFirstWrite();
    discovery = Promise.withResolvers<void>();
    await rig.request(pane, storageFrame("clear", "ide/clearKeyValueFile", {}));
    expect(await rig.request(pane, cancel("clear"))).toMatchObject({
      result: { cancelled: true },
    });
    // The client was told its request was abandoned.
    expect(pane.answer("clear")).toMatchObject({ success: false });
    discovery.resolve();
    await rig.settle();

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
