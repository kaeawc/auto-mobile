import { createExecResult } from "../../../src/utils/execResult";
import { describe, expect, test } from "bun:test";
import {
  parseSimulatorPairs,
  simulatorPairArgs,
  SimulatorPairService,
} from "../../../src/utils/ios-cmdline-tools/SimulatorPairs";
import {
  capturedPair as pair,
  FakeSimulatorPairs,
  pairsFixture,
} from "../../fakes/FakeSimulatorPairs";

describe("simulator pairs", () => {
  test.each(["unpaired", "new", "active-connected", "disconnected", "two-watches-one-phone"])(
    "parses capture %s",
    (name) => {
      const parsed = parseSimulatorPairs(pairsFixture(`list-pairs-${name}.json`));
      expect(parsed.length).toBe(
        name === "unpaired" ? 0 : name === "two-watches-one-phone" ? 2 : 1,
      );
      if (parsed.length) {
        expect(parsed[0]).toMatchObject({
          pairId: pair.pairId,
          state: "active",
          connection: name === "active-connected" ? "connected" : "disconnected",
        });
      }
      if (parsed.length === 2) {
        expect(parsed[1]).toMatchObject({
          pairId: "B04954FD-4FC9-4E1F-931B-C975AEBB1CF4",
          state: "inactive",
          phone: pair.phone,
        });
      }
    },
  );
  test("watch deletion capture has no listed or owned pair to clean up", async () => {
    const listing = pairsFixture("list-pairs-after-watch-delete.json");
    expect(parseSimulatorPairs(listing)).toEqual([]);
    const watchId = "E5397E9B-BB5D-42A8-9D34-D6B6D8607D9B";
    const fake = new FakeSimulatorPairs();
    fake.listing = listing;
    const owned = new Map([["03DA0ED4-123F-469A-B77E-44CCFEE05AEE", watchId]]);
    const service = new SimulatorPairService(fake, owned);
    expect((await service.list()).some((entry) => entry.watch.deviceId === watchId)).toBe(false);
  });
  test("builds exact argv", () => {
    expect(simulatorPairArgs.pair("watch", "phone")).toEqual(["pair", "watch", "phone"]);
    expect(simulatorPairArgs.activate("id")).toEqual(["pair_activate", "id"]);
    expect(simulatorPairArgs.unpair("id")).toEqual(["unpair", "id"]);
    expect(simulatorPairArgs.list()).toEqual(["list", "pairs", "-j"]);
  });
  test("creates, activates, refreshes and only unpairs owned pairs across service instances", async () => {
    const fake = new FakeSimulatorPairs();
    const owned = new Map<string, string>();
    const service = new SimulatorPairService(fake, owned);
    const result = await service.ensure(pair.watch.deviceId, pair.phone.deviceId);
    expect(result).toMatchObject({ pairId: pair.pairId, created: true, state: "active" });
    expect(fake.calls.slice(2)).toEqual([
      ["pair", pair.watch.deviceId, pair.phone.deviceId],
      ["pair_activate", pair.pairId],
    ]);
    fake.listing = pairsFixture("list-pairs-active-connected.json");
    expect(await service.refresh(result)).toMatchObject({ connection: "connected", created: true });
    await new SimulatorPairService(fake, owned).unpairCreated("other-watch");
    await new SimulatorPairService(fake, owned).unpairCreated(pair.watch.deviceId);
    await service.unpairCreated(pair.watch.deviceId);
    expect(fake.calls.filter((args) => args[0] === "unpair")).toEqual([["unpair", pair.pairId]]);
  });
  test("adopts same-phone active pair without mutating or owning it", async () => {
    const fake = new FakeSimulatorPairs();
    fake.listing = pairsFixture("list-pairs-new.json");
    const service = fake.service();
    expect(await service.ensure(pair.watch.deviceId, pair.phone.deviceId)).toMatchObject({
      created: false,
    });
    await service.unpairCreated(pair.watch.deviceId);
    expect(fake.calls).toEqual([
      ["list", "devices", "--json"],
      ["list", "pairs", "-j"],
    ]);
  });
  test("activates an inactive same-phone pair", async () => {
    const fake = new FakeSimulatorPairs();
    fake.listing = pairsFixture("list-pairs-two-watches-one-phone.json");
    const second = parseSimulatorPairs(fake.listing)[1]!;
    expect(await fake.service().ensure(second.watch.deviceId, pair.phone.deviceId)).toMatchObject({
      created: false,
    });
    expect(fake.calls.at(-1)).toEqual(["pair_activate", second.pairId]);
  });
  test("refuses a different phone without calling pair", async () => {
    const fake = new FakeSimulatorPairs();
    fake.listing = pairsFixture("list-pairs-two-watches-one-phone.json");
    // The first watch's UDID is a non-iOS target; validate it before pair inspection.
    await expect(fake.service().ensure(pair.watch.deviceId, pair.watch.deviceId)).rejects.toThrow(
      "No iOS-runtime simulator",
    );
    const execute = fake.executeCommandArgs.bind(fake);
    fake.executeCommandArgs = async (args) =>
      args[1] === "devices"
        ? createExecResult(
            JSON.stringify({
              devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{ udid: "other-phone" }] },
            }),
            "",
          )
        : execute(args);
    await expect(fake.service().ensure(pair.watch.deviceId, "other-phone")).rejects.toThrow(
      `pair ${pair.pairId}`,
    );
    expect(fake.calls.some((args) => args[0] === "pair")).toBe(false);
  });
  test("maps captured 403 to the existing phone and pair", async () => {
    const fake = new FakeSimulatorPairs();
    fake.pairError = pairsFixture("pair-already-paired.stderr.txt");
    await expect(fake.service().ensure(pair.watch.deviceId, pair.phone.deviceId)).rejects.toThrow(
      `iPhone '${pair.phone.name}' (${pair.phone.deviceId})`,
    );
  });
  test("tolerates captured already-active error", async () => {
    const fake = new FakeSimulatorPairs();
    fake.activateError = pairsFixture("pair-activate-already-active.stderr.txt");
    expect(await fake.service().ensure(pair.watch.deviceId, pair.phone.deviceId)).toMatchObject({
      created: true,
      state: "active",
    });
  });
  test("refuses missing phone", async () => {
    await expect(
      new FakeSimulatorPairs().service().ensure(pair.watch.deviceId, "missing"),
    ).rejects.toThrow("No iOS-runtime simulator");
  });
  test("failed unpair retains ownership for retry", async () => {
    const fake = new FakeSimulatorPairs();
    const service = fake.service();
    await service.ensure(pair.watch.deviceId, pair.phone.deviceId);
    fake.unpairError = "unpair failed";
    await service.unpairCreated(pair.watch.deviceId);
    fake.unpairError = undefined;
    await service.unpairCreated(pair.watch.deviceId);
    expect(fake.calls.filter((args) => args[0] === "unpair")).toHaveLength(2);
  });
});
