import { expect, test } from "bun:test";
import {
  ANDROID_EMULATOR_MEMORY_POLICY,
  estimateSettledPerDeviceBytes,
  type InFlightBootMemory,
} from "../../../src/features/bootAdmission/capacityLimits";
import {
  FakeHostBootAdmissionRegistry,
  SharedBootAdmissionHostState,
} from "../../fakes/FakeHostBootAdmissionRegistry";
import { AndroidBootAdmissionGate } from "../../../src/features/bootAdmission/AndroidBootAdmissionGate";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import { FakeAndroidCapacitySource } from "../../fakes/FakeAndroidCapacitySource";
import { FakeTimer } from "../../fakes/FakeTimer";

// Regression #12036: the old derived limit was host RAM x 0.5 / per-emulator bytes, where per-emulator bytes is the
// average RSS of every qemu process in the sample (clamped to 1.5..8 GiB), or 4 GiB when none is
// measured. A qemu process that was spawned seconds ago has touched almost none of its guest RAM,
// so the first admitted boot drags the average to the 1.5 GiB floor and the limit jumps (2 -> 5 on
// a 16 GiB host) exactly while boots are in flight: the gate then admits concurrent cold boots it
// refuses on the same host once those emulators have finished booting.

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const request = { timeoutMs: 120_000, avdName: "Pixel_9" };

function setup() {
  const timer = new FakeTimer();
  const source = new FakeAndroidCapacitySource();
  // No AUTOMOBILE_ANDROID_MAX_BOOTED: the default, derived limit.
  const gate = new AndroidBootAdmissionGate(source, timer, { env: {} });
  // 16 GiB x 0.5 / 4 GiB default = 2; 16 cores / 2 = 8.
  source.host = { totalMemoryBytes: 16 * GIB, cpuCount: 16 };
  return { source, gate };
}

test("a just-spawned emulator's small RSS does not raise the derived limit", async () => {
  const { source, gate } = setup();
  expect((await gate.describeCapacity()).limit).toBe(2);

  const first = await gate.admit(request);
  first.handOff("emulator-5554", 501);
  // The boot's own qemu process, seconds old: 150 MiB resident of a 4 GiB guest.
  source.emulatorProcessRssBytes = [150 * MIB];
  source.emulatorProcessPids = [501];

  // The in-flight process must not replace the 4 GiB default with the 1.5 GiB floor.
  expect((await gate.describeCapacity()).limit).toBe(2);
  first.release();
});

test("boots in flight do not let a third cold boot through a host limit of two", async () => {
  const { source, gate } = setup();
  const first = await gate.admit(request);
  first.handOff("emulator-5554", 501);
  source.emulatorProcessRssBytes = [150 * MIB];
  source.emulatorProcessPids = [501];
  const second = await gate.admit(request);
  second.handOff("emulator-5556", 502);
  source.emulatorProcessRssBytes = [400 * MIB, 150 * MIB];
  source.emulatorProcessPids = [501, 502];

  const third = await gate.admit(request).then(
    (admission) => admission,
    (error: unknown) => error,
  );

  // Both in-flight boots retain the default-derived limit of two.
  expect(third).toBeInstanceOf(BootCapacityExhaustedError);

  // The same three emulators once booted (4 GiB each) are over the limit the gate then derives.
  source.emulatorSerials = ["emulator-5554", "emulator-5556", "emulator-5558"];
  source.emulatorProcessRssBytes = [4 * GIB, 4 * GIB, 4 * GIB];
  source.emulatorProcessPids = [501, 502, 503];
  expect(await gate.describeCapacity()).toMatchObject({ limit: 2, booted: 3 });
});

const settledSets = [[], [2], [6], [2, 6], [1, 1, 1]];
const matrix = [8, 16, 32, 64].flatMap((hostGiB) =>
  settledSets.map((settledGiB) => ({ hostGiB, settledGiB, name: settledGiB.join(",") })),
);

