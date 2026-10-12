import { expect, test } from "bun:test";
import { AndroidBootAdmissionGate } from "../../../src/features/bootAdmission/AndroidBootAdmissionGate";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import { AndroidBootedDeviceDiscoveryIncompleteError } from "../../../src/models/BootedDeviceDiscoveryIncompleteError";
import { FakeAndroidCapacitySource } from "../../fakes/FakeAndroidCapacitySource";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  FakeBootAdmissionHost,
  FakeHostBootAdmissionRegistry,
} from "../../fakes/FakeHostBootAdmissionRegistry";

const request = { timeoutMs: 1000, avdName: "fake-avd" };
function setup(limit = "1") {
  const timer = new FakeTimer();
  const host = new FakeBootAdmissionHost();
  const source = new FakeAndroidCapacitySource();
  const registries = [100, 200].map((pid) => new FakeHostBootAdmissionRegistry(host, pid, timer));
  const gates = registries.map(
    (hostRegistry) =>
      new AndroidBootAdmissionGate(source, timer, {
        env: { AUTOMOBILE_ANDROID_MAX_BOOTED: limit },
        hostRegistry,
      }),
  );
  return { timer, host, source, registries, gates };
}
async function rejected(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}
function exhausted(error: unknown, booted = 1): void {
  expect(error).toBeInstanceOf(BootCapacityExhaustedError);
  if (error instanceof BootCapacityExhaustedError) {
    expect(error.details.booted).toBe(booted);
  }
}
function incomplete(error: unknown, code = "failed"): void {
  expect(error).toBeInstanceOf(AndroidBootedDeviceDiscoveryIncompleteError);
  if (error instanceof AndroidBootedDeviceDiscoveryIncompleteError) {
    expect(error.code).toBe("discovery_incomplete");
    expect(error.retryable).toBe(true);
    expect(error.discoveryError?.code).toBe(code);
    expect(error.message).toMatch(/registry|admission.lock/);
  }
}

test("1: concurrent daemons admit exactly one; release lets the loser retry", async () => {
  const { gates } = setup();
  const results = await Promise.allSettled(gates.map((gate) => gate.admit(request)));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const winner = results.findIndex((result) => result.status === "fulfilled");
  const loser = 1 - winner;
  const failure = results[loser];
  if (failure.status === "rejected") {
    exhausted(failure.reason);
  }
  const success = results[winner];
  if (success.status === "fulfilled") {
    success.value.release();
  }
  (await gates[loser].admit(request)).release();
});

test("2: a peer admitted before spawn counts without ps for every decision", async () => {
  const { source, gates } = setup();
  source.emulatorProcessRssBytes = undefined;
  const admission = await gates[0].admit(request);
  exhausted(await rejected(gates[1].admit(request)));
  exhausted(await rejected(gates[1].assertCapacityAvailable()));
  expect(await gates[1].describeCapacity()).toEqual({ limit: 1, booted: 0, inFlight: 1 });
  admission.release();
});

test("3: a handed-off peer listed by adb counts once at either limit", async () => {
  const { gates, source, host, timer } = setup("2");
  const first = await gates[0].admit(request);
  first.handOff("emulator-5554", 4242);
  source.emulatorSerials = ["emulator-5554"];
  const tight = new AndroidBootAdmissionGate(source, timer, {
    env: { AUTOMOBILE_ANDROID_MAX_BOOTED: "1" },
    hostRegistry: new FakeHostBootAdmissionRegistry(host, 300, timer),
  });
  exhausted(await rejected(tight.admit(request)));
  (await gates[1].admit(request)).release();
  expect(await gates[1].describeCapacity()).toEqual({ limit: 2, booted: 1, inFlight: 0 });
  first.release();
});

test("3: a handed-off peer matched to its process counts once before adb lists it", async () => {
  const { gates, source } = setup("2");
  const first = await gates[0].admit(request);
  first.handOff("emulator-5554", 4242);
  source.emulatorProcessPids = [4242];
  source.emulatorProcessRssBytes = [1024];
  (await gates[1].admit(request)).release();
  first.release();
});

test("3: a listed peer missing from an older process table adds to external processes", async () => {
  const { gates, source } = setup("2");
  const first = await gates[0].admit(request);
  first.handOff("emulator-5554", 4242);
  source.emulatorSerials = ["emulator-5554"];
  source.emulatorProcessPids = [900];
  source.emulatorProcessRssBytes = [1024];
  exhausted(await rejected(gates[1].admit(request)), 2);
  first.release();
});

test("4: a peer past its boot deadline no longer counts", async () => {
  const { gates, timer } = setup();
  const first = await gates[0].admit(request);
  first.handOff("emulator-5554", 4242);
  timer.advanceTime(request.timeoutMs);
  expect((await gates[1].describeCapacity()).inFlight).toBe(0);
  (await gates[1].admit(request)).release();
  first.release();
});

