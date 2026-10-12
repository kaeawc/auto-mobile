import { expect, test } from "bun:test";
import {
  ANDROID_MAX_BOOTED_ENV,
  AndroidBootAdmissionGate,
} from "../../../src/features/bootAdmission/AndroidBootAdmissionGate";
import { FakeAndroidCapacitySource } from "../../fakes/FakeAndroidCapacitySource";
import { FakeHostBootAdmissionRegistry } from "../../fakes/FakeHostBootAdmissionRegistry";
import { SharedBootAdmissionHostState } from "../../fakes/FakeHostBootAdmissionRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";

// BootCapacitySnapshot: `booted` = booted devices, `inFlight` = "admitted boots not yet visible as
// booted". The admission decision counts a handed-off boot whose qemu process the process table
// shows ONCE (count().effective, #11564). The listDevices capacity report counts the same boot
// twice: once in `booted` (max(adb rows, qemu processes)) and once more in `inFlight`.

const GIB = 1024 ** 3;
const request = { timeoutMs: 60_000, avdName: "Pixel_9" };

test("a booting emulator whose process is listed is reported once, as the gate counts it", async () => {
  const timer = new FakeTimer();
  const source = new FakeAndroidCapacitySource();
  const gate = new AndroidBootAdmissionGate(source, timer, {
    env: { [ANDROID_MAX_BOOTED_ENV]: "2" },
  });
  const boot = await gate.admit(request);
  boot.handOff("emulator-5554", 501);
  // The emulator process exists; adb does not list the serial yet.
  source.emulatorProcessRssBytes = [3 * GIB];
  source.emulatorProcessPids = [501];

  const report = await gate.describeCapacity();

  // The gate itself sees one emulator: a second boot fits under the limit of 2.
  const second = await gate.admit(request);
  second.release();
  // Fails today: { limit: 2, booted: 1, inFlight: 1 } — "2 of 2 used" while a boot is admitted.
  expect(report.booted + report.inFlight).toBe(1);
  boot.release();
});

test("a peer daemon's booting emulator whose process is listed is reported once", async () => {
  const timer = new FakeTimer();
  const host = new SharedBootAdmissionHostState();
  const source = new FakeAndroidCapacitySource();
  const [owner, peer] = [100, 200].map(
    (pid) =>
      new AndroidBootAdmissionGate(source, timer, {
        env: { [ANDROID_MAX_BOOTED_ENV]: "2" },
        hostRegistry: new FakeHostBootAdmissionRegistry(host, pid, timer),
      }),
  );
  const boot = await owner.admit(request);
  boot.handOff("emulator-5554", 4242);
  source.emulatorProcessRssBytes = [3 * GIB];
  source.emulatorProcessPids = [4242];

  const report = await peer.describeCapacity();

  (await peer.admit(request)).release();
  // Fails today: { limit: 2, booted: 1, inFlight: 1 }.
  expect(report.booted + report.inFlight).toBe(1);
  boot.release();
});

test("a listed boot handed off without a pid reports once but keeps the decision safety margin", async () => {
  const source = new FakeAndroidCapacitySource();
  const gate = new AndroidBootAdmissionGate(source, new FakeTimer(), {
    env: { [ANDROID_MAX_BOOTED_ENV]: "1" },
  });
  const admission = await gate.admit(request);
  admission.handOff("emulator-5554");
  source.emulatorSerials = ["emulator-5554"];
  source.emulatorProcessRssBytes = [3 * GIB];

  expect(await gate.describeCapacity()).toMatchObject({ booted: 1, inFlight: 0 });
  await expect(gate.assertCapacityAvailable()).rejects.toMatchObject({
    code: "capacity_exhausted",
    details: { limit: 1 },
  });
  admission.release();
});

test.each([
  { name: "two external adb rows beside the admitted process", listed: 2, used: 3 },
  { name: "an external adb row whose process exited before the table read", listed: 1, used: 2 },
])("capacity report preserves the larger adb view: $name", async ({ listed, used }) => {
  const source = new FakeAndroidCapacitySource();
  const env = { [ANDROID_MAX_BOOTED_ENV]: "4" };
  const gate = new AndroidBootAdmissionGate(source, new FakeTimer(), { env });
  const admission = await gate.admit(request);
  admission.handOff("emulator-5554", 501);
  source.emulatorSerials = ["emulator-5556", "emulator-5558"].slice(0, listed);
  source.emulatorProcessPids = [501];
  source.emulatorProcessRssBytes = [3 * GIB];

  const report = await gate.describeCapacity();

  expect(report).toMatchObject({ booted: listed, inFlight: 1 });
  expect(report.booted + report.inFlight).toBe(used);
  env[ANDROID_MAX_BOOTED_ENV] = String(report.booted + report.inFlight);
  await expect(gate.assertCapacityAvailable()).rejects.toMatchObject({
    code: "capacity_exhausted",
    details: { booted: used, limit: used },
  });
  env[ANDROID_MAX_BOOTED_ENV] = String(report.booted + report.inFlight + 1);
  await expect(gate.assertCapacityAvailable()).resolves.toBeUndefined();
  admission.release();
});

test.each([
  { name: "not spawned or listed", pids: [], serials: [], booted: 0, inFlight: 1 },
  { name: "process visible before adb", pids: [501], serials: [], booted: 1, inFlight: 0 },
  {
    name: "process and adb visible",
    pids: [501],
    serials: ["emulator-5554"],
    booted: 1,
    inFlight: 0,
  },
  {
    name: "external process beside an unspawned boot",
    pids: [999],
    serials: [],
    booted: 1,
    inFlight: 1,
  },
  { name: "process table unavailable", pids: undefined, serials: [], booted: 0, inFlight: 1 },
])(
  "capacity report agrees with the decision: $name",
  async ({ pids, serials, booted, inFlight }) => {
    const source = new FakeAndroidCapacitySource();
    const env = { [ANDROID_MAX_BOOTED_ENV]: "3" };
    const gate = new AndroidBootAdmissionGate(source, new FakeTimer(), { env });
    const admission = await gate.admit(request);
    admission.handOff("emulator-5554", 501);
    source.emulatorSerials = serials;
    source.emulatorProcessPids = pids;
    source.emulatorProcessRssBytes = pids?.map(() => 3 * GIB);
    const report = await gate.describeCapacity();
    expect(report).toMatchObject({ booted, inFlight });
    const used = report.booted + report.inFlight;
    env[ANDROID_MAX_BOOTED_ENV] = String(used);
    await expect(gate.assertCapacityAvailable()).rejects.toMatchObject({
      code: "capacity_exhausted",
      details: { booted: used, limit: used },
    });
    env[ANDROID_MAX_BOOTED_ENV] = String(used + 1);
    await expect(gate.assertCapacityAvailable()).resolves.toBeUndefined();
    admission.release();
  },
);
