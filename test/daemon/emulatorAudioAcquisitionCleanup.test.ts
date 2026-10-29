import { describe, expect, test } from "bun:test";
import { createOwnerlessAudioAcquisitionCleanup } from "../../src/daemon/emulatorAudioSessionCleanup";
import { FakeTimer } from "../fakes/FakeTimer";

function fakeManager() {
  const registered: Array<{ deviceId: string; cleanup: Promise<unknown> }> = [];
  return {
    registered,
    registerAcquisitionDeviceCleanup(deviceId: string, cleanup: Promise<unknown>) {
      registered.push({ deviceId, cleanup });
    },
  };
}

describe("createOwnerlessAudioAcquisitionCleanup", () => {
  test("stops sessionless injections and holds acquisition until the stop settles", async () => {
    const manager = fakeManager();
    const stopped: string[] = [];
    const acquire = createOwnerlessAudioAcquisitionCleanup(
      manager,
      {
        stopOwnerless: (deviceId) => {
          stopped.push(deviceId);
          return Promise.resolve(1);
        },
      },
      new FakeTimer(),
    );
    acquire("emulator-5554");
    expect(stopped).toEqual(["emulator-5554"]);
    expect(manager.registered.map((entry) => entry.deviceId)).toEqual(["emulator-5554"]);
    await manager.registered[0].cleanup;
  });

  test("registers no cleanup when the device has no sessionless injection", () => {
    const manager = fakeManager();
    const acquire = createOwnerlessAudioAcquisitionCleanup(
      manager,
      { stopOwnerless: () => undefined },
      new FakeTimer(),
    );
    acquire("emulator-5554");
    expect(manager.registered).toEqual([]);
  });
});
