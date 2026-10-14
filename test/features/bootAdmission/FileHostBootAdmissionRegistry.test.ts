import { beforeEach, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  readdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import {
  ADMISSION_LOCK_MAX_AGE_MS,
  INVALID_ADMISSION_RECORD_MAX_AGE_MS,
  FileHostBootAdmissionRegistry,
} from "../../../src/features/bootAdmission/FileHostBootAdmissionRegistry";
import { HostBootAdmissionRegistryError } from "../../../src/features/bootAdmission/HostBootAdmissionRegistry";
import { AndroidBootAdmissionGate } from "../../../src/features/bootAdmission/AndroidBootAdmissionGate";
import { AndroidBootedDeviceDiscoveryIncompleteError } from "../../../src/models/BootedDeviceDiscoveryIncompleteError";
import { FakeAndroidCapacitySource } from "../../fakes/FakeAndroidCapacitySource";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { logger } from "../../../src/utils/logger";
import { useScratchRoot } from "../../helpers/scratchRoot";

const scratch = useScratchRoot("boot-admission-test-");
let directory: string;
let timer: FakeTimer;
let live: Set<number>;
let tokens: Map<number, string>;
let throwingTokenPids: Set<number>;
beforeEach(() => {
  directory = scratch.next();
  timer = new FakeTimer();
  live = new Set([100, 200]);
  tokens = new Map();
  throwingTokenPids = new Set();
});
function registry(pid = 100, resolver = () => directory): FileHostBootAdmissionRegistry {
  return new FileHostBootAdmissionRegistry({
    directory: resolver,
    pid,
    timer,
    isProcessRunning: (owner) => live.has(owner),
    readProcessGenerationToken: (pid) => {
      if (throwingTokenPids.has(pid)) {
        throw new Error("fake token reader failed");
      }
      return tokens.get(pid);
    },
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

test("10: a dead owner's handed-off boot with a live emulator counts until its deadline", () => {
  live.add(4242);
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

test("hand-off: a dead owner and dead emulator are removed before the deadline", () => {
  const path = recordFile(300, "both-dead", {
    processId: 4242,
    handedOffUntilMs: 360000,
  });
  expect(registry().readPeerAdmissions()).toEqual([]);
  expect(existsSync(path)).toBe(false);
});

test("hand-off: a live owner preserves a dead emulator's admission", () => {
  const path = recordFile(200, "live-owner", {
    processId: 4242,
    handedOffUntilMs: 360000,
  });
  expect(registry().readPeerAdmissions()).toHaveLength(1);
  expect(existsSync(path)).toBe(true);
});

for (const recycled of ["owner", "emulator"] as const) {
  test(`hand-off: a recycled ${recycled} PID and the other dead process are removed`, () => {
    const pid = recycled === "owner" ? 300 : 4242;
    live.add(pid);
    tokens.set(pid, "linux:boot:20");
    const path = recordFile(300, "recycled", {
      ownerGenerationToken: "linux:boot:10",
      processGenerationToken: "linux:boot:10",
      processId: 4242,
      handedOffUntilMs: 360000,
    });
    expect(registry().readPeerAdmissions()).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });
}

for (const role of ["owner", "emulator"] as const) {
  for (const identity of [
    "unreadable",
    "throwing",
    "missing",
    "incomparable",
    "same",
    "legacy-darwin",
  ] as const) {
    test(`hand-off: a running ${role} with ${identity} identity is preserved`, () => {
      const pid = role === "owner" ? 300 : 4242;
      live.add(pid);
      if (identity === "throwing") {
        throwingTokenPids.add(pid);
      } else if (identity !== "unreadable") {
        tokens.set(pid, identity === "same" ? "linux:boot:10" : "linux:boot:20");
      }
      const recordedToken =
        identity === "missing"
          ? undefined
          : identity === "incomparable"
            ? "darwin-utc:old-start"
            : identity === "legacy-darwin"
              ? "darwin:old-start"
              : "linux:boot:10";
      if (identity === "legacy-darwin") {
        tokens.set(pid, "darwin:new-start");
      }
      const path = recordFile(300, "uncertain", {
        ownerGenerationToken: role === "owner" ? recordedToken : undefined,
        processGenerationToken: role === "emulator" ? recordedToken : undefined,
        processId: 4242,
        handedOffUntilMs: 360000,
      });
      expect(registry().readPeerAdmissions()).toHaveLength(1);
      expect(existsSync(path)).toBe(true);
    });
  }
}

test("hand-off: a dead owner without an emulator PID counts until its deadline", () => {
  const path = recordFile(300, "unknown-emulator", { handedOffUntilMs: 360000 });
  expect(registry().readPeerAdmissions()).toHaveLength(1);
  expect(existsSync(path)).toBe(true);
  timer.advanceTime(360000);
  expect(registry().readPeerAdmissions()).toEqual([]);
  expect(existsSync(path)).toBe(false);
});

test("publish and update stamp generation tokens and peers parse them alongside legacy records", () => {
  tokens.set(100, "linux:boot:10");
  tokens.set(4242, "linux:boot:20");
  const admission = registry().publish();
  const path = join(directory, "100.fake-1.json");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    id: "fake-1",
    ownerPid: 100,
    ownerGenerationToken: "linux:boot:10",
  });
  admission.update({ processId: 4242, handedOffUntilMs: 360000 });
  const stamped = {
    id: "fake-1",
    ownerPid: 100,
    ownerGenerationToken: "linux:boot:10",
    processId: 4242,
    processGenerationToken: "linux:boot:20",
    handedOffUntilMs: 360000,
  };
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(stamped);
  recordFile(200, "legacy", { processId: 4242, handedOffUntilMs: 360000 });
  expect(registry(300).readPeerAdmissions()).toEqual([
    stamped,
    { ownerPid: 200, id: "legacy", processId: 4242, handedOffUntilMs: 360000 },
  ]);
});

for (const identity of ["unreadable", "throwing"] as const) {
  test(`publish and update omit ${identity} tokens and clear the previous emulator identity`, () => {
    if (identity === "throwing") {
      throwingTokenPids.add(100);
      throwingTokenPids.add(5000);
    }
    tokens.set(4242, "linux:boot:20");
    const admission = registry().publish();
    const path = join(directory, "100.fake-1.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ id: "fake-1", ownerPid: 100 });
    admission.update({ processId: 4242 });
    expect(JSON.parse(readFileSync(path, "utf8")).processGenerationToken).toBe("linux:boot:20");
    admission.update({ deviceId: "emulator-5554" });
    expect(JSON.parse(readFileSync(path, "utf8")).processGenerationToken).toBe("linux:boot:20");
    admission.update({ processId: 5000 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      id: "fake-1",
      ownerPid: 100,
      processId: 5000,
      deviceId: "emulator-5554",
    });
  });
}

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

test("F3a: a live owner's unspawned record expires at its admission deadline", () => {
  timer.setCurrentTime(1800000000000);
  const admittedUntilMs = timer.now() + 100;
  const admission = registry(200).publish({ admittedUntilMs });
  const [record] = registry().readPeerAdmissions();
  expect(record.admittedUntilMs).toBe(admittedUntilMs);
  const path = join(directory, `${record.ownerPid}.${record.id}.json`);
  expect(existsSync(path)).toBe(true);
  timer.advanceTime(100);
  expect(registry().readPeerAdmissions()).toEqual([]);
  expect(existsSync(path)).toBe(false);
  admission.remove();
});

test("F3b: old live-owner corrupt files are dropped while young files fail closed", () => {
  timer.setCurrentTime(1800000000000);
  const corrupt = join(directory, "200.corrupt.json");
  const valid = recordFile(200, "valid");
  writeFileSync(corrupt, "");
  const youngMs = timer.now() - INVALID_ADMISSION_RECORD_MAX_AGE_MS + 5000;
  utimesSync(corrupt, youngMs / 1000, youngMs / 1000);
  expect(() => registry().readPeerAdmissions()).toThrow(HostBootAdmissionRegistryError);
  expect(existsSync(corrupt)).toBe(true);
  const oldMs = timer.now() - INVALID_ADMISSION_RECORD_MAX_AGE_MS - 5000;
  utimesSync(corrupt, oldMs / 1000, oldMs / 1000);
  const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
  try {
    expect(registry().readPeerAdmissions()).toEqual([{ id: "valid", ownerPid: 200 }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(corrupt);
    expect(existsSync(corrupt)).toBe(false);
    expect(existsSync(valid)).toBe(true);
  } finally {
    warn.mockRestore();
  }
});

test("F3c: old live-owner locks are taken over, young locks remain held", async () => {
  timer.setCurrentTime(1800000000000);
  const path = join(directory, "admission.lock");
  writeFileSync(path, "200\nold-peer-token");
  const oldMs = timer.now() - ADMISSION_LOCK_MAX_AGE_MS - 5000;
  utimesSync(path, oldMs / 1000, oldMs / 1000);
  let entered = 0;
  const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
  try {
    const acquisition = registry().withAdmissionLock({ timeoutMs: 100 }, async () => {
      entered++;
      expect(readFileSync(path, "utf8")).toBe("100\nfake-1");
    });
    timer.advanceTime(100);
    await acquisition;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(path);
    expect(warn.mock.calls[0][0]).toContain("200");
  } finally {
    warn.mockRestore();
  }
  expect(entered).toBe(1);
  expect(existsSync(path)).toBe(false);
  writeFileSync(path, "200\nfresh-peer-token");
  const youngMs = timer.now() - ADMISSION_LOCK_MAX_AGE_MS + 5000;
  utimesSync(path, youngMs / 1000, youngMs / 1000);
  const failure = rejected(
    registry().withAdmissionLock({ timeoutMs: 100 }, async () => {
      entered++;
    }),
  );
  timer.advanceTime(100);
  const error = await failure;
  expect(error).toBeInstanceOf(HostBootAdmissionRegistryError);
  if (error instanceof HostBootAdmissionRegistryError) {
    expect(error.code).toBe("timeout");
  }
  expect(entered).toBe(1);
  expect(readFileSync(path, "utf8")).toBe("200\nfresh-peer-token");
});

test("F4: a corrupt read logs and wraps its path only once", () => {
  timer.setCurrentTime(1800000000000);
  const path = join(directory, "200.corrupt.json");
  writeFileSync(path, "{broken");
  utimesSync(path, timer.now() / 1000, timer.now() / 1000);
  const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
  try {
    let failure: unknown;
    try {
      registry().readPeerAdmissions();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HostBootAdmissionRegistryError);
    if (failure instanceof HostBootAdmissionRegistryError) {
      expect(failure.message).toContain(path);
      expect(failure.message.split("Host boot registry failed at")).toHaveLength(2);
      expect(failure.message.split(path)).toHaveLength(2);
    }
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

test("F4: an unreadable lock logs and wraps once through tryAcquire", async () => {
  const path = join(directory, "admission.lock");
  mkdirSync(path);
  const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
  try {
    const failure = await rejected(
      registry().withAdmissionLock({ timeoutMs: 100 }, async () => undefined),
    );
    expect(failure).toBeInstanceOf(HostBootAdmissionRegistryError);
    if (failure instanceof HostBootAdmissionRegistryError) {
      expect(failure.message.split("Host boot registry failed at")).toHaveLength(2);
      expect(failure.message.split(path)).toHaveLength(2);
    }
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

test("F3c: the constructor can override the stale-lock age for tests", async () => {
  timer.setCurrentTime(1800000000000);
  const path = join(directory, "admission.lock");
  writeFileSync(path, "200\npeer-token");
  const oldMs = timer.now() - 1000 - 5000;
  utimesSync(path, oldMs / 1000, oldMs / 1000);
  const owner = new FileHostBootAdmissionRegistry({
    directory: () => directory,
    timer,
    pid: 100,
    isProcessRunning: (pid) => live.has(pid),
    idGenerator: new FakeIdGenerator(),
    lockMaxAgeMs: 1000,
  });
  let entered = false;
  await owner.withAdmissionLock({ timeoutMs: 100 }, async () => {
    entered = true;
  });
  expect(entered).toBe(true);
  expect(existsSync(path)).toBe(false);
});

test("F3a: the hand-off deadline takes precedence over the original admission deadline", () => {
  timer.setCurrentTime(1800000000000);
  const path = recordFile(200, "handed-off", {
    admittedUntilMs: timer.now() - 1,
    handedOffUntilMs: timer.now() + 100,
  });
  expect(registry().readPeerAdmissions()).toHaveLength(1);
  timer.advanceTime(100);
  expect(registry().readPeerAdmissions()).toEqual([]);
  expect(existsSync(path)).toBe(false);
});