test("5: a peer removed during a sample still holds its slot for that decision", async () => {
  const { gates, source } = setup();
  const first = await gates[0].admit(request);
  source.onSample = () => first.release();
  exhausted(await rejected(gates[1].admit(request)));
  source.onSample = undefined;
  (await gates[1].admit(request)).release();
});

test("5: read-only samples retain a peer removed mid-sample", async () => {
  const { gates, source } = setup();
  const first = await gates[0].admit(request);
  source.onSample = () => first.release();
  exhausted(await rejected(gates[1].assertCapacityAvailable()));
  source.onSample = undefined;
  const second = await gates[0].admit(request);
  source.onSample = () => second.release();
  expect((await gates[1].describeCapacity()).inFlight).toBe(1);
});

test("6: unreadable registry refuses admit, assert, and describe", async () => {
  const { gates, registries } = setup();
  registries[0].failReads = true;
  incomplete(await rejected(gates[0].admit(request)));
  incomplete(await rejected(gates[0].assertCapacityAvailable()));
  incomplete(await rejected(gates[0].describeCapacity()));
});

test("6: a failed post-sample registry read also refuses", async () => {
  const { gates, registries, source } = setup();
  source.onSample = () => {
    registries[0].failReads = true;
  };
  incomplete(await rejected(gates[0].admit(request)));
});

test("6: publication failure releases the local ledger slot", async () => {
  const { gates, registries } = setup();
  registries[0].failPublish = true;
  incomplete(await rejected(gates[0].admit(request)));
  expect((await gates[0].describeCapacity()).inFlight).toBe(0);
  registries[0].failPublish = false;
  (await gates[0].admit(request)).release();
});

test("6: a held lock times out with retryable discovery_incomplete", async () => {
  const { gates, registries, timer } = setup();
  registries[0].lockHeldForever = true;
  const failure = rejected(gates[0].admit(request));
  timer.advanceTime(request.timeoutMs + 1);
  incomplete(await failure, "timeout");
});

test("6: abort while waiting preserves the abort reason", async () => {
  const { gates, registries } = setup();
  registries[0].lockHeldForever = true;
  const controller = new AbortController();
  const reason = new Error("cancel boot");
  const failure = rejected(gates[0].admit({ ...request, signal: controller.signal }));
  controller.abort(reason);
  expect(await failure).toBe(reason);
});

test("7: no registry preserves in-process admission behavior", async () => {
  const gate = new AndroidBootAdmissionGate(new FakeAndroidCapacitySource(), new FakeTimer(), {
    env: { AUTOMOBILE_ANDROID_MAX_BOOTED: "1" },
  });
  const first = await gate.admit(request);
  exhausted(await rejected(gate.admit(request)));
  first.release();
  (await gate.admit(request)).release();
});

test("8: handOff publishes serial, pid, and deadline; release removes it", async () => {
  const { gates, host } = setup();
  const first = await gates[0].admit(request);
  first.handOff("emulator-5554", 4242);
  first.handOff(undefined, undefined);
  expect([...host.records.values()]).toEqual([
    {
      id: "admission-1",
      ownerPid: 100,
      deviceId: "emulator-5554",
      processId: 4242,
      handedOffUntilMs: 1000,
    },
  ]);
  first.release();
  first.release();
  first.handOff("emulator-5556", 5000);
  expect(host.records.size).toBe(0);
});

test("8: handOff and release never throw on failed registry writes", async () => {
  const { gates, registries } = setup();
  const first = await gates[0].admit(request);
  registries[0].failWrites = true;
  expect(() => first.handOff("emulator-5554", 4242)).not.toThrow();
  expect(() => first.release()).not.toThrow();
  expect((await gates[0].describeCapacity()).inFlight).toBe(0);
});

test("8: a publisher observing adb listing retires the shared record", async () => {
  const { gates, source, host } = setup();
  const first = await gates[0].admit(request);
  first.handOff("emulator-5554", 4242);
  source.emulatorSerials = ["emulator-5554"];
  await gates[0].describeCapacity();
  expect(host.records.size).toBe(0);
  first.release();
});

test("3: a qemu process whose parent is the peer launcher counts once", async () => {
  const { gates, source } = setup("2");
  const first = await gates[0].admit(request);
  first.handOff("emulator-5554", 4242);
  source.emulatorProcessRssBytes = [1024];
  const sample = source.sample.bind(source);
  source.sample = async () => ({
    ...(await sample()),
    emulatorProcessIds: [{ pid: 900, ppid: 4242 }],
  });
  (await gates[1].admit(request)).release();
  first.release();
});

test("6: the host lock wait is bounded by the sample cap", async () => {
  const { gates, registries, timer } = setup();
  registries[0].lockHeldForever = true;
  const failure = rejected(gates[0].admit({ ...request, timeoutMs: 60000 }));
  timer.advanceTime(15000);
  incomplete(await failure, "timeout");
});

test("6: unexpected lock infrastructure errors are mapped to discovery_incomplete", async () => {
  const { gates, registries } = setup();
  registries[0].withAdmissionLock = async () => {
    throw new Error("admission.lock unavailable");
  };
  incomplete(await rejected(gates[0].admit(request)));
});
