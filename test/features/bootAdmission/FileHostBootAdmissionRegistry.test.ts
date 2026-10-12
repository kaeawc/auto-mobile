import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileHostBootAdmissionRegistry } from "../../../src/features/bootAdmission/FileHostBootAdmissionRegistry";
import { HostBootAdmissionRegistryError } from "../../../src/features/bootAdmission/HostBootAdmissionRegistry";
import { AndroidBootAdmissionGate } from "../../../src/features/bootAdmission/AndroidBootAdmissionGate";
import { AndroidBootedDeviceDiscoveryIncompleteError } from "../../../src/models/BootedDeviceDiscoveryIncompleteError";
import { FakeAndroidCapacitySource } from "../../fakes/FakeAndroidCapacitySource";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";

let directory: string;
let timer: FakeTimer;
let live: Set<number>;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "boot-admission-test-"));
  timer = new FakeTimer();
  live = new Set([100, 200]);
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});
function registry(pid = 100, resolver = () => directory): FileHostBootAdmissionRegistry {
  return new FileHostBootAdmissionRegistry({
    directory: resolver,
    pid,
    timer,
    isProcessRunning: (owner) => live.has(owner),
    idGenerator: new FakeIdGenerator(),
  });
}
async function rejected(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}
function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function recordFile(ownerPid: number, id: string, fields: object = {}): string {
  const path = join(directory, `${ownerPid}.${id}.json`);
  writeFileSync(path, JSON.stringify({ ownerPid, id, ...fields }));
  return path;
}

for (const sameInstance of [false, true]) {
  test(`9: mutual exclusion ${sameInstance ? "within one instance" : "across processes"} and waiter proceeds after release`, async () => {
    const first = registry();
    const second = sameInstance ? first : registry(200);
    const held = deferred();
    let entered = 0;
    const owner = first.withAdmissionLock({ timeoutMs: 100 }, async () => {
      entered++;
      await held.promise;
    });
    // Acquisition's async boundary completes before its callback can hold the lock.
    await Promise.resolve();
    const token = readFileSync(join(directory, "admission.lock"), "utf8");
    const waiter = second.withAdmissionLock({ timeoutMs: 100 }, async () => {
      entered++;
    });
    expect(entered).toBe(1);
    expect(readFileSync(join(directory, "admission.lock"), "utf8")).toBe(token);
    held.resolve();
    await owner;
    timer.advanceTime(25);
    await waiter;
    expect(entered).toBe(2);
    expect(existsSync(join(directory, "admission.lock"))).toBe(false);
  });
}

test("9: held lock times out without entering and without deleting its owner", async () => {
  const path = join(directory, "admission.lock");
  writeFileSync(path, "200\npeer-token");
  let entered = false;
  const failure = rejected(
    registry().withAdmissionLock({ timeoutMs: 100 }, async () => {
      entered = true;
    }),
  );
  timer.advanceTime(100);
  const error = await failure;
  expect(error).toBeInstanceOf(HostBootAdmissionRegistryError);
  if (error instanceof HostBootAdmissionRegistryError) {
    expect(error.code).toBe("timeout");
    expect(error.message).toContain(path);
  }
  expect(entered).toBe(false);
  expect(readFileSync(path, "utf8")).toBe("200\npeer-token");
  // The timed-out polling loop cannot acquire later when the owner releases.
  unlinkSync(path);
  timer.advanceTime(100);
  await Promise.resolve();
  expect(entered).toBe(false);
  expect(existsSync(path)).toBe(false);
});

test("9: abort while polling preserves its reason and leaves the owner's lock", async () => {
  writeFileSync(join(directory, "admission.lock"), "200\npeer");
  const controller = new AbortController();
  const reason = { reason: "stop" };
  const failure = rejected(
    registry().withAdmissionLock(
      { timeoutMs: 100, signal: controller.signal },
      async () => undefined,
    ),
  );
  controller.abort(reason);
  expect(await failure).toBe(reason);
  expect(existsSync(join(directory, "admission.lock"))).toBe(true);
});

test("9: a dead owner's lock is reclaimed", async () => {
  writeFileSync(join(directory, "admission.lock"), "300\ndead");
  await registry().withAdmissionLock({ timeoutMs: 100 }, async () => {
    expect(readFileSync(join(directory, "admission.lock"), "utf8")).toBe("100\nfake-1");
  });
  expect(existsSync(join(directory, "admission.lock"))).toBe(false);
});

test("9: callback failure always releases the lock", async () => {
  const reason = new Error("callback failed");
  expect(
    await rejected(
      registry().withAdmissionLock({ timeoutMs: 100 }, async () => {
        throw reason;
      }),
    ),
  ).toBe(reason);
  expect(existsSync(join(directory, "admission.lock"))).toBe(false);
});

test("10: publish, repeated update, and idempotent removal round-trip only to peers", () => {
  const owner = registry();
  const peer = registry(200);
  const admission = owner.publish();
  expect(owner.readPeerAdmissions()).toEqual([]);
  expect(peer.readPeerAdmissions()).toEqual([{ id: "fake-1", ownerPid: 100 }]);
  admission.update({ deviceId: "emulator-5554", handedOffUntilMs: 100 });
  admission.update({ processId: 4242, deviceId: undefined });
  expect(peer.readPeerAdmissions()).toEqual([
    {
      id: "fake-1",
      ownerPid: 100,
      deviceId: "emulator-5554",
      processId: 4242,
      handedOffUntilMs: 100,
    },
  ]);
  expect(readdirSync(directory)).toEqual(["100.fake-1.json"]);
  admission.remove();
  admission.remove();
  admission.update({ processId: 5000 });
  expect(peer.readPeerAdmissions()).toEqual([]);
  expect(readdirSync(directory)).toEqual([]);
});

