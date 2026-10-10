import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCompleteLockFile,
  ForwardLeaseForeignDeviceOwnership,
  lockFileIsUnreadable,
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
} from "../../src/utils/fileLock";
import { FakeTimer } from "../fakes/FakeTimer";

const SELF_PID = 100;
const DEVICE = "emulator-5554";

class UnreachableProbe implements ForwardLeaseOwnerProbe {
  async query(): Promise<ForwardLeaseOwnerReport> {
    return { kind: "unreachable", detail: "ECONNREFUSED" };
  }
}

describe("cross-daemon claim store: torn claims cannot exist and unreadable ones are not free", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "cross-daemon-corrupt-claim-"));
    roots.push(root);
    return root;
  }

  /** The production claim primitives over a temp directory. */
  function ownershipOver(claimsDir: string, selfPid = SELF_PID) {
    const source: DeviceOwnershipFileSource = {
      leasePath: () => undefined,
      claimPath: (id) => join(claimsDir, `${id}.lock`),
      legacyClaimPath: () => undefined,
      read: (path) => readExclusiveLockContent(path),
      isUnreadable: (path) => lockFileIsUnreadable(path),
      isProcessRunning: (pid) => pid === selfPid,
      tryAcquire: (path, owner) => createCompleteLockFile(path, owner),
      takeOver: (path, observed, owner) => takeOverExclusiveLock(path, observed, owner),
      release: (path, owner) => releaseExclusiveLock(path, owner.pid, owner.ownerToken),
    };
    return new ForwardLeaseForeignDeviceOwnership(
      selfPid,
      source,
      new UnreachableProbe(),
      () => undefined,
      new FakeTimer(),
    );
  }

  test.each([
    ["garbage left by an older writer", "not-a-pid\n"],
    ["an empty file left by an older writer", ""],
  ])("%s is not free: refresh and claim agree, with no owner pid", async (_name, body) => {
    const root = tempRoot();
    writeFileSync(join(root, `${DEVICE}.lock`), body);
    const ownership = ownershipOver(root);

    await ownership.refresh([DEVICE]);

    expect(ownership.foreignOwnerPid(DEVICE)).toBeUndefined();
    expect(ownership.foreignClaimUnreadable(DEVICE)).toBe(true);
    expect(await ownership.claim(DEVICE)).toBe(false);
    expect(readdirSync(root)).toEqual([`${DEVICE}.lock`]);
  });

  test("a missing claim and a published claim are not unreadable", async () => {
    const root = tempRoot();
    const ownership = ownershipOver(root);
    await ownership.refresh([DEVICE]);
    expect(ownership.foreignClaimUnreadable(DEVICE)).toBe(false);
    expect(await ownership.claim(DEVICE)).toBe(true);
    await ownership.refresh([DEVICE]);
    expect(ownership.foreignClaimUnreadable(DEVICE)).toBe(false);
  });

  test("a writer stalled before publishing leaves no claim; a later claimant wins alone", () => {
    const root = tempRoot();
    const path = join(root, `${DEVICE}.lock`);
    // Writer W was suspended after preparing its private temp file but before linking it.
    writeFileSync(`${path}.100.1.tmp`, "");
    expect(existsSync(path)).toBe(false);
    expect(lockFileIsUnreadable(path)).toBe(false);

    // Reclaimer R finds the path absent and publishes a complete claim.
    expect(createCompleteLockFile(path, { pid: 200, ownerToken: "r" })).toBe(true);
    // W resumes and tries to publish: the path exists, so W did not acquire.
    expect(createCompleteLockFile(path, { pid: 100, ownerToken: "w" })).toBe(false);
    expect(readExclusiveLockContent(path)?.pid).toBe(200);
  });

  test("three claimants racing for one path: exactly one acquires and the lock stays valid", () => {
    const root = tempRoot();
    const path = join(root, `${DEVICE}.lock`);
    const results = [100, 200, 300].map((pid) =>
      createCompleteLockFile(path, { pid, ownerToken: `t${pid}` }),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = [100, 200, 300][results.indexOf(true)];
    expect(readExclusiveLockContent(path)).toMatchObject({ pid: winner, token: `t${winner}` });
    // No temp files remain: every loser cleaned up and none ever touched the published claim.
    expect(readdirSync(root)).toEqual([`${DEVICE}.lock`]);
  });
});