test.each(matrix)(
  "$hostGiB GiB host, settled [$name]: admission never raises the limit and agrees with the report",
  async ({ hostGiB, settledGiB }) => {
    const source = new FakeAndroidCapacitySource();
    source.host = { totalMemoryBytes: hostGiB * GIB, cpuCount: 64 };
    source.emulatorSerials = settledGiB.map((_, index) => `settled-${index}`);
    source.emulatorProcessPids = settledGiB.map((_, index) => 1000 + index);
    source.emulatorProcessRssBytes = settledGiB.map((gib) => gib * GIB);
    const gate = new AndroidBootAdmissionGate(source, new FakeTimer(), { env: {} });
    const initial = (await gate.describeCapacity()).limit;
    for (let index = 0; index <= 8; index++) {
      const before = await gate.describeCapacity();
      const full = before.booted + before.inFlight >= before.limit;
      if (full) {
        await expect(gate.admit(request)).rejects.toBeInstanceOf(BootCapacityExhaustedError);
        await expect(gate.assertCapacityAvailable()).rejects.toMatchObject({
          details: { limit: before.limit, booted: before.booted + before.inFlight },
        });
        return;
      }
      expect(index).toBeLessThan(8);
      await expect(gate.assertCapacityAvailable()).resolves.toBeUndefined();
      const boot = await gate.admit(request);
      await expectNonIncreasingLimit(gate, before.limit, initial);
      boot.handOff(`boot-${index}`, 2000 + index);
      await expectNonIncreasingLimit(gate, before.limit, initial);
      source.emulatorProcessPids.push(2000 + index);
      source.emulatorProcessRssBytes.push(150 * MIB);
      await expectNonIncreasingLimit(gate, before.limit, initial);
    }
  },
);

async function expectNonIncreasingLimit(
  gate: AndroidBootAdmissionGate,
  before: number,
  initial: number,
): Promise<void> {
  const report = await gate.describeCapacity();
  expect(report.limit).toBeLessThanOrEqual(before);
  expect(report.limit).toBeLessThanOrEqual(initial);
}

test("peer boot RSS preserves the limit and two peers refuse a third host boot", async () => {
  const timer = new FakeTimer();
  const host = new SharedBootAdmissionHostState();
  const source = new FakeAndroidCapacitySource();
  source.host = { totalMemoryBytes: 16 * GIB, cpuCount: 16 };
  const [owner, peer] = [100, 200].map(
    (pid) =>
      new AndroidBootAdmissionGate(source, timer, {
        env: {},
        hostRegistry: new FakeHostBootAdmissionRegistry(host, pid, timer),
      }),
  );
  expect((await peer.describeCapacity()).limit).toBe(2);
  const first = await owner.admit(request);
  first.handOff("emulator-5554", 4242);
  source.emulatorProcessPids = [4242];
  source.emulatorProcessRssBytes = [150 * MIB];
  expect(await peer.describeCapacity()).toMatchObject({ limit: 2, booted: 1, inFlight: 0 });
  const second = await owner.admit(request);
  second.handOff("emulator-5556", 4243);
  source.emulatorProcessPids.push(4243);
  source.emulatorProcessRssBytes.push(150 * MIB);
  expect(await peer.describeCapacity()).toMatchObject({ limit: 2, booted: 2, inFlight: 0 });
  await expect(peer.admit(request)).rejects.toBeInstanceOf(BootCapacityExhaustedError);
  await expect(peer.assertCapacityAvailable()).rejects.toMatchObject({ details: { limit: 2 } });
  first.release();
  second.release();
});

test.each([
  { name: "hand-off without pid", handedOffPid: undefined, sampledPids: [501] },
  { name: "table without ids", handedOffPid: 501, sampledPids: undefined },
])("unknown process: $name retains the default", async ({ handedOffPid, sampledPids }) => {
  const { source, gate } = setup();
  const boot = await gate.admit(request);
  boot.handOff("emulator-5554", handedOffPid);
  source.emulatorProcessPids = sampledPids ? [...sampledPids] : undefined;
  source.emulatorProcessRssBytes = [150 * MIB];
  expect((await gate.describeCapacity()).limit).toBe(2);
  await expect(gate.admit(request)).rejects.toBeInstanceOf(BootCapacityExhaustedError);
  boot.release();
});

test("unknown processes keep the largest settled row beside two boots", async () => {
  const source = new FakeAndroidCapacitySource();
  source.host = { totalMemoryBytes: 64 * GIB, cpuCount: 64 };
  source.emulatorSerials = ["settled"];
  source.emulatorProcessPids = [900];
  source.emulatorProcessRssBytes = [8 * GIB];
  const gate = new AndroidBootAdmissionGate(source, new FakeTimer(), { env: {} });
  expect((await gate.describeCapacity()).limit).toBe(4);
  const first = await gate.admit(request);
  first.handOff("emulator-5554");
  const second = await gate.admit(request);
  second.handOff("emulator-5556");
  source.emulatorProcessPids.push(501);
  source.emulatorProcessRssBytes.push(100 * MIB);
  expect((await gate.describeCapacity()).limit).toBe(4);
  first.release();
  second.release();
});

