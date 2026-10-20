import { afterEach, expect, test } from "bun:test";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { SimCtlSimulatorDeviceTypeProfiles } from "../../../src/utils/ios-cmdline-tools/SimulatorDeviceTypeProfiles";
import type { AppleDeviceType } from "../../../src/utils/ios-cmdline-tools/SimCtlSupport";
import type { PlistReader } from "../../../src/utils/ios-cmdline-tools/PlistClient";
import { FakeSimulatorProfileStore } from "../../fakes/FakeSimulatorProfileStore";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createExecResult } from "../../../src/utils/execResult";
import { drainUntil } from "../../helpers/fakeTimerStepping";

const type: AppleDeviceType = {
  identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
  name: "iPhone 17",
  productFamily: "iPhone",
  bundlePath: "/Xcode/iPhone.simdevicetype",
  minRuntimeVersion: 0,
  maxRuntimeVersion: 0,
};

function rig(store = new FakeSimulatorProfileStore()) {
  const timer = new FakeTimer();
  const counts = { types: 0, plutil: 0 };
  const reads: { timeoutMs?: number; signal?: AbortSignal }[] = [];
  const gate = Promise.withResolvers<void>();
  let blocked = false;
  let failure: Error | undefined;
  const plist: PlistReader = {
    readJsonFile: async (_path, options) => {
      counts.plutil++;
      reads.push(options ?? {});
      if (blocked) {
        await gate.promise;
      }
      if (failure) {
        throw failure;
      }
      return { mainScreenWidth: 1206 };
    },
    readJsonBytes: async () => ({}),
    readXmlFile: async () => "",
    readXmlBytes: async () => "",
    extractRawFile: async () => "",
  };
  const profiles = new SimCtlSimulatorDeviceTypeProfiles(
    {
      getDeviceTypes: async () => {
        counts.types++;
        return [type];
      },
    },
    plist,
    store,
    timer,
  );
  return {
    profiles,
    store,
    counts,
    reads,
    timer,
    gate,
    block: () => {
      blocked = true;
    },
    fail: (error?: Error) => {
      failure = error;
    },
  };
}

afterEach(() => SimCtlClient.invalidateDeviceListCache());

test("duplicate concurrent callers spawn one devicetypes and one plutil (formerly 1 + 2)", async () => {
  const r = rig();
  r.block();
  const first = r.profiles.profileFor(type.identifier);
  const second = r.profiles.profileFor(type.identifier);
  await drainUntil(() => r.counts.plutil > 0, { description: "profile read" });
  // Drain all runnable work while plutil is held, so a second read cannot hide behind the assertion.
  for (let tick = 0; tick < 30; tick++) {
    await Promise.resolve();
  }
  expect(r.counts).toEqual({ types: 1, plutil: 1 });
  r.gate.resolve();
  expect(await first).toEqual(await second);
});

test("one caller aborts while another receives and caches the shared result", async () => {
  const r = rig();
  r.block();
  const controller = new AbortController();
  const first = r.profiles.profileFor(type.identifier, { signal: controller.signal });
  const second = r.profiles.profileFor(type.identifier);
  await drainUntil(() => r.counts.plutil > 0, { description: "profile read" });
  controller.abort();
  expect(await first).toBeNull();
  expect(r.reads[0].signal).toBeUndefined();
  r.gate.resolve();
  expect(await second).toMatchObject({ pixelWidth: 1206 });
  expect(await r.profiles.profileFor(type.identifier)).toMatchObject({ pixelWidth: 1206 });
  expect(r.counts).toEqual({ types: 1, plutil: 1 });
});

test("a short caller deadline does not change shared read budget or poison persistence", async () => {
  const r = rig();
  r.block();
  const first = r.profiles.profileFor(type.identifier, { timeoutMs: 5 });
  const second = r.profiles.profileFor(type.identifier);
  await drainUntil(() => r.counts.plutil > 0, { description: "profile read" });
  r.timer.advanceTime(5);
  expect(await first).toBeNull();
  expect(r.reads[0].timeoutMs).toBe(15_000);
  r.gate.resolve();
  expect(await second).toMatchObject({ pixelWidth: 1206 });
  const restarted = rig(r.store);
  expect(await restarted.profiles.profileFor(type.identifier)).toMatchObject({ pixelWidth: 1206 });
  expect(restarted.counts).toEqual({ types: 0, plutil: 0 });
});

