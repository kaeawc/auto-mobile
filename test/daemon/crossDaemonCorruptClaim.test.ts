import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ForwardLeaseForeignDeviceOwnership,
  UNREADABLE_CLAIM_OWNER_PID,
  type DeviceOwnershipFileSource,
} from "../../src/daemon/foreignDeviceOwnership";
import type {
  ForwardLeaseOwnerProbe,
  ForwardLeaseOwnerReport,
} from "../../src/features/observe/shared/ctrlProxyForwardLeaseOwnership";
import {
  readExclusiveLockContent,
  releaseExclusiveLock,
  takeOverExclusiveLock,
  tryAcquireExclusiveLock,
  unreadableLockAgeMs,
  UNREADABLE_LOCK_GRACE_MS,
} from "../../src/utils/fileLock";
import { FakeTimer } from "../fakes/FakeTimer";

const SELF_PID = 100;
const DEVICE = "emulator-5554";

class UnreachableProbe implements ForwardLeaseOwnerProbe {
  async query(): Promise<ForwardLeaseOwnerReport> {
    return { kind: "unreachable", detail: "ECONNREFUSED" };
  }
}

describe("cross-daemon claim store with an unreadable claim file", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** The real fileLock primitives over a temp directory, as the production source uses them. */
  function ownershipOver(claimsDir: string, timer: FakeTimer) {
    // The file was written at fake time 0; the lock and the source read the same fake clock.
    const clock = { nowMs: () => timer.now(), mtimeMs: () => 0 };
    const source: DeviceOwnershipFileSource = {
      leasePath: () => undefined,
      claimPath: (id) => join(claimsDir, `${id}.lock`),
      legacyClaimPath: () => undefined,
      read: (path) => readExclusiveLockContent(path),
      unreadableAgeMs: (path) => unreadableLockAgeMs(path, clock),
      isProcessRunning: (pid) => pid === SELF_PID,
      tryAcquire: (path, owner) =>
        tryAcquireExclusiveLock(path, {
          ...owner,
          ...clock,
          isProcessRunning: (pid) => pid === SELF_PID,
        }),
      takeOver: (path, observed, owner) => takeOverExclusiveLock(path, observed, owner),
      release: (path, owner) => releaseExclusiveLock(path, owner.pid, owner.ownerToken),
    };
    return new ForwardLeaseForeignDeviceOwnership(
      SELF_PID,
      source,
      new UnreachableProbe(),
      () => "/sockets/self.sock",
      timer,
    );
  }

  test.each([
    ["a torn write that left garbage", "not-a-pid\n"],
    ["a crash between create and write that left an empty file", ""],
  ])("%s is refused while young, then reclaimed once torn", async (_name, body) => {
    const root = mkdtempSync(join(tmpdir(), "cross-daemon-corrupt-claim-"));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${DEVICE}.lock`), body);
    const timer = new FakeTimer();
    const ownership = ownershipOver(root, timer);

    // Within the grace the writer may still be mid-write: the device is not free, and claim
    // agrees with refresh (never "free but unclaimable").
    timer.advanceTime(UNREADABLE_LOCK_GRACE_MS - 1);
    await ownership.refresh([DEVICE]);
    expect(ownership.foreignOwnerPid(DEVICE)).toBe(UNREADABLE_CLAIM_OWNER_PID);
    expect(await ownership.claim(DEVICE)).toBe(false);

    // Past the grace the leftover is reclaimed: the device is free and claimable.
    timer.advanceTime(1);
    await ownership.refresh([DEVICE]);
    expect(ownership.foreignOwnerPid(DEVICE)).toBeUndefined();
    expect(await ownership.claim(DEVICE)).toBe(true);
    expect(readExclusiveLockContent(join(root, `${DEVICE}.lock`))?.pid).toBe(SELF_PID);
  });
});
