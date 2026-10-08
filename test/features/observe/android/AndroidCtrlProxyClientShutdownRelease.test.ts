import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import {
  FileCtrlProxyForwardLease,
  ctrlProxyForwardLeaseFileName,
  ctrlProxyOwnedForwardFileName,
} from "../../../../src/features/observe/android/CtrlProxyForwardLease";
import type { BootedDevice, ExecResult } from "../../../../src/models";
import { PortManager } from "../../../../src/utils/PortManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";

const DEVICE: BootedDevice = { deviceId: "emulator-5610", name: "Pixel", platform: "android" };
const PORT = 52010;
const BOUND_MS = 3_000;

function result(stdout: string): ExecResult {
  return { stdout, stderr: "", toString: () => stdout, trim: () => stdout.trim() } as ExecResult;
}

/** adb that lists one forward and either removes it, or hangs on `forward --remove`. */
class ForwardAdb extends FakeAdbExecutor {
  removed = false;
  hangRemove = false;
  constructor(private readonly row: string) {
    super();
  }
  override async executeCommand(command: string): Promise<ExecResult> {
    if (command === "forward --list") {
      return result(this.removed ? "" : this.row);
    }
    if (command.startsWith("forward --remove")) {
      this.executedRemovals.push(command);
      if (this.hangRemove) {
        return new Promise<ExecResult>(() => {});
      }
      this.removed = true;
      return result("");
    }
    return result("");
  }
  readonly executedRemovals: string[] = [];
}

describe("AndroidCtrlProxyClient.releaseForwardLeasesForShutdown", () => {
  let dir: string;
  let timer: FakeTimer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctrlproxy-shutdown-"));
    timer = new FakeTimer();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  });

  afterEach(() => {
    AndroidCtrlProxyClient.clearInstanceRegistryForTesting();
    PortManager.setPortAvailabilityCheckerForTesting(null);
    rmSync(dir, { recursive: true, force: true });
  });

  const lockFile = (): string => join(dir, ctrlProxyForwardLeaseFileName(DEVICE.deviceId));
  const recordFile = (): string => join(dir, ctrlProxyOwnedForwardFileName(DEVICE.deviceId, PORT));

  function heldClient(adb: ForwardAdb, recorded: boolean): AndroidCtrlProxyClient {
    const lease = new FileCtrlProxyForwardLease(DEVICE.deviceId, {
      lockDir: () => dir,
      ownerSocketPath: () => undefined,
      timer,
    });
    expect(lease.tryAcquire()).toBe(true);
    if (recorded) {
      lease.recordOwnedForward(PORT);
    }
    const client = AndroidCtrlProxyClient.createForTesting(
      DEVICE,
      adb,
      (url) => new FakeWebSocket(url, "none", 0, timer),
      timer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      lease,
    );
    const internals = client as unknown as { portForwardingSetup: boolean; localPort: number };
    internals.portForwardingSetup = true;
    internals.localPort = PORT;
    AndroidCtrlProxyClient.registerForTesting(client, DEVICE.deviceId);
    return client;
  }

  test("releases the lease and removes the recorded forward", async () => {
    const adb = new ForwardAdb(`${DEVICE.deviceId} tcp:${PORT} tcp:8765\n`);
    heldClient(adb, true);
    expect(existsSync(lockFile())).toBe(true);

    await AndroidCtrlProxyClient.releaseForwardLeasesForShutdown(timer, BOUND_MS);

    expect(adb.executedRemovals).toEqual([`forward --remove tcp:${PORT}`]);
    expect(existsSync(lockFile())).toBe(false);
    expect(existsSync(recordFile())).toBe(false);
    expect(AndroidCtrlProxyClient.getExistingInstance(DEVICE.deviceId)).toBeNull();
  });

  test("a hung adb removal does not block past the bound and still releases the lease", async () => {
    const adb = new ForwardAdb(`${DEVICE.deviceId} tcp:${PORT} tcp:8765\n`);
    adb.hangRemove = true;
    heldClient(adb, true);

    let settled = false;
    const release = AndroidCtrlProxyClient.releaseForwardLeasesForShutdown(timer, BOUND_MS).then(
      () => {
        settled = true;
      },
    );
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    expect(settled).toBe(false);

    timer.advanceTime(BOUND_MS);
    await release;

    expect(settled).toBe(true);
    expect(existsSync(lockFile())).toBe(false);
    // The record stays so the next daemon can still tell the forward was ours.
    expect(existsSync(recordFile())).toBe(true);
  });

  test("leaves an unrecorded forward alone but still releases the lease", async () => {
    const adb = new ForwardAdb(`${DEVICE.deviceId} tcp:${PORT} tcp:8765\n`);
    heldClient(adb, false);

    await AndroidCtrlProxyClient.releaseForwardLeasesForShutdown(timer, BOUND_MS);

    expect(adb.executedRemovals).toEqual([]);
    expect(existsSync(lockFile())).toBe(false);
  });

  test("is a no-op when this process holds no clients", async () => {
    await AndroidCtrlProxyClient.releaseForwardLeasesForShutdown(timer, BOUND_MS);
  });
});