test("restart reuses both device types and profiles with zero spawns (formerly 1 + 1)", async () => {
  const first = rig();
  await first.profiles.profileFor(type.identifier);
  expect(first.counts).toEqual({ types: 1, plutil: 1 });
  const restarted = rig(first.store);
  await restarted.profiles.prepare();
  expect(await restarted.profiles.profileFor(type.identifier)).toMatchObject({ pixelWidth: 1206 });
  expect(restarted.counts).toEqual({ types: 0, plutil: 0 });
});

test("a stale Xcode key refreshes the list and profile", async () => {
  const first = rig();
  await first.profiles.profileFor(type.identifier);
  first.store.key = "xcode-2";
  const restarted = rig(first.store);
  await restarted.profiles.profileFor(type.identifier);
  expect(restarted.counts).toEqual({ types: 1, plutil: 1 });
  expect(JSON.parse(first.store.contents!).key).toBe("xcode-2");
});

test.each(["{broken", '{"version":1,"key":"xcode-1","deviceTypes":[],"profiles":[{}]}'])(
  "corrupt cache falls back and is repaired: %s",
  async (contents) => {
    const store = new FakeSimulatorProfileStore();
    store.contents = contents;
    const r = rig(store);
    expect(await r.profiles.profileFor(type.identifier)).toMatchObject({ pixelWidth: 1206 });
    expect(r.counts).toEqual({ types: 1, plutil: 1 });
    expect(JSON.parse(store.contents!).profiles[0].pixelWidth).toBe(1206);
  },
);

test.each(["read", "write", "key"])(
  "unreadable %s store cannot fail enrichment",
  async (operation) => {
    const r = rig();
    if (operation === "read") {
      r.store.readError = new Error("denied");
    }
    if (operation === "write") {
      r.store.writeError = new Error("denied");
    }
    if (operation === "key") {
      r.store.keyError = new Error("denied");
    }
    expect(await r.profiles.profileFor(type.identifier)).toMatchObject({ pixelWidth: 1206 });
    expect(r.counts).toEqual({ types: 1, plutil: 1 });
    expect(r.reads[0].timeoutMs).toBe(15_000);
  },
);

test("completed failures are memoized locally but never persisted across restart", async () => {
  const first = rig();
  first.fail(new Error("bad plist"));
  expect(await first.profiles.profileFor(type.identifier)).toBeNull();
  expect(await first.profiles.profileFor(type.identifier)).toBeNull();
  expect(first.counts).toEqual({ types: 1, plutil: 1 });
  const restarted = rig(first.store);
  expect(await restarted.profiles.profileFor(type.identifier)).toMatchObject({ pixelWidth: 1206 });
  expect(restarted.counts).toEqual({ types: 0, plutil: 1 });
});

test("shared plutil timeout is retried rather than memoized", async () => {
  const r = rig();
  r.fail(new Error("plutil timed out"));
  expect(await r.profiles.profileFor(type.identifier)).toBeNull();
  r.fail();
  expect(await r.profiles.profileFor(type.identifier)).toMatchObject({ pixelWidth: 1206 });
  expect(r.counts).toEqual({ types: 1, plutil: 2 });
  expect(JSON.parse(r.store.contents!).profiles[0].pixelWidth).toBe(1206);
});

