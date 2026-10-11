import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DaemonRequest } from "../../src/daemon/types";
import {
  android,
  createDirectFrameRig,
  gestureFrame,
  type DirectFrameRig,
  type FakeSocket,
} from "../helpers/directFrameRig";

/** #11667: device-mutating IDE frames obey socket close and request cancellation like input. */

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
  let ownershipGate: PromiseWithResolvers<void> | undefined;
  let reads = 0;
  let discoveries = 0;
  let discovery: PromiseWithResolvers<void> | undefined;

  beforeEach(async () => {
    firstWrite = Promise.withResolvers<void>();
    discovery = undefined;
    ownershipGate = undefined;
    reads = 0;
    discoveries = 0;
    rig = createDirectFrameRig([android(DEVICE)], {
      setPreference: () => firstWrite.promise,
      discovery: async () => {
        discoveries++;
        await discovery?.promise;
      },
      ownershipGate: async () => ownershipGate?.promise,
      updateService: async () => {},
      onRead: () => {
        reads++;
      },
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
    discovery?.resolve();
    ownershipGate?.resolve();
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

  for (const method of ["ide/removeKeyValue", "ide/updateService"]) {
    test(`${method} queued on a closed socket sends nothing and does not resolve a device`, async () => {
      const before = discoveries;
      await rig.request(pane, storageFrame("cut", method, { key: "k" }));
      pane.destroy();
      await finishFirstWrite();
      expect(rig.deviceCalls).toEqual([`${DEVICE}:setPreference`]);
      expect(discoveries).toBe(before);
    });

    test(`${method} cancelled during resolution sends nothing`, async () => {
      await finishFirstWrite();
      discovery = Promise.withResolvers<void>();
      await rig.request(pane, storageFrame("cut", method, { key: "k" }));
      expect(await rig.request(pane, cancel("cut"))).toMatchObject({ result: { cancelled: true } });
      expect(pane.answer("cut")).toMatchObject({ success: false });
      discovery.resolve();
      await rig.settle();
      expect(rig.deviceCalls).toEqual([`${DEVICE}:setPreference`]);
    });
  }

  test("a read-only IDE frame queued on a closed socket still runs", async () => {
    await rig.request(pane, storageFrame("read", "ide/listFeatureFlags", {}));
    pane.destroy();
    await finishFirstWrite();
    expect(reads).toBe(1);
    expect(rig.deviceCalls).toEqual([`${DEVICE}:setPreference`]);
  });

  test("uncancelled IDE mutations still write", async () => {
    await finishFirstWrite();
    for (const method of [
      "ide/setKeyValue",
      "ide/removeKeyValue",
      "ide/clearKeyValueFile",
      "ide/updateService",
    ]) {
      expect(
        await rig.request(
          pane,
          storageFrame(method, method, {
            key: "k",
            value: "v",
            type: "STRING",
          }),
        ),
      ).toMatchObject({ success: true });
    }
    expect(rig.deviceCalls).toEqual([
      `${DEVICE}:setPreference`,
      `${DEVICE}:setPreference`,
      `${DEVICE}:removePreference`,
      `${DEVICE}:clearPreferenceStore`,
      `${DEVICE}:updateService`,
    ]);
  });

  for (const method of [
    "ide/setKeyValue",
    "ide/removeKeyValue",
    "ide/clearKeyValueFile",
    "ide/updateService",
  ]) {
    test(`${method} cancelled during its ownership gate sends nothing`, async () => {
      await finishFirstWrite();
      ownershipGate = Promise.withResolvers<void>();
      await rig.request(
        pane,
        storageFrame("cut-gate", method, { key: "k", value: "v", type: "STRING" }),
      );
      expect(await rig.request(pane, cancel("cut-gate"))).toMatchObject({
        result: { cancelled: true },
      });
      ownershipGate.resolve();
      await rig.settle();
      expect(rig.deviceCalls).toEqual([`${DEVICE}:setPreference`]);
    });
  }
});
