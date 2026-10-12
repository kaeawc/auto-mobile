import { beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { adbServerScope } from "../../../src/daemon/foreignDeviceOwnership";
import { AndroidBootAdmissionGate } from "../../../src/features/bootAdmission/AndroidBootAdmissionGate";
import { FileHostBootAdmissionRegistry } from "../../../src/features/bootAdmission/FileHostBootAdmissionRegistry";
import { androidBootAdmissionRegistryDirectory } from "../../../src/features/bootAdmission/sharedBootAdmissionGates";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import { AndroidBootedDeviceDiscoveryIncompleteError } from "../../../src/models/BootedDeviceDiscoveryIncompleteError";
import { FakeAndroidCapacitySource } from "../../fakes/FakeAndroidCapacitySource";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { useScratchRoot } from "../../helpers/scratchRoot";

const scratch = useScratchRoot("boot-admission-location-");
const request = { timeoutMs: 120_000, avdName: "fake-avd" };
let homeDir: string;
let timer: FakeTimer;
let source: FakeAndroidCapacitySource;
let live: Set<number>;
let firstEnv: NodeJS.ProcessEnv;
let secondEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  homeDir = scratch.next();
  timer = new FakeTimer();
  source = new FakeAndroidCapacitySource();
  source.emulatorSerials = [
    "emulator-5556",
    "emulator-5558",
    "emulator-5560",
    "emulator-5562",
    "emulator-5564",
  ];
  // Failed ps, and adb has not yet listed the newly handed-off boot.
  source.emulatorProcessRssBytes = undefined;
  live = new Set([100, 200]);
  firstEnv = {
    AUTOMOBILE_COORDINATION_DIR: join(homeDir, "coordination-1"),
    AUTOMOBILE_DATA_DIR: join(homeDir, "data-1"),
    AUTOMOBILE_DB_DIR: join(homeDir, "db-1"),
    HOME: join(homeDir, "env-home-1"),
  };
  secondEnv = {
    AUTOMOBILE_COORDINATION_DIR: join(homeDir, "coordination-2"),
    AUTOMOBILE_DATA_DIR: join(homeDir, "data-2"),
    AUTOMOBILE_DB_DIR: join(homeDir, "db-2"),
    HOME: join(homeDir, "env-home-2"),
  };
});

function gate(pid: number, daemonEnv: NodeJS.ProcessEnv): AndroidBootAdmissionGate {
  return new AndroidBootAdmissionGate(source, timer, {
    env: { AUTOMOBILE_ANDROID_MAX_BOOTED: "6" },
    hostRegistry: new FileHostBootAdmissionRegistry({
      directory: () => androidBootAdmissionRegistryDirectory(daemonEnv, homeDir),
      pid,
      timer,
      isProcessRunning: (p) => live.has(p),
      idGenerator: new FakeIdGenerator(),
    }),
  });
}

test("registry ignores general coordination, data, database, and HOME overrides", () => {
  const expected = join(
    homeDir,
    ".auto-mobile",
    "adb-servers",
    "tcp-localhost-5037",
    "boot-admissions",
    "android",
  );
  expect(androidBootAdmissionRegistryDirectory(firstEnv, homeDir)).toBe(expected);
  expect(androidBootAdmissionRegistryDirectory(secondEnv, homeDir)).toBe(expected);
});

test("registry is scoped to the adb server under the documented override root", () => {
  secondEnv.ANDROID_ADB_SERVER_PORT = "5038";
  expect(androidBootAdmissionRegistryDirectory(secondEnv, homeDir)).toBe(
    join(
      homeDir,
      ".auto-mobile",
      "adb-servers",
      "tcp-localhost-5038",
      "boot-admissions",
      "android",
    ),
  );
  expect(androidBootAdmissionRegistryDirectory(secondEnv, homeDir)).not.toBe(
    androidBootAdmissionRegistryDirectory(firstEnv, homeDir),
  );
  const override = join(homeDir, "shared-adb-root");
  for (const env of [firstEnv, secondEnv]) {
    env.AUTOMOBILE_ADB_SERVER_COORDINATION_DIR = override;
    expect(androidBootAdmissionRegistryDirectory(env, homeDir)).toBe(
      join(override, adbServerScope(env), "boot-admissions", "android"),
    );
  }
});

test("shared adb registry holds the sixth slot after hand-off despite different data roots", async () => {
  const first = gate(100, firstEnv);
  const second = gate(200, secondEnv);
  const admission = await first.admit(request);
  admission.handOff("emulator-5554", 4242);
  timer.advanceTime(12_000);
  const failure = await second.admit(request).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(BootCapacityExhaustedError);
  if (failure instanceof BootCapacityExhaustedError) {
    expect(failure.code).toBe("capacity_exhausted");
    expect(failure.details.booted).toBe(6);
    expect(failure.details.limit).toBe(6);
  }
  admission.release();
  (await second.admit(request)).release();
});

test("different adb servers admit independently after hand-off", async () => {
  secondEnv.ANDROID_ADB_SERVER_PORT = "5038";
  const first = gate(100, firstEnv);
  const second = gate(200, secondEnv);
  const admission = await first.admit(request);
  admission.handOff("emulator-5554", 4242);
  timer.advanceTime(12_000);
  const peerAdmission = await second.admit(request);
  peerAdmission.release();
  admission.release();
});

test("different adb coordination overrides split admissions on the same adb server", async () => {
  // Pins why this override must be identical for every daemon on one adb server,
  // not a behavior to rely on: the incident configuration admitted both boots.
  firstEnv.AUTOMOBILE_ADB_SERVER_COORDINATION_DIR = join(homeDir, "adb-root-1");
  secondEnv.AUTOMOBILE_ADB_SERVER_COORDINATION_DIR = join(homeDir, "adb-root-2");
  expect(adbServerScope(firstEnv)).toBe(adbServerScope(secondEnv));
  expect(androidBootAdmissionRegistryDirectory(firstEnv, homeDir)).not.toBe(
    androidBootAdmissionRegistryDirectory(secondEnv, homeDir),
  );
  const first = gate(100, firstEnv);
  const second = gate(200, secondEnv);
  const admission = await first.admit(request);
  admission.handOff("emulator-5554", 4242);
  timer.advanceTime(12_000);
  const peerAdmission = await second.admit(request);
  peerAdmission.release();
  admission.release();
});

test.each(["regular file", "relative path"])(
  "unusable adb coordination override (%s) rejects with retryable discovery_incomplete",
  async (kind) => {
    const file = join(homeDir, "not-a-directory");
    if (kind === "regular file") {
      writeFileSync(file, "not a registry root");
    }
    firstEnv.AUTOMOBILE_ADB_SERVER_COORDINATION_DIR =
      kind === "regular file" ? file : "relative-adb-root";
    const failure = await gate(100, firstEnv)
      .admit(request)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(AndroidBootedDeviceDiscoveryIncompleteError);
    if (failure instanceof AndroidBootedDeviceDiscoveryIncompleteError) {
      expect(failure.code).toBe("discovery_incomplete");
      expect(failure.retryable).toBe(true);
      expect(failure.discoveryError?.code).toBe("failed");
    }
  },
);
