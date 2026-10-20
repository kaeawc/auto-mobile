import { describe, expect, spyOn, test, afterEach, mock } from "bun:test";
import { configureObservationStreamCallbacks } from "../../src/daemon/daemonObservationStreamCallbacks";
import { DeviceDataStreamSocketServer } from "../../src/daemon/deviceDataStreamSocketServer";
import { DefaultObservationInitialFrameCoordinator } from "../../src/daemon/observationInitialFrameCoordinator";
import type { StorageSubscriptionRequest } from "../../src/daemon/daemonStreamRouting";
import { FakeTimer } from "../fakes/FakeTimer";

afterEach(() => {
  mock.restore();
});

const unused = (): never => {
  throw new Error("dependency not expected to be read by this test");
};

describe("configureObservationStreamCallbacks", () => {
  test("installs every stream callback and forwards storage subscription requests to the daemon", async () => {
    const timer = new FakeTimer();
    const server = new DeviceDataStreamSocketServer("/fake/observation.sock", timer, {
      authorize: () => {},
    });
    const subscriber = spyOn(server, "setOnSubscriberConnected");
    const screenshot = spyOn(server, "setOnScreenshotCadenceChanged");
    const hierarchy = spyOn(server, "setOnHierarchyCadenceChanged");
    const observation = spyOn(server, "setOnObservationRequested");
    const storage = spyOn(server, "setOnStorageSubscriptionRequested");
    const applied: StorageSubscriptionRequest[] = [];

    configureObservationStreamCallbacks(
      server,
      new DefaultObservationInitialFrameCoordinator(timer),
      {
        devicePool: unused,
        passiveWorkPolicy: unused,
        timer: () => timer,
        sessionManager: unused,
        applyStorageSubscriptionRequest: async (request) => {
          applied.push(request);
        },
      },
    );

    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(hierarchy).toHaveBeenCalledTimes(1);
    expect(observation).toHaveBeenCalledTimes(1);
    const request: StorageSubscriptionRequest = {
      deviceId: "emulator-5554",
      packageName: "com.example",
      fileName: "prefs",
      subscribe: true,
    };
    await storage.mock.calls[0][0](request);
    expect(applied).toEqual([request]);
  });
});
