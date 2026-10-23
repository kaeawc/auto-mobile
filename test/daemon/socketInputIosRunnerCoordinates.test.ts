import { describe, expect, test } from "bun:test";
import { GestureOwnershipRegistry } from "../../src/daemon/gestureOwnership";
import { SocketInput } from "../../src/daemon/socketServerParts/SocketInput";
import { ActionableError } from "../../src/models/ActionableError";
import { FakeIOSCtrlProxy } from "../fakes/FakeIOSCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * The iOS input-coordinate scale probe takes only the two client calls it makes, so the fake
 * client drives it directly (#11863) instead of a cast stub of the concrete client.
 */
function harness() {
  const legacy = new Set<string>();
  const input = new SocketInput(
    {
      timer: new FakeTimer(),
      confirmedLegacyScaleDevices: legacy,
      ownedGestures: new GestureOwnershipRegistry({
        isSocketLive: () => false,
        cancelGesture: async () => undefined,
      }),
    },
    () => {
      throw new Error("the scale probe takes no socket-server callbacks");
    },
  );
  const client = new FakeIOSCtrlProxy();
  client.setHierarchyData({ updatedAt: 1, packageName: "com.example", hierarchy: {} });
  return { input, client, legacy };
}

describe("SocketInput.toIosRunnerCoordinates", () => {
  test("known scale metadata converts canonical pixels to points and clears a stale legacy verdict", async () => {
    const { input, client, legacy } = harness();
    client.screenScaleMetadata = { nativeScale: 3, pixelWidth: 1170, pixelHeight: 2532 };
    legacy.add("sim-1");
    expect(await input.toIosRunnerCoordinates(client, "sim-1", [300, 600], 100)).toEqual([
      100, 200,
    ]);
    expect(legacy.has("sim-1")).toBe(false);
    expect(client.hierarchySyncRequests.length).toBe(0);
  });

  test("a runner that answers the probe without metadata passes through and is probed once", async () => {
    const { input, client, legacy } = harness();
    expect(await input.toIosRunnerCoordinates(client, "sim-1", [10, 20], 100)).toEqual([10, 20]);
    expect(legacy.has("sim-1")).toBe(true);
    expect(await input.toIosRunnerCoordinates(client, "sim-1", [30, 40], 100)).toEqual([30, 40]);
    expect(client.hierarchySyncRequests.length).toBe(1);
  });

  test("a probe that learns the scale converts with it", async () => {
    const { input, client, legacy } = harness();
    const probe = client.requestHierarchySyncWithoutObservationStreamPush.bind(client);
    client.requestHierarchySyncWithoutObservationStreamPush = async (...args) => {
      client.screenScaleMetadata = { nativeScale: 2, pixelWidth: 800, pixelHeight: 1600 };
      return probe(...args);
    };
    expect(await input.toIosRunnerCoordinates(client, "sim-1", [100, 200], 100)).toEqual([50, 100]);
    expect(legacy.has("sim-1")).toBe(false);
  });

  test("a probe that returns no hierarchy fails closed and is not cached", async () => {
    const { input, client, legacy } = harness();
    client.setHierarchyData(null);
    const failure = await input.toIosRunnerCoordinates(client, "sim-1", [10, 20], 100).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ActionableError);
    expect(legacy.has("sim-1")).toBe(false);
  });

  test("a probe that throws fails closed with the device named", async () => {
    const { input, client } = harness();
    client.setFailureMode("requestHierarchySync", new Error("socket closed"));
    const failure = await input.toIosRunnerCoordinates(client, "sim-1", [10, 20], 100).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ActionableError);
    expect((failure as Error).message).toContain("sim-1");
  });
});