test("10: expired and dead-owner unspawned records are removed", () => {
  const expired = recordFile(200, "expired", { handedOffUntilMs: 20 });
  const dead = recordFile(300, "unspawned");
  timer.advanceTime(20);
  expect(registry().readPeerAdmissions()).toEqual([]);
  expect(existsSync(expired)).toBe(false);
  expect(existsSync(dead)).toBe(false);
});

test("10: a dead owner's handed-off boot counts until its deadline", () => {
  const path = recordFile(300, "spawned", {
    deviceId: "emulator-5554",
    processId: 4242,
    handedOffUntilMs: 100,
  });
  expect(registry().readPeerAdmissions()).toHaveLength(1);
  expect(existsSync(path)).toBe(true);
  timer.advanceTime(100);
  expect(registry().readPeerAdmissions()).toEqual([]);
  expect(existsSync(path)).toBe(false);
});

test("10: dead-owner unparseable and invalid-shape files are dropped and unlinked", () => {
  const path = join(directory, "300.corrupt.json");
  writeFileSync(path, "{broken");
  const invalid = recordFile(300, "invalid", { processId: "wrong type" });
  expect(registry().readPeerAdmissions()).toEqual([]);
  expect(existsSync(path)).toBe(false);
  expect(existsSync(invalid)).toBe(false);
});

test("10: a live owner's unparseable record fails closed", () => {
  const path = join(directory, "200.corrupt.json");
  writeFileSync(path, "{broken");
  expect(() => registry().readPeerAdmissions()).toThrow(HostBootAdmissionRegistryError);
  expect(() => registry().readPeerAdmissions()).toThrow(path);
  expect(existsSync(path)).toBe(true);
});

test("10: live-owner invalid shapes and mismatched record identities fail closed", () => {
  recordFile(200, "invalid", { handedOffUntilMs: "bad" });
  expect(() => registry().readPeerAdmissions()).toThrow(HostBootAdmissionRegistryError);
  rmSync(join(directory, "200.invalid.json"));
  writeFileSync(
    join(directory, "200.mismatch.json"),
    JSON.stringify({ ownerPid: 100, id: "mismatch" }),
  );
  expect(() => registry().readPeerAdmissions()).toThrow(HostBootAdmissionRegistryError);
});

test("10: missing directory reads empty and publish creates it securely", () => {
  const missing = join(directory, "missing", "android");
  const owner = registry(100, () => missing);
  const peer = registry(200, () => missing);
  expect(peer.readPeerAdmissions()).toEqual([]);
  const published = owner.publish();
  expect(peer.readPeerAdmissions()).toHaveLength(1);
  published.remove();
});

test("10: record IO errors fail closed even when the named owner is dead", () => {
  mkdirSync(join(directory, "300.directory.json"));
  expect(() => registry().readPeerAdmissions()).toThrow(HostBootAdmissionRegistryError);
});

test("10: directory resolver is lazy and re-evaluated for every operation", async () => {
  let resolvable = false;
  const owner = registry(100, () => {
    if (!resolvable) {
      throw new Error("home unavailable");
    }
    return directory;
  });
  expect(() => owner.readPeerAdmissions()).toThrow(HostBootAdmissionRegistryError);
  expect(() => owner.publish()).toThrow(HostBootAdmissionRegistryError);
  expect(
    await rejected(owner.withAdmissionLock({ timeoutMs: 100 }, async () => undefined)),
  ).toBeInstanceOf(HostBootAdmissionRegistryError);
  resolvable = true;
  owner.publish().remove();
  expect(readdirSync(directory)).toEqual([]);
});

test("file-backed registry failures become typed Android discovery errors", async () => {
  const file = join(directory, "not-a-directory");
  writeFileSync(file, "occupied");
  const owner = registry(100, () => file);
  const gate = new AndroidBootAdmissionGate(new FakeAndroidCapacitySource(), timer, {
    hostRegistry: owner,
  });
  for (const operation of [
    () => gate.admit({ avdName: "fake", timeoutMs: 100 }),
    () => gate.assertCapacityAvailable(),
    () => gate.describeCapacity(),
  ]) {
    const error = await rejected(operation());
    expect(error).toBeInstanceOf(AndroidBootedDeviceDiscoveryIncompleteError);
    if (error instanceof AndroidBootedDeviceDiscoveryIncompleteError) {
      expect(error.retryable).toBe(true);
      expect(error.discoveryError?.code).toBe("failed");
      expect(error.message).toContain(file);
    }
  }
});

test("file-backed lock timeout becomes a typed Android discovery timeout", async () => {
  const path = join(directory, "admission.lock");
  writeFileSync(path, "200\npeer");
  const gate = new AndroidBootAdmissionGate(new FakeAndroidCapacitySource(), timer, {
    hostRegistry: registry(),
  });
  const failure = rejected(gate.admit({ avdName: "fake", timeoutMs: 100 }));
  timer.advanceTime(100);
  const error = await failure;
  expect(error).toBeInstanceOf(AndroidBootedDeviceDiscoveryIncompleteError);
  if (error instanceof AndroidBootedDeviceDiscoveryIncompleteError) {
    expect(error.code).toBe("discovery_incomplete");
    expect(error.retryable).toBe(true);
    expect(error.discoveryError?.code).toBe("timeout");
    expect(error.message).toContain(path);
  }
});