test.each([
  { name: "listed 3 GiB row", listed: true, bytes: 3 * GIB, limit: 2 },
  { name: "listed 150 MiB row", listed: true, bytes: 150 * MIB, limit: 5 },
  { name: "released 150 MiB row", listed: false, bytes: 150 * MIB, limit: 5 },
])("release point: $name is settled", async ({ listed, bytes, limit }) => {
  const { source, gate } = setup();
  const boot = await gate.admit(request);
  boot.handOff("emulator-5554", 501);
  source.emulatorProcessPids = [501];
  source.emulatorProcessRssBytes = [bytes];
  expect((await gate.describeCapacity()).limit).toBe(2);
  if (listed) {
    source.emulatorSerials = ["emulator-5554"];
  } else {
    boot.release();
  }
  // Small RSS after listing/release still gives the old 1.5 GiB floor: the documented open
  // question, not a goal of this fix. No new settling timer extends admission ownership.
  expect(await gate.describeCapacity()).toMatchObject({ limit, booted: 1, inFlight: 0 });
  if (limit === 2) {
    await expect(gate.assertCapacityAvailable()).resolves.toBeUndefined();
    (await gate.admit(request)).release();
  }
  boot.release();
});

test("expired hand-off stops excluding its process", async () => {
  const timer = new FakeTimer();
  const source = new FakeAndroidCapacitySource();
  source.host = { totalMemoryBytes: 16 * GIB, cpuCount: 16 };
  const gate = new AndroidBootAdmissionGate(source, timer, { env: {} });
  const boot = await gate.admit(request);
  boot.handOff("emulator-5554", 501);
  source.emulatorProcessPids = [501];
  source.emulatorProcessRssBytes = [150 * MIB];
  timer.advanceTime(request.timeoutMs);
  expect(await gate.describeCapacity()).toMatchObject({ limit: 5, booted: 1, inFlight: 0 });
  boot.release();
});

test("a boot released during the sample stays excluded for that sample only", async () => {
  const { source, gate } = setup();
  const boot = await gate.admit(request);
  boot.handOff("emulator-5554", 501);
  source.emulatorProcessPids = [501];
  source.emulatorProcessRssBytes = [150 * MIB];
  source.onSample = () => boot.release();
  expect((await gate.describeCapacity()).limit).toBe(2);
  source.onSample = undefined;
  expect((await gate.describeCapacity()).limit).toBe(5);
});

test("a newer listing preserves an unknown boot's hand-off flag in an older sample", async () => {
  const source = new FakeAndroidCapacitySource();
  source.host = { totalMemoryBytes: 16 * GIB, cpuCount: 16 };
  let takeNewerListing = false;
  const gate = new AndroidBootAdmissionGate(
    {
      sample: async () => {
        const sample = await source.sample();
        if (takeNewerListing) {
          takeNewerListing = false;
          source.emulatorSerials = ["emulator-5554"];
          expect((await gate.describeCapacity()).limit).toBe(5);
        }
        return sample;
      },
    },
    new FakeTimer(),
    { env: {} },
  );
  const boot = await gate.admit(request);
  boot.handOff("emulator-5554");
  source.emulatorProcessRssBytes = [150 * MIB];
  source.emulatorProcessPids = [501];
  takeNewerListing = true;
  expect((await gate.describeCapacity()).limit).toBe(2);
  expect((await gate.describeCapacity()).limit).toBe(5);
  boot.release();
});

test("settled emulators keep the existing measured average", async () => {
  const { source, gate } = setup();
  source.emulatorSerials = ["emulator-5554", "emulator-5556"];
  source.emulatorProcessPids = [501, 502];
  source.emulatorProcessRssBytes = [2 * GIB, 2 * GIB];
  expect(await gate.describeCapacity()).toMatchObject({ limit: 4, booted: 2, inFlight: 0 });
});

