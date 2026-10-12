import { beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADMISSION_LOCK_MAX_AGE_MS,
  FileHostBootAdmissionRegistry,
} from "../../../src/features/bootAdmission/FileHostBootAdmissionRegistry";
import { AndroidBootAdmissionGate } from "../../../src/features/bootAdmission/AndroidBootAdmissionGate";
import { FakeAndroidCapacitySource } from "../../fakes/FakeAndroidCapacitySource";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { useScratchRoot } from "../../helpers/scratchRoot";

// PR #11766: "Leftovers heal on their own: ... a lock older than 60 s is taken over."
// An admission.lock left EMPTY (a holder killed, or ENOSPC, between the `wx` create and the PID
// write in writeExclusiveLockFile) or holding an unreadable PID line is never taken over, however
// old it is: every Android cold boot on the host is then refused with discovery_incomplete
// (timeout) until someone deletes the file by hand.

const scratch = useScratchRoot("boot-admission-hunt-");
let directory: string;
let timer: FakeTimer;
beforeEach(() => {
  directory = scratch.next();
  timer = new FakeTimer();
  timer.setCurrentTime(1800000000000);
});

function registry(): FileHostBootAdmissionRegistry {
  return new FileHostBootAdmissionRegistry({
    directory: () => directory,
    pid: 100,
    timer,
    isProcessRunning: (owner) => owner === 100,
    idGenerator: new FakeIdGenerator(),
  });
}

function leaveLock(content: string, ageMs: number): string {
  const path = join(directory, "admission.lock");
  writeFileSync(path, content);
  const mtimeSeconds = (timer.now() - ageMs) / 1000;
  utimesSync(path, mtimeSeconds, mtimeSeconds);
  return path;
}

async function settled(promise: Promise<unknown>): Promise<"entered" | unknown> {
  return promise.then(
    () => "entered",
    (error: unknown) => error,
  );
}

test.each([
  ["empty (holder died between create and PID write)", ""],
  ["an unreadable PID line", "not-a-pid\ntoken"],
])(
  "an admission.lock that is %s is taken over once it is older than the max age",
  async (_, content) => {
    const path = leaveLock(content, 10 * ADMISSION_LOCK_MAX_AGE_MS);
    let entered = false;
    const acquisition = settled(
      registry().withAdmissionLock({ timeoutMs: 100 }, async () => {
        entered = true;
      }),
    );
    timer.advanceTime(100);
    const outcome = await acquisition;

    // Fails today: outcome is HostBootAdmissionRegistryError("timeout") and the file is still there.
    expect(outcome).toBe("entered");
    expect(entered).toBe(true);
    expect(existsSync(path)).toBe(false);
  },
);

test("an hours-old empty admission.lock does not refuse every Android cold boot on the host", async () => {
  leaveLock("", 6 * 60 * 60 * 1000);
  const gate = new AndroidBootAdmissionGate(new FakeAndroidCapacitySource(), timer, {
    env: { AUTOMOBILE_ANDROID_MAX_BOOTED: "2" },
    hostRegistry: registry(),
  });
  const admission = settled(gate.admit({ avdName: "Pixel_9", timeoutMs: 100 }));
  timer.advanceTime(100);
  const outcome = await admission;

  // Fails today: AndroidBootedDeviceDiscoveryIncompleteError (discoveryError.code "timeout").
  expect(outcome).toBe("entered");
});

test.each([
  ["young empty", "", 0],
  ["live owner below the takeover bound", "100\nlive", ADMISSION_LOCK_MAX_AGE_MS - 1_000],
])("a %s admission lock is still held until the waiter times out", async (_, content, age) => {
  const path = leaveLock(content, age);
  const acquisition = settled(registry().withAdmissionLock({ timeoutMs: 100 }, async () => {}));
  timer.advanceTime(100);
  expect(await acquisition).toMatchObject({ code: "timeout" });
  expect(readFileSync(path, "utf8")).toBe(content);
});
