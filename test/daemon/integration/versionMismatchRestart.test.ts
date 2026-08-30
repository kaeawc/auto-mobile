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
// Pinned plain client version: DAEMON_VERSION is git-SHA-stamped (non-numeric)
// in a source checkout, but this suite exercises the numeric release-version
// comparison path, so the proxy's client version is injected explicitly.
const CLIENT_VERSION = "0.0.39";

describe("DaemonMcpProxy + real DaemonManager (version-mismatch integration)", () => {
  let tempDir: string;
  let pidFilePath: string;
  let realManager: DaemonManager;
  let isAvailableSpy: ReturnType<typeof spyOn>;
  let fakeTimer: FakeTimer;

  function writePidFile(fields: {
    version?: string;
    startedAt?: number;
    assetVersion?: string;
    entryScript?: string;
    buildId?: string;
  }): void {
    const data: PidFileData = {
      pid: process.pid,
      socketPath: join(tempDir, "test.sock"),
      port: 0,
      startedAt: fields.startedAt ?? 1,
      version: fields.version ?? "",
      assetVersion: fields.assetVersion,
      entryScript: fields.entryScript,
      buildId: fields.buildId,
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
      get restartCalled() {
        return restartCalled;
      },
      get restartOptions() {
        return restartOptions;
      },
      get startCalled() {
        return startCalled;
      },
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
        writePidFile({ version: CLIENT_VERSION, startedAt: fakeTimer.now() });
      },
      async waitForReady() {
        return tracker.waitForReadyResult;
      },
      isStartupLockHeldByLiveProcess() {
        return false;
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
      clientVersion: CLIENT_VERSION,
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
      clientVersion: CLIENT_VERSION,
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
    writePidFile({ version: CLIENT_VERSION, startedAt: 1 });
    const tracked = makeTracked();
    const proxy = new DaemonMcpProxy({
      clientFactory: () => new FakeDaemonClient(),
      daemonManager: tracked,
      autoStartDaemon: true,
      timer: fakeTimer,
      clientVersion: CLIENT_VERSION,
    });
    try {
      await proxy.listTools();
      expect(tracked.restartCalled).toBe(false);
    } finally {
      await proxy.close();
    }
  });

  test("same-release build mismatch identifies both scripts and the client restart command", async () => {
    writePidFile({
      version: "0.0.39+gdaemon",
      startedAt: fakeTimer.now() - Math.floor(DAEMON_VERSION_RESTART_COOLDOWN_MS / 2),
      entryScript: "/stale/checkout/dist/index.js",
      buildId: "daemon-build",
    });
    const tracked = makeTracked();
    const fakeClient = new FakeDaemonClient();
    const proxy = new DaemonMcpProxy({
      clientFactory: () => fakeClient,
      daemonManager: tracked,
      autoStartDaemon: true,
      timer: fakeTimer,
      clientVersion: "0.0.39+gclient",
      buildIdentity: { entryScript: "/current/checkout/dist/index.js", buildId: "client-build" },
    });
    try {
      let errorMessage = "";
      try {
        await proxy.listTools();
      } catch (error) {
        errorMessage = String(error);
      }
      expect(errorMessage).toContain("daemon build daemon-build (/stale/checkout/dist/index.js)");
      expect(errorMessage).toContain("client build client-build (/current/checkout/dist/index.js)");
      expect(errorMessage).toContain(
        `'${process.execPath}' '/current/checkout/dist/index.js' --daemon restart`,
      );
      expect(tracked.restartCalled).toBe(false);
    } finally {
      await proxy.close();
    }
  });

  test("real PID file with mismatched explicit asset pin fails without attaching", async () => {
    writePidFile({ version: CLIENT_VERSION, assetVersion: "0.0.18", startedAt: 1 });
    const previousVersion = process.env.AUTOMOBILE_VERSION;
    process.env.AUTOMOBILE_VERSION = "0.0.39";
    const tracked = makeTracked();
    const fakeClient = new FakeDaemonClient();
    const proxy = new DaemonMcpProxy({
      clientFactory: () => fakeClient,
      daemonManager: tracked,
      autoStartDaemon: true,
      timer: fakeTimer,
      clientVersion: CLIENT_VERSION,
    });
    try {
      await expect(proxy.listTools()).rejects.toThrow(/AUTOMOBILE_VERSION.*0\.0\.39.*0\.0\.18/);
      expect(tracked.restartCalled).toBe(false);
      expect(fakeClient.isConnected()).toBe(false);
    } finally {
      if (previousVersion === undefined) {
        delete process.env.AUTOMOBILE_VERSION;
      } else {
        process.env.AUTOMOBILE_VERSION = previousVersion;
      }
      await proxy.close();
    }
  });

  test("real PID file with explicit asset pin and missing daemon stamp fails without attaching", async () => {
    writePidFile({ version: CLIENT_VERSION, startedAt: 1 });
    const previousVersion = process.env.AUTOMOBILE_VERSION;
    process.env.AUTOMOBILE_VERSION = "0.0.39";
    const tracked = makeTracked();
    const fakeClient = new FakeDaemonClient();
    const proxy = new DaemonMcpProxy({
      clientFactory: () => fakeClient,
      daemonManager: tracked,
      autoStartDaemon: true,
      timer: fakeTimer,
      clientVersion: CLIENT_VERSION,
    });
    try {
      await expect(proxy.listTools()).rejects.toThrow(/AUTOMOBILE_VERSION.*0\.0\.39.*unknown/);
      expect(tracked.restartCalled).toBe(false);
      expect(fakeClient.isConnected()).toBe(false);
    } finally {
      if (previousVersion === undefined) {
        delete process.env.AUTOMOBILE_VERSION;
      } else {
        process.env.AUTOMOBILE_VERSION = previousVersion;
      }
      await proxy.close();
    }
  });

  test("real PID file with matching explicit asset pin does not block reuse", async () => {
    writePidFile({ version: CLIENT_VERSION, assetVersion: "0.0.18", startedAt: 1 });
    const previousVersion = process.env.AUTOMOBILE_VERSION;
    process.env.AUTOMOBILE_VERSION = "0.0.18";
    const tracked = makeTracked();
    const proxy = new DaemonMcpProxy({
      clientFactory: () => new FakeDaemonClient(),
      daemonManager: tracked,
      autoStartDaemon: true,
      timer: fakeTimer,
      clientVersion: CLIENT_VERSION,
    });
    try {
      await proxy.listTools();
      expect(tracked.restartCalled).toBe(false);
    } finally {
      if (previousVersion === undefined) {
        delete process.env.AUTOMOBILE_VERSION;
      } else {
        process.env.AUTOMOBILE_VERSION = previousVersion;
      }
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
      clientVersion: CLIENT_VERSION,
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
      clientVersion: CLIENT_VERSION,
    });
    try {
      await proxy.listTools();
      expect(tracked.restartCalled).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  test("real PID file exposes socket path map through status", async () => {
    const sockets = {
      control: join(tempDir, "test.sock"),
      appearance: join(tempDir, "appearance.sock"),
      "device-snapshot": join(tempDir, "device-snapshot.sock"),
      "failures-push": join(tempDir, "failures-push.sock"),
      "failures-stream": join(tempDir, "failures-stream.sock"),
      "observation-stream": join(tempDir, "observation-stream.sock"),
      "performance-push": join(tempDir, "performance-push.sock"),
      "performance-stream": join(tempDir, "performance-stream.sock"),
      "telemetry-push": join(tempDir, "telemetry-push.sock"),
      "test-recording": join(tempDir, "test-recording.sock"),
      "video-recording": join(tempDir, "video-recording.sock"),
    };
    const data: PidFileData = {
      pid: process.pid,
      socketPath: sockets.control,
      sockets,
      port: 0,
      startedAt: 1,
      version: DAEMON_VERSION,
    };
    writeFileSync(pidFilePath, JSON.stringify(data));

    const status = await realManager.status();

    expect(status.running).toBe(true);
    expect(status.sockets).toEqual(sockets);
  });

  test("real PID file exposes stamped asset version through status", async () => {
    writePidFile({ version: CLIENT_VERSION, assetVersion: "0.0.18", startedAt: 1 });

    const status = await realManager.status();

    expect(status.running).toBe(true);
    expect(status.assetVersion).toBe("0.0.18");
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
      clientVersion: CLIENT_VERSION,
    });
    try {
      await proxy.listTools();
      expect(tracked.restartCalled).toBe(false);
    } finally {
      await proxy.close();
    }
  });
});