test("failed process sampling keeps the default and admits against adb plus reservations", async () => {
  const { source, gate } = setup();
  const first = await gate.admit(request);
  first.handOff("emulator-5554", 501);
  source.emulatorProcessRssBytes = undefined;
  expect(await gate.describeCapacity()).toMatchObject({ limit: 2, booted: 0, inFlight: 1 });
  await expect(gate.assertCapacityAvailable()).resolves.toBeUndefined();
  const second = await gate.admit(request);
  expect(await gate.describeCapacity()).toMatchObject({ limit: 2, booted: 0, inFlight: 2 });
  await expect(gate.admit(request)).rejects.toBeInstanceOf(BootCapacityExhaustedError);
  first.release();
  source.emulatorSerials = ["emulator-5554"];
  expect(await gate.describeCapacity()).toMatchObject({ limit: 2, booted: 1, inFlight: 1 });
  second.release();
});

const unknownBoot: InFlightBootMemory = { handedOff: true };
const unspawnedBoot: InFlightBootMemory = { handedOff: false };
const sizingCases = [
  {
    name: "charge default beside 2 GiB",
    rss: [2 * GIB],
    boots: [unspawnedBoot],
    expected: 3 * GIB,
  },
  {
    name: "charge settled average above default",
    rss: [6 * GIB],
    boots: [unspawnedBoot],
    expected: 6 * GIB,
  },
  { name: "minimum clamp", rss: [100 * MIB], boots: [], expected: 1.5 * GIB },
  { name: "maximum clamp", rss: [12 * GIB], boots: [unspawnedBoot], expected: 8 * GIB },
  { name: "empty table", rss: [], boots: [unspawnedBoot], expected: 4 * GIB },
  {
    name: "smallest unknown row dropped",
    rss: [100 * MIB, 2 * GIB, 6 * GIB],
    boots: [unknownBoot],
    expected: 4 * GIB,
  },
  {
    name: "largest row kept",
    rss: [8 * GIB, 100 * MIB],
    boots: [unknownBoot, unknownBoot],
    expected: 8 * GIB,
  },
  { name: "default floor at equality", rss: [2 * GIB], boots: [unknownBoot], expected: 4 * GIB },
  {
    name: "default floor beyond remaining",
    rss: [100 * MIB],
    boots: [unknownBoot, unknownBoot],
    expected: 4 * GIB,
  },
  {
    name: "unspawned boot drops nothing",
    rss: [2 * GIB, 6 * GIB],
    boots: [unspawnedBoot],
    expected: 4 * GIB,
  },
  {
    name: "known pid not yet sampled drops nothing",
    rss: [2 * GIB, 6 * GIB],
    boots: [{ handedOff: true, processId: 999 }],
    expected: 4 * GIB,
  },
];

test.each(sizingCases)("pure sizing: $name", ({ rss, boots, expected }) => {
  const rows = rss.map((rssBytes, index) => ({ rssBytes, pid: 500 + index, ppid: 1 }));
  expect(estimateSettledPerDeviceBytes(rows, boots, ANDROID_EMULATOR_MEMORY_POLICY)).toBe(expected);
  expect(rows.map((row) => row.rssBytes)).toEqual(rss);
});

test("pure sizing excludes every matching pid and parent pid", () => {
  const rows = [
    { rssBytes: 100 * MIB, pid: 501, ppid: 1 },
    { rssBytes: 150 * MIB, pid: 502, ppid: 501 },
    { rssBytes: 2 * GIB, pid: 900, ppid: 1 },
  ];
  const boots = [{ processId: 501, handedOff: true }];
  expect(estimateSettledPerDeviceBytes(rows, boots, ANDROID_EMULATOR_MEMORY_POLICY)).toBe(3 * GIB);
  expect(
    estimateSettledPerDeviceBytes(rows.slice(0, 2), boots, ANDROID_EMULATOR_MEMORY_POLICY),
  ).toBe(4 * GIB);
});

test("pure sizing treats handed-off known pids as unknown when the table has no ids", () => {
  const rows = [100 * MIB, 8 * GIB].map((rssBytes) => ({ rssBytes }));
  const boots = [
    { processId: 501, handedOff: true },
    { processId: 502, handedOff: true },
  ];
  expect(estimateSettledPerDeviceBytes(rows, boots, ANDROID_EMULATOR_MEMORY_POLICY)).toBe(8 * GIB);
  expect(estimateSettledPerDeviceBytes(undefined, boots, ANDROID_EMULATOR_MEMORY_POLICY)).toBe(
    4 * GIB,
  );
});