test("two-device discovery overlaps lists then profiles and both enumerations (serial depth 5 to 2)", async () => {
  const timer = new FakeTimer();
  const listGate = Promise.withResolvers<void>();
  const enrichGate = Promise.withResolvers<void>();
  const started = new Set<string>();
  const budgets: number[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const devices = ["b", "a"].map((udid) => ({
    udid,
    name: udid,
    state: "Booted",
    isAvailable: true,
    deviceTypeIdentifier: type.identifier,
  }));
  const r = rig();
  const lister = {
    getDeviceTypes: async () => {
      started.add("types");
      await listGate.promise;
      return [type];
    },
  };
  const plist: PlistReader = {
    readJsonFile: async () => {
      started.add("plutil");
      await enrichGate.promise;
      return { mainScreenWidth: 1206 };
    },
    readJsonBytes: async () => ({}),
    readXmlFile: async () => "",
    readXmlBytes: async () => "",
    extractRawFile: async () => "",
  };
  const profiles = new SimCtlSimulatorDeviceTypeProfiles(lister, plist, r.store, timer);
  const client = new SimCtlClient(
    null,
    async (_file, args, _buffer, signal) => {
      if (args.includes("devices")) {
        started.add("devices");
        await listGate.promise;
        timer.advanceTime(20);
        return createExecResult(JSON.stringify({ devices: { "iOS-26-0": devices } }), "");
      }
      if (args.includes("enumerate")) {
        started.add(args[2]);
        await enrichGate.promise;
        return createExecResult("", "");
      }
      throw new Error(`Unexpected command ${args.join(" ")}`);
    },
    { timer, platform: "darwin", deviceTypeProfiles: profiles },
  );
  // Record the inventory's remaining-budget handoff without spying on global prototypes.
  const enumerate = client.enumerateDisplays.bind(client);
  client.enumerateDisplays = async (id, timeout, signal) => {
    budgets.push(timeout!);
    signals.push(signal);
    return enumerate(id, timeout, signal);
  };
  const controller = new AbortController();
  const listing = client.listSimulatorImages(100, { bypassCache: true, signal: controller.signal });
  await drainUntil(() => started.has("devices") && started.has("types"), {
    description: "concurrent lists",
  });
  expect([...started].sort()).toEqual(["devices", "types"]);
  listGate.resolve();
  await drainUntil(() => started.has("plutil") && started.has("a") && started.has("b"), {
    description: "concurrent enrichments",
  });
  expect(budgets).toEqual([80, 80]);
  expect(signals.every((signal) => signal === controller.signal)).toBe(true);
  enrichGate.resolve();
  expect((await listing).map((device) => device.deviceId)).toEqual(["a", "b"]);
});

test("a shared device-type timeout aborts its own flight and permits a fresh listing", async () => {
  const r = rig();
  let calls = 0;
  let sharedSignal: AbortSignal | undefined;
  const profiles = new SimCtlSimulatorDeviceTypeProfiles(
    {
      getDeviceTypes: async (signal) => {
        calls++;
        sharedSignal = signal;
        if (calls === 1) {
          return new Promise<AppleDeviceType[]>(() => {});
        }
        return [type];
      },
    },
    {
      readJsonFile: async () => ({ mainScreenWidth: 1206 }),
      readJsonBytes: async () => ({}),
      readXmlFile: async () => "",
      readXmlBytes: async () => "",
      extractRawFile: async () => "",
    },
    r.store,
    r.timer,
  );
  const first = profiles.profileFor(type.identifier);
  await drainUntil(() => calls === 1, { description: "shared type listing" });
  r.timer.advanceTime(15_000);
  expect(await first).toBeNull();
  expect(sharedSignal?.aborted).toBe(true);
  expect(await profiles.profileFor(type.identifier)).toMatchObject({ pixelWidth: 1206 });
  expect(calls).toBe(2);
});

test("already cancelled or expired callers spawn nothing, including on a profile cache hit", async () => {
  const r = rig();
  const controller = new AbortController();
  controller.abort();
  expect(await r.profiles.profileFor(type.identifier, { signal: controller.signal })).toBeNull();
  expect(await r.profiles.profileFor(type.identifier, { timeoutMs: 0 })).toBeNull();
  expect(r.counts).toEqual({ types: 0, plutil: 0 });
  await r.profiles.profileFor(type.identifier);
  expect(await r.profiles.profileFor(type.identifier, { signal: controller.signal })).toBeNull();
});
