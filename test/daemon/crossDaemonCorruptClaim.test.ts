import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ForwardLeaseForeignDeviceOwnership,
  type DeviceOwnershipFileSource,
} from "../../../src/daemon/foreignDeviceOwnership";
import type {
  ForwardLeaseOwnerProbe,
  ForwardLeaseOwnerReport,
} from "../../../src/features/observe/shared/ctrlProxyForwardLeaseOwnership";
import {
  readExclusiveLockContent,
  releaseExclusiveLock,
  takeOverExclusiveLock,
  tryAcquireExclusiveLock,
} from "../../../src/utils/fileLock";
import { FakeTimer } from "../../fakes/FakeTimer";

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
  function ownershipOver(claimsDir: string) {
    const source: DeviceOwnershipFileSource = {
      leasePath: () => undefined,
      claimPath: (id) => join(claimsDir, `${id}.lock`),
      legacyClaimPath: () => undefined,
      read: (path) => readExclusiveLockContent(path),
      isProcessRunning: (pid) => pid === SELF_PID,
      tryAcquire: (path, owner) =>
        tryAcquireExclusiveLock(path, { ...owner, isProcessRunning: (pid) => pid === SELF_PID }),
      takeOver: (path, observed, owner) => takeOverExclusiveLock(path, observed, owner),
      release: (path, owner) => releaseExclusiveLock(path, owner.pid, owner.ownerToken),
    };
    return new ForwardLeaseForeignDeviceOwnership(
      SELF_PID,
      source,
      new UnreachableProbe(),
      () => "/sockets/self.sock",
      new FakeTimer(),
    );
  }

  test.each([
    ["a torn write that left garbage", "not-a-pid\n"],
    ["a crash between create and write that left an empty file", ""],
  ])("%s is not a permanent claim: allocation can still claim the device", async (_name, body) => {
    const root = mkdtempSync(join(tmpdir(), "cross-daemon-corrupt-claim-"));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${DEVICE}.lock`), body);
    const ownership = ownershipOver(root);

    // Refresh reports no foreign owner: the file names nobody...
    await ownership.refresh([DEVICE]);
    expect(ownership.foreignOwnerPid(DEVICE)).toBeUndefined();

    // ...yet claiming refuses forever (no owner pid to show, nothing ever reclaims the file),
    // so allocation hands the device back with shouldWait on every pass.
    expect(await ownership.claim(DEVICE)).toBe(true);
  });
});
