import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonMcpProxy, DaemonVersionMismatchError } from "../../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../../src/daemon/client";
import { DaemonManager, type DaemonManagerLike } from "../../../src/daemon/manager";
import { DAEMON_VERSION, DAEMON_VERSION_RESTART_COOLDOWN_MS } from "../../../src/daemon/constants";
import type { DaemonOptions, DaemonStatus, PidFileData } from "../../../src/daemon/types";
import { FakeDaemonClient } from "../../fakes/FakeDaemonClient";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * Integration test: real DaemonManager.status() reading a real PID file written
 * to a temp path, exercising the proxy's version-mismatch decision end-to-end.
 *
 * The "is process running" check uses kill(pid, 0); we use process.pid so the
 * PID is guaranteed to be alive for the duration of the test. The test stubs
 * the spawn/restart side via a wrapper so no real daemon child is forked.
 */
describe("DaemonMcpProxy + real DaemonManager (version-mismatch integration)", () => {
  let tempDir: string;
  let pidFilePath: string;
  let realManager: DaemonManager;
  let isAvailableSpy: ReturnType<typeof spyOn>;
  let fakeTimer: FakeTimer;

  function writePidFile(fields: { version?: string; startedAt?: number }): void {
    const data: PidFileData = {
      pid: process.pid,
      socketPath: join(tempDir, "test.sock"),
      port: 0,
      startedAt: fields.startedAt ?? 1,
      version: fields.version ?? "",
    };
    writeFileSync(pidFilePath, JSON.stringify(data));
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "automobile-version-test-"));
    pidFilePath = join(tempDir, "test.pid");
    realManager = new DaemonManager(undefined, undefined, undefined, undefined, pidFilePath);
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    fakeTimer = new FakeTimer();
    fakeTimer.advanceTime(100_000);
  });

  afterEach(() => {
    isAvailableSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeTracked(): DaemonManagerLike & {
    restartCalled: boolean;
    restartOptions?: DaemonOptions;
    startCalled: boolean;
    waitForReadyResult: boolean;
    } {
    let restartCalled = false;
    let restartOptions: DaemonOptions | undefined;
    let startCalled = false;
    const tracker: any = {
      get restartCalled() { return restartCalled; },
      get restartOptions() { return restartOptions; },
      get startCalled() { return startCalled; },
      waitForReadyResult: true,
      async status(): Promise<DaemonStatus> {
        return realManager.status();
      },
      async start(options?: DaemonOptions) {
        startCalled = true;
        restartOptions = options;
      },
      async restart(options?: DaemonOptions) {
        restartCalled = true;
        restartOptions = options;
        writePidFile({ version: DAEMON_VERSION, startedAt: fakeTimer.now() });
      },
      async waitForReady() {
        return tracker.waitForReadyResult;
      },
    };
    return tracker;
  }

  test("real PID file with older version triggers restart", async () => {
    writePidFile({ version: "0.0.1", startedAt: 1 });
    const tracked = makeTracked();
    const proxy = new DaemonMcpProxy({
      clientFactory: () => new FakeDaemonClient(),
      daemonManager: tracked,
      autoStartDaemon: true,
      timer: fakeTimer,
    });
    try {
      await proxy.listTools();
      expect(tracked.restartCalled).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  test("real PID file with newer version fails without attaching", async () => {
    writePidFile({ version: "9999.0.0", startedAt: 1 });
    const tracked = makeTracked();
    const fakeClient = new FakeDaemonClient();
    const proxy = new DaemonMcpProxy({
      clientFactory: () => fakeClient,
      daemonManager: tracked,
      autoStartDaemon: true,
      timer: fakeTimer,
    });
    try {
      await expect(proxy.listTools()).rejects.toThrow(DaemonVersionMismatchError);
      expect(tracked.restartCalled).toBe(false);
      expect(fakeClient.isConnected()).toBe(false);
    } finally {
      await proxy.close();
    }
  });

  test("real PID file with matching version does not trigger restart", async () => {
    writePidFile({ version: DAEMON_VERSION, startedAt: 1 });
    const tracked = makeTracked();
    const proxy = new DaemonMcpProxy({
      clientFactory: () => new FakeDaemonClient(),
      daemonManager: tracked,
      autoStartDaemon: true,
      timer: fakeTimer,
    });
    try {
      await proxy.listTools();
      expect(tracked.restartCalled).toBe(false);
    } finally {
      await proxy.close();
    }
  });

  test("real PID file with older version inside cooldown window fails without attaching", async () => {
    writePidFile({
      version: "0.0.1",
      startedAt: fakeTimer.now() - Math.floor(DAEMON_VERSION_RESTART_COOLDOWN_MS / 2),
    });
    const tracked = makeTracked();
    const fakeClient = new FakeDaemonClient();
    const proxy = new DaemonMcpProxy({
      clientFactory: () => fakeClient,
      daemonManager: tracked,
      autoStartDaemon: true,
      timer: fakeTimer,
    });
    try {
      await expect(proxy.listTools()).rejects.toThrow(DaemonVersionMismatchError);
      expect(tracked.restartCalled).toBe(false);
      expect(fakeClient.isConnected()).toBe(false);
    } finally {
      await proxy.close();
    }
  });

  test("real PID file missing version field triggers restart", async () => {
    const data = {
      pid: process.pid,
      socketPath: join(tempDir, "test.sock"),
      port: 0,
      startedAt: 1,
    };
    writeFileSync(pidFilePath, JSON.stringify(data));
    const tracked = makeTracked();
    const proxy = new DaemonMcpProxy({
      clientFactory: () => new FakeDaemonClient(),
      daemonManager: tracked,
      autoStartDaemon: true,
      timer: fakeTimer,
    });
    try {
      await proxy.listTools();
      expect(tracked.restartCalled).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  test("PID file pointing at a dead PID is treated as not running, no restart attempted", async () => {
    // PID 999999 is virtually never alive; status() should return running:false and unlink
    const data: PidFileData = {
      pid: 999999,
      socketPath: join(tempDir, "test.sock"),
      port: 0,
      startedAt: 1,
      version: "0.0.1",
    };
    writeFileSync(pidFilePath, JSON.stringify(data));
    const tracked = makeTracked();
    const proxy = new DaemonMcpProxy({
      clientFactory: () => new FakeDaemonClient(),
      daemonManager: tracked,
      autoStartDaemon: true,
      timer: fakeTimer,
    });
    try {
      await proxy.listTools();
      expect(tracked.restartCalled).toBe(false);
    } finally {
      await proxy.close();
    }
  });
});
