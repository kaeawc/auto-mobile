import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { IncumbentOwnerGuard } from "../../src/daemon/incumbentOwnerGuard";
import type { PidFileData } from "../../src/daemon/types";
import { resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { closeDatabase } from "../../src/db/database";
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { darwinProcessGenerationToken } from "../../src/daemon/processGeneration";
import { LSTART_UTC } from "./psLstartFixtures";

const DARWIN_TOKEN = darwinProcessGenerationToken(LSTART_UTC)!;
const LINUX_TOKEN = "linux:boot-id:424242";

/** A guard that never reads a real PID file or process table. */
function inertGuard(): IncumbentOwnerGuard {
  return new IncumbentOwnerGuard({
    readPidFile: () => null,
    persistPidFile: () => {},
    isProcessRunning: () => false,
    readProcessGenerationToken: () => undefined,
    selfPid: process.pid,
  });
}

function daemonWithToken(token: string | undefined): Daemon {
  return new Daemon(
    {},
    new FakeInstalledAppsRepository(),
    new FakeTimer(),
    new FakeDeviceSessionRepository(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => 1_000,
    () => token,
    undefined,
    inertGuard(),
  );
}

/** Capture what the daemon would persist instead of writing the real PID file. */
function captureRecords(daemon: Daemon): PidFileData[] {
  const written: PidFileData[] = [];
  daemon["persistPidFileData"] = async (data) => {
    written.push(data);
  };
  return written;
}

/**
 * The record a daemon publishes is the one place the field choice is made
 * (issue #10116 review F1): a Darwin zone-free token must NOT land in the field
 * older builds compare strictly against their own, time-zone-dependent token.
 */
describe("Daemon PID record process generation fields (issue #10116 review F1)", () => {
  let originalDbPath: string | undefined;

  beforeEach(async () => {
    await closeDatabase();
    resetDbWriteBarrier();
    // The record names the DB path. Resolving it must not default to the real DB;
    // this temp path is only ever named, never opened.
    originalDbPath = process.env.AUTOMOBILE_DB_PATH;
    process.env.AUTOMOBILE_DB_PATH = join(
      process.cwd(),
      "scratch/data/daemon-process-generation-record.db",
    );
  });

  afterEach(async () => {
    // PID-record construction caches getDatabasePath() even without opening a DB.
    // Clear that lifecycle before restoring the env so later suites cannot use it.
    await closeDatabase();
    if (originalDbPath === undefined) {
      delete process.env.AUTOMOBILE_DB_PATH;
    } else {
      process.env.AUTOMOBILE_DB_PATH = originalDbPath;
    }
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    resetDbWriteBarrier();
  });

  test("a Darwin daemon's committed record carries the token only in the zone-free field", async () => {
    const daemon = daemonWithToken(DARWIN_TOKEN);
    const written = captureRecords(daemon);

    await daemon["writePidFile"]();

    expect(written).toHaveLength(1);
    expect(written[0]?.processGenerationTokenUtc).toBe(DARWIN_TOKEN);
    expect("processGenerationToken" in written[0]!).toBe(false);
  });

  test("a Darwin daemon's early owner record carries the token only in the zone-free field", async () => {
    const daemon = daemonWithToken(DARWIN_TOKEN);
    const written = captureRecords(daemon);

    await daemon["writeEarlyOwnerRecord"]();

    expect(written).toHaveLength(1);
    expect(written[0]?.processGenerationTokenUtc).toBe(DARWIN_TOKEN);
    expect("processGenerationToken" in written[0]!).toBe(false);
  });

  test("a Linux daemon keeps the legacy field, whose token scheme did not change", async () => {
    const daemon = daemonWithToken(LINUX_TOKEN);
    const written = captureRecords(daemon);

    await daemon["writePidFile"]();

    expect(written[0]?.processGenerationToken).toBe(LINUX_TOKEN);
    expect("processGenerationTokenUtc" in written[0]!).toBe(false);
  });

  test("a daemon with no readable token publishes neither field", async () => {
    const daemon = daemonWithToken(undefined);
    const written = captureRecords(daemon);

    await daemon["writePidFile"]();

    expect("processGenerationToken" in written[0]!).toBe(false);
    expect("processGenerationTokenUtc" in written[0]!).toBe(false);
  });
});
