import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_ACCEPTANCE_RESTART_ADMISSION_TTL_MS,
  DAEMON_MAINTENANCE_ADMISSION_TTL_MS,
  UnixSocketServer,
} from "../../src/daemon/socketServer";
import {
  sendPersistentSocketRequest,
  sendRequestOnPersistentSocket,
  sendSocketRequest,
} from "./helpers/socketRequest";
import { FakeTimer } from "../fakes/FakeTimer";
import type { DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyManager } from "../../src/utils/CtrlProxyManager";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import type { BootedDevice } from "../../src/models";
import { RELEASE_CHECKSUM_REGISTRY, IOS_CTRL_PROXY_APP_HASH } from "../../src/constants/release";
import { executionTracker } from "../../src/server/executionTracker";
import {
  DAEMON_COMMIT_ACCEPTANCE_RESTART_METHOD,
  DAEMON_COMPLETE_MAINTENANCE_METHOD,
  DAEMON_PREPARE_MAINTENANCE_METHOD,
  DAEMON_PREPARE_RESTART_METHOD,
  DAEMON_RESTART_ACCEPTANCE_SESSION_METHOD,
  DAEMON_RESTART_ADMITTED_METHOD,
} from "../../src/daemon/daemonRestartAdmission";
import { createDaemonLiveAcceptanceScopedCapability } from "../../src/daemon/liveAcceptanceCapability";
import type { DaemonOptions } from "../../src/daemon/types";

const SHA256_HEX = /^[0-9a-f]{64}$/;

function createFakeDaemonState() {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      getSession: () => null,
      getAllSessions: () => [],
      releaseSession: async () => null,
    }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
    }),
  };
}

function createFakeDaemonStateWithSessions(
  sessions: Array<{
    sessionId: string;
    platform: "android" | "ios";
    stableDeviceId?: string;
  }>,
) {
  return {
    ...createFakeDaemonState(),
    getSessionManager: () => ({
      getSession: (sessionId: string) =>
        sessions.find((session) => session.sessionId === sessionId),
      getAllSessions: () => sessions,
      releaseSession: async () => null,
    }),
  };
}

function sendRequest(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<DaemonResponse> {
  return sendSocketRequest(socketPath, method, params);
}

/** Simulates an already-queued timer callback surviving clearTimeout(). */
class LateCallbackFakeTimer extends FakeTimer {
  override clearTimeout(handle: NodeJS.Timeout): void {
    void handle;
  }
}

describe("UnixSocketServer ide/status and ide/updateService handlers", () => {
  const startupOptions: DaemonOptions = {
    enabledTools: ["listDevices", "provisionDevice", "deleteDevice"],
  };
  let socketPath: string;
  let server: UnixSocketServer;
  let fakeTimer: FakeTimer;
  let restartRequests: number;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `t-ids-${randomUUID().slice(0, 8)}.sock`);
    fakeTimer = new FakeTimer();
    restartRequests = 0;
    executionTracker.clearDaemonMaintenancePreparation();
    executionTracker.clearDaemonRestartPreparation();

    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
      null,
      {
        processGenerationToken: "socket-generation-1",
        startupOptions,
        onRestartAccepted: () => {
          restartRequests++;
        },
      },
    );
    await server.start();
  });

  afterEach(async () => {
    try {
      await server.close();
      if (existsSync(socketPath)) {
        await unlink(socketPath);
      }
    } finally {
      executionTracker.clearDaemonMaintenancePreparation();
      executionTracker.clearDaemonRestartPreparation();
    }
  });

  test("ide/status returns a usable, self-consistent update artifact", async () => {
    const response = await sendRequest(socketPath, "ide/status");

    expect(response.success).toBe(true);
    const result = response.result as {
      version: string;
      releaseVersion: string;
      android: { ctrlProxy: { expectedSha256: string; url: string } };
      ios: { xcTestService: { expectedSha256: string; expectedAppHash: string; url: string } };
    };
    const entry = RELEASE_CHECKSUM_REGISTRY[0];

    expect(result.version.length).toBeGreaterThan(0);
    // No env override in this test, so the daemon resolves to the newest pinned
    // release — not the floating "latest" tag (#2746).
    expect(result.releaseVersion).toBe(entry.version);

    // Android artifact must be actually fetchable + verifiable: the checksum is a
    // real 64-hex digest equal to the registry's, and the URL points at this
    // version's apk. An empty-string url/sha (the prior weakness) fails both.
    expect(result.android.ctrlProxy.expectedSha256).toMatch(SHA256_HEX);
    expect(result.android.ctrlProxy.expectedSha256).toBe(entry.apkSha256);
    expect(result.android.ctrlProxy.url).toContain(`/${entry.version}/`);
    expect(result.android.ctrlProxy.url.endsWith("control-proxy-debug.apk")).toBe(true);

    // iOS xctest service, same contract. expectedAppHash is deliberately the empty
    // "skip verification" sentinel (IOS_CTRL_PROXY_APP_HASH), so pin it to that
    // constant rather than a 64-hex shape.
    expect(result.ios.xcTestService.expectedSha256).toMatch(SHA256_HEX);
    expect(result.ios.xcTestService.expectedSha256).toBe(entry.ipaSha256);
    expect(result.ios.xcTestService.url).toContain(`/${entry.version}/`);
    expect(result.ios.xcTestService.url.endsWith("control-proxy.ipa")).toBe(true);
    expect(result.ios.xcTestService.expectedAppHash).toBe(IOS_CTRL_PROXY_APP_HASH);
  });

  test("ide/status reports the socket owner's immutable startup options", async () => {
    const response = await sendRequest(socketPath, "ide/status");

    expect(response.success).toBe(true);
    expect(response.result).toMatchObject({ options: startupOptions });
  });

  test("ide/status exposes only the acceptance capability fingerprint", async () => {
    const capability = "acceptance-capability-for-status-test";
    const fingerprintSocketPath = join(tmpdir(), `t-fingerprint-${randomUUID().slice(0, 8)}.sock`);
    const fingerprintServer = new UnixSocketServer(
      fingerprintSocketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      fakeTimer,
      null,
      { acceptanceDiscoveryCapability: capability },
    );
    try {
      await fingerprintServer.start();
      const fingerprintStatus = await sendRequest(fingerprintSocketPath, "ide/status");
      expect(fingerprintStatus.result).toMatchObject({
        acceptanceCapabilityFingerprint: createHash("sha256")
          .update(capability)
          .digest("hex")
          .slice(0, 8),
      });
      expect(fingerprintStatus.result).not.toHaveProperty("acceptanceDiscoveryCapability");
      const unboundStatus = await sendRequest(socketPath, "ide/status");
      expect(unboundStatus.result).toMatchObject({ acceptanceCapabilityFingerprint: null });
    } finally {
      await fingerprintServer.close();
      if (existsSync(fingerprintSocketPath)) {
        await unlink(fingerprintSocketPath);
      }
    }
  });

  test("ide/status reports whether provisionDevice is active", async () => {
    const execution = executionTracker.startExecution("provisionDevice", "provision-transport");
    let activeStatus: Record<string, unknown>;
    try {
      const active = await sendRequest(socketPath, "ide/status");
      expect(active.result).toMatchObject({ activeProvisioning: true });
      activeStatus = active.result!;
      const rejected = await sendRequest(socketPath, DAEMON_PREPARE_RESTART_METHOD, activeStatus);
      expect(rejected.result).toEqual({
        accepted: false,
        reason: "active_operations",
      });
    } finally {
      executionTracker.endExecution(execution.id);
    }

    const idle = await sendRequest(socketPath, "ide/status");
    expect(idle.result).toMatchObject({ activeProvisioning: false });
    try {
      const accepted = await sendRequest(socketPath, DAEMON_PREPARE_RESTART_METHOD, idle.result);
      expect(accepted.result).toEqual({ accepted: true });
      expect(restartRequests).toBe(1);
      const pending = await sendRequest(socketPath, DAEMON_PREPARE_RESTART_METHOD, idle.result);
      expect(pending.result).toEqual({
        accepted: false,
        reason: "restart_pending",
      });
      expect(restartRequests).toBe(1);
    } finally {
      executionTracker.clearDaemonRestartPreparation();
    }
  });

  test("ide/prepareRestart defers while a non-provisioning device operation is active", async () => {
    const execution = executionTracker.startExecution("tapOn", "tap-transport");
    try {
      const status = await sendRequest(socketPath, "ide/status");
      const rejected = await sendRequest(socketPath, DAEMON_PREPARE_RESTART_METHOD, status.result!);
      expect(rejected.result).toEqual({
        accepted: false,
        reason: "active_operations",
      });
    } finally {
      executionTracker.endExecution(execution.id);
    }
  });

  test("restart admission accepts legacy omitted tokens without weakening generation fences", async () => {
    const status = (await sendRequest(socketPath, "ide/status")).result!;
    const legacyStatus = { ...status };
    delete legacyStatus.processGenerationToken;

    try {
      expect((await sendRequest(socketPath, DAEMON_PREPARE_RESTART_METHOD, status)).result).toEqual(
        { accepted: true },
      );
      expect(restartRequests).toBe(1);
      executionTracker.clearDaemonRestartPreparation();

      expect(
        (await sendRequest(socketPath, DAEMON_PREPARE_RESTART_METHOD, legacyStatus)).result,
      ).toEqual({ accepted: true });
      expect(restartRequests).toBe(2);
      executionTracker.clearDaemonRestartPreparation();

      expect(
        (
          await sendRequest(socketPath, DAEMON_PREPARE_RESTART_METHOD, {
            ...legacyStatus,
            startedAt: Number(legacyStatus.startedAt) - 1,
          })
        ).result,
      ).toEqual({ accepted: false, reason: "generation_changed" });
      expect(
        (
          await sendRequest(socketPath, DAEMON_PREPARE_RESTART_METHOD, {
            ...legacyStatus,
            processGenerationToken: "malicious-generation",
          })
        ).result,
      ).toEqual({ accepted: false, reason: "generation_changed" });
      expect(restartRequests).toBe(2);
    } finally {
      executionTracker.clearDaemonRestartPreparation();
    }
  });

  test("maintenance admission is generation-bound, token-gated, and single-use", async () => {
    const state = createFakeDaemonState();
    state.getSessionManager = () => ({
      getSession: () => null,
      getAllSessions: () => [{ sessionId: "active" }],
      releaseSession: async () => null,
    });
    const activeSocketPath = join(tmpdir(), `t-maintenance-${randomUUID().slice(0, 8)}.sock`);
    const activeServer = new UnixSocketServer(
      activeSocketPath,
      "http://localhost:0/mcp",
      state,
      new FakeTimer(),
      null,
    );
    try {
      await activeServer.start();
      const activeStatus = (await sendRequest(activeSocketPath, "ide/status")).result!;
      const rejected = await sendRequest(
        activeSocketPath,
        DAEMON_PREPARE_MAINTENANCE_METHOD,
        activeStatus,
      );
      expect(rejected.result).toEqual({ accepted: false, reason: "active_sessions" });
    } finally {
      await activeServer.close();
      if (existsSync(activeSocketPath)) {
        await unlink(activeSocketPath);
      }
    }

    const status = (await sendRequest(socketPath, "ide/status")).result!;
    expect(status).toMatchObject({ processGenerationToken: "socket-generation-1" });
    const accepted = await sendRequest(socketPath, DAEMON_PREPARE_MAINTENANCE_METHOD, status);
    const maintenanceToken = (accepted.result as { maintenanceToken: string }).maintenanceToken;
    expect(accepted.result).toMatchObject({
      accepted: true,
      maintenanceToken: expect.any(String),
    });
    expect(() => executionTracker.startExecution("tapOn", "fenced")).toThrow(
      "Daemon restart is pending",
    );
    expect((await sendRequest(socketPath, DAEMON_PREPARE_RESTART_METHOD, status)).result).toEqual({
      accepted: false,
      reason: "restart_pending",
    });
    expect(restartRequests).toBe(0);
    expect(
      (await sendRequest(socketPath, DAEMON_COMPLETE_MAINTENANCE_METHOD, status)).result,
    ).toEqual({ completed: false });
    expect(
      (
        await sendRequest(socketPath, DAEMON_COMPLETE_MAINTENANCE_METHOD, {
          ...status,
          maintenanceToken: "stale-token",
        })
      ).result,
    ).toEqual({ completed: false });
    const completion = await sendRequest(socketPath, DAEMON_COMPLETE_MAINTENANCE_METHOD, {
      ...status,
      maintenanceToken,
    });
    expect(completion.result).toEqual({ completed: true });
    const execution = executionTracker.startExecution("tapOn", "unfenced");
    executionTracker.endExecution(execution.id);
    expect((await sendRequest(socketPath, DAEMON_PREPARE_RESTART_METHOD, status)).result).toEqual({
      accepted: true,
    });
    expect(restartRequests).toBe(1);
    executionTracker.clearDaemonRestartPreparation();

    const secondAdmission = await sendRequest(
      socketPath,
      DAEMON_PREPARE_MAINTENANCE_METHOD,
      status,
    );
    const secondToken = (secondAdmission.result as { maintenanceToken: string }).maintenanceToken;
    expect((await sendRequest(socketPath, DAEMON_RESTART_ADMITTED_METHOD, status)).result).toEqual({
      accepted: false,
      reason: "maintenance_token_invalid",
    });
    expect(
      (
        await sendRequest(socketPath, DAEMON_RESTART_ADMITTED_METHOD, {
          ...status,
          processGenerationToken: "replacement-generation",
          maintenanceToken: secondToken,
        })
      ).result,
    ).toEqual({ accepted: false, reason: "generation_changed" });
    expect(
      (
        await sendRequest(socketPath, DAEMON_RESTART_ADMITTED_METHOD, {
          ...status,
          maintenanceToken: secondToken,
        })
      ).result,
    ).toEqual({ accepted: true });
    expect(restartRequests).toBe(2);
    expect(
      (
        await sendRequest(socketPath, DAEMON_RESTART_ADMITTED_METHOD, {
          ...status,
          maintenanceToken: secondToken,
        })
      ).result,
    ).toEqual({ accepted: false, reason: "maintenance_token_consumed" });
    executionTracker.clearDaemonRestartPreparation();
    executionTracker.clearDaemonMaintenancePreparation();
  });

  test("abandoned maintenance admission expires after its request socket disconnects", async () => {
    const status = (await sendRequest(socketPath, "ide/status")).result!;
    const admitted = await sendRequest(socketPath, DAEMON_PREPARE_MAINTENANCE_METHOD, status);
    const maintenanceToken = (admitted.result as { maintenanceToken: string }).maintenanceToken;

    // sendSocketRequest destroys its one-request socket after receiving the
    // response. The lease must outlive that valid transport pattern, but not
    // fence the process forever when no completion request follows.
    expect(
      (await sendRequest(socketPath, DAEMON_PREPARE_MAINTENANCE_METHOD, status)).result,
    ).toEqual({ accepted: false, reason: "maintenance_pending" });

    fakeTimer.advanceTime(DAEMON_MAINTENANCE_ADMISSION_TTL_MS);

    expect((await sendRequest(socketPath, DAEMON_PREPARE_RESTART_METHOD, status)).result).toEqual({
      accepted: true,
    });
    expect(restartRequests).toBe(1);
    expect(
      (
        await sendRequest(socketPath, DAEMON_COMPLETE_MAINTENANCE_METHOD, {
          ...status,
          maintenanceToken,
        })
      ).result,
    ).toEqual({ completed: false });
  });

  test("stale maintenance expiry cannot clear a newer admission", async () => {
    const timer = new LateCallbackFakeTimer();
    let lateRestartRequests = 0;
    const lateSocketPath = join(tmpdir(), `t-maintenance-late-${randomUUID().slice(0, 8)}.sock`);
    const lateServer = new UnixSocketServer(
      lateSocketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(),
      timer,
      null,
      {
        onRestartAccepted: () => {
          lateRestartRequests++;
        },
      },
    );

    try {
      await lateServer.start();
      const status = (await sendRequest(lateSocketPath, "ide/status")).result!;
      const firstAdmission = await sendRequest(
        lateSocketPath,
        DAEMON_PREPARE_MAINTENANCE_METHOD,
        status,
      );
      const firstToken = (firstAdmission.result as { maintenanceToken: string }).maintenanceToken;
      expect(
        (
          await sendRequest(lateSocketPath, DAEMON_COMPLETE_MAINTENANCE_METHOD, {
            ...status,
            maintenanceToken: firstToken,
          })
        ).result,
      ).toEqual({ completed: true });

      timer.advanceTime(1);
      const secondAdmission = await sendRequest(
        lateSocketPath,
        DAEMON_PREPARE_MAINTENANCE_METHOD,
        status,
      );
      const secondToken = (secondAdmission.result as { maintenanceToken: string }).maintenanceToken;
      expect(secondToken).not.toBe(firstToken);

      timer.advanceTime(DAEMON_MAINTENANCE_ADMISSION_TTL_MS - 1);

      expect(() => executionTracker.startExecution("tapOn", "still-fenced")).toThrow(
        "Daemon restart is pending",
      );
      expect(
        (
          await sendRequest(lateSocketPath, DAEMON_COMPLETE_MAINTENANCE_METHOD, {
            ...status,
            maintenanceToken: firstToken,
          })
        ).result,
      ).toEqual({ completed: false });
      expect(
        (await sendRequest(lateSocketPath, DAEMON_PREPARE_MAINTENANCE_METHOD, status)).result,
      ).toEqual({ accepted: false, reason: "maintenance_pending" });
      expect(
        (await sendRequest(lateSocketPath, DAEMON_PREPARE_RESTART_METHOD, status)).result,
      ).toEqual({ accepted: false, reason: "restart_pending" });
      expect(lateRestartRequests).toBe(0);

      timer.advanceTime(1);
      expect(
        (await sendRequest(lateSocketPath, DAEMON_PREPARE_RESTART_METHOD, status)).result,
      ).toEqual({ accepted: true });
      expect(lateRestartRequests).toBe(1);
    } finally {
      await lateServer.close();
      if (existsSync(lateSocketPath)) {
        await unlink(lateSocketPath);
      }
    }
  });

  test("acceptance persisted-session restart is generation, deadline, target, and control bound", async () => {
    const startupSecret = "live-acceptance-startup-secret-123456";
    const acceptanceSocketPath = join(
      tmpdir(),
      `t-acceptance-session-${randomUUID().slice(0, 8)}.sock`,
    );
    const timer = new FakeTimer();
    const acceptanceServer = new UnixSocketServer(
      acceptanceSocketPath,
      "http://localhost:0/mcp",
      createFakeDaemonStateWithSessions([
        {
          sessionId: "owned-session",
          platform: "android",
          stableDeviceId: "Acceptance_AVD",
        },
      ]),
      timer,
      null,
      {
        processGenerationToken: "acceptance-generation-1",
        liveAcceptanceStartupSecret: startupSecret,
      },
    );
    const scope = {
      sessionUuid: "owned-session",
      platform: "android" as const,
      stableDeviceId: "Acceptance_AVD",
      controls: {
        androidSiblingAvdName: "Acceptance_Sibling",
        androidDuplicateSerial: "emulator-5554",
        iosSameNameSiblingUdid: "00000000-0000-0000-0000-000000000002",
      },
      expiresAt: 1_000,
    };
    try {
      await acceptanceServer.start();
      const status = (await sendRequest(acceptanceSocketPath, "ide/status")).result!;
      const generation = {
        pid: status.pid as number,
        startedAt: status.startedAt as number,
        processGenerationToken: status.processGenerationToken as string,
        version: status.version as string,
        buildId: status.buildId as string,
        entryScript: status.entryScript as string,
      };
      const capability = createDaemonLiveAcceptanceScopedCapability(
        startupSecret,
        generation,
        scope,
      );
      expect(
        (
          await sendRequest(acceptanceSocketPath, DAEMON_RESTART_ACCEPTANCE_SESSION_METHOD, {
            ...status,
            scope: { ...scope, stableDeviceId: "Other_AVD" },
            acceptanceCapability: capability,
          })
        ).result,
      ).toEqual({ accepted: false, reason: "acceptance_capability_invalid" });
      const admitted = await sendPersistentSocketRequest(
        acceptanceSocketPath,
        DAEMON_RESTART_ACCEPTANCE_SESSION_METHOD,
        {
          ...status,
          scope,
          acceptanceCapability: capability,
        },
      );
      expect(admitted.response.result).toEqual({
        accepted: true,
        restartToken: expect.any(String),
      });
      expect(
        (
          await sendRequest(acceptanceSocketPath, DAEMON_RESTART_ACCEPTANCE_SESSION_METHOD, {
            ...status,
            scope,
            acceptanceCapability: capability,
          })
        ).result,
      ).toEqual({ accepted: false, reason: "restart_pending" });

      const disconnected = new Promise<void>((resolve) => admitted.socket.once("close", resolve));
      admitted.socket.destroy();
      await disconnected;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const afterDisconnect = executionTracker.startExecution("tapOn", "after-disconnect");
      executionTracker.endExecution(afterDisconnect.id);

      const committedAdmission = await sendPersistentSocketRequest(
        acceptanceSocketPath,
        DAEMON_RESTART_ACCEPTANCE_SESSION_METHOD,
        {
          ...status,
          scope,
          acceptanceCapability: capability,
        },
      );
      const restartToken = (committedAdmission.response.result as { restartToken: string })
        .restartToken;
      expect(
        (
          await sendRequestOnPersistentSocket(
            committedAdmission.socket,
            DAEMON_COMMIT_ACCEPTANCE_RESTART_METHOD,
            {
              ...status,
              restartToken,
            },
          )
        ).result,
      ).toEqual({ committed: true });
      const committedDisconnect = new Promise<void>((resolve) =>
        committedAdmission.socket.once("close", resolve),
      );
      committedAdmission.socket.destroy();
      await committedDisconnect;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(() => executionTracker.startExecution("tapOn", "after-committed-disconnect")).toThrow(
        "Daemon restart is pending",
      );

      timer.advanceTime(DAEMON_ACCEPTANCE_RESTART_ADMISSION_TTL_MS);
      const afterCommittedTimeout = executionTracker.startExecution(
        "tapOn",
        "after-committed-timeout",
      );
      executionTracker.endExecution(afterCommittedTimeout.id);
    } finally {
      await acceptanceServer.close();
      if (existsSync(acceptanceSocketPath)) {
        await unlink(acceptanceSocketPath);
      }
      executionTracker.clearDaemonRestartPreparation();
    }
  });

  test("acceptance restart timeout rolls back and stale admission callbacks cannot clear its successor", async () => {
    const startupSecret = "live-acceptance-startup-secret-123456";
    const acceptanceSocketPath = join(
      tmpdir(),
      `t-acceptance-lease-${randomUUID().slice(0, 8)}.sock`,
    );
    const timer = new LateCallbackFakeTimer();
    const acceptanceServer = new UnixSocketServer(
      acceptanceSocketPath,
      "http://localhost:0/mcp",
      createFakeDaemonStateWithSessions([
        {
          sessionId: "owned-session",
          platform: "android",
          stableDeviceId: "Acceptance_AVD",
        },
      ]),
      timer,
      null,
      {
        processGenerationToken: "acceptance-generation-1",
        liveAcceptanceStartupSecret: startupSecret,
      },
    );
    const scope = {
      sessionUuid: "owned-session",
      platform: "android" as const,
      stableDeviceId: "Acceptance_AVD",
      controls: {
        androidSiblingAvdName: "Acceptance_Sibling",
        androidDuplicateSerial: "emulator-5554",
        iosSameNameSiblingUdid: "00000000-0000-0000-0000-000000000002",
      },
      expiresAt: DAEMON_ACCEPTANCE_RESTART_ADMISSION_TTL_MS * 3,
    };
    let firstSocket: import("node:net").Socket | undefined;
    let secondSocket: import("node:net").Socket | undefined;
    try {
      await acceptanceServer.start();
      const status = (await sendRequest(acceptanceSocketPath, "ide/status")).result!;
      const capability = createDaemonLiveAcceptanceScopedCapability(
        startupSecret,
        {
          pid: status.pid as number,
          startedAt: status.startedAt as number,
          processGenerationToken: status.processGenerationToken as string,
          version: status.version as string,
          buildId: status.buildId as string,
          entryScript: status.entryScript as string,
        },
        scope,
      );
      const params = { ...status, scope, acceptanceCapability: capability };
      const first = await sendPersistentSocketRequest(
        acceptanceSocketPath,
        DAEMON_RESTART_ACCEPTANCE_SESSION_METHOD,
        params,
      );
      firstSocket = first.socket;
      const firstToken = (first.response.result as { restartToken: string }).restartToken;

      const disconnected = new Promise<void>((resolve) => first.socket.once("close", resolve));
      first.socket.destroy();
      await disconnected;
      await new Promise<void>((resolve) => setImmediate(resolve));
      timer.advanceTime(1);

      const second = await sendPersistentSocketRequest(
        acceptanceSocketPath,
        DAEMON_RESTART_ACCEPTANCE_SESSION_METHOD,
        params,
      );
      secondSocket = second.socket;
      const secondToken = (second.response.result as { restartToken: string }).restartToken;
      expect(secondToken).not.toBe(firstToken);

      // clearTimeout intentionally leaves the first callback queued. At its
      // original deadline, token matching must preserve the successor fence.
      timer.advanceTime(DAEMON_ACCEPTANCE_RESTART_ADMISSION_TTL_MS - 1);
      expect(() => executionTracker.startExecution("tapOn", "still-fenced")).toThrow(
        "Daemon restart is pending",
      );

      timer.advanceTime(1);
      const afterTimeout = executionTracker.startExecution("tapOn", "after-timeout");
      executionTracker.endExecution(afterTimeout.id);
    } finally {
      firstSocket?.destroy();
      secondSocket?.destroy();
      await acceptanceServer.close();
      if (existsSync(acceptanceSocketPath)) {
        await unlink(acceptanceSocketPath);
      }
      executionTracker.clearDaemonRestartPreparation();
    }
  });

  test("ide/status reports a concrete releaseVersion, never the 'latest' literal (EC7)", async () => {
    const response = await sendRequest(socketPath, "ide/status");
    const result = response.result as {
      releaseVersion: string;
      android: { ctrlProxy: { url: string } };
    };
    // Issue #2746: external consumers must see the concrete version the daemon
    // will actually fetch, not the floating "latest" tag.
    expect(result.releaseVersion).not.toBe("latest");
    expect(result.releaseVersion).toBe(RELEASE_CHECKSUM_REGISTRY[0].version);
    expect(result.android.ctrlProxy.url).toContain(`/${RELEASE_CHECKSUM_REGISTRY[0].version}/`);
  });

  test("ide/status honors AUTOMOBILE_VERSION + AUTOMOBILE_ASSET_BASE_URL (EC7)", async () => {
    const prevVersion = process.env.AUTOMOBILE_VERSION;
    const prevBase = process.env.AUTOMOBILE_ASSET_BASE_URL;
    process.env.AUTOMOBILE_VERSION = "0.0.18";
    process.env.AUTOMOBILE_ASSET_BASE_URL = "https://mirror.test/am";
    try {
      const response = await sendRequest(socketPath, "ide/status");
      const result = response.result as {
        releaseVersion: string;
        android: { ctrlProxy: { expectedSha256: string; url: string } };
        ios: { xcTestService: { expectedSha256: string; url: string } };
      };
      expect(result.releaseVersion).toBe("0.0.18");
      expect(result.android.ctrlProxy.url).toBe(
        "https://mirror.test/am/0.0.18/control-proxy-debug.apk",
      );
      expect(result.android.ctrlProxy.expectedSha256).toBe(
        "fd3c8d9f0b8542eaad56c78b18cf8e5666367b04ae8c4af74d8aa6dd1c8d1834",
      );
      expect(result.ios.xcTestService.url).toBe("https://mirror.test/am/0.0.18/control-proxy.ipa");
      expect(result.ios.xcTestService.expectedSha256).toBe(
        "2a5eec63bce2f9dfc227c0732fcce67378305e945604d5eedd0e3df48e37fd39",
      );
    } finally {
      if (prevVersion === undefined) {
        delete process.env.AUTOMOBILE_VERSION;
      } else {
        process.env.AUTOMOBILE_VERSION = prevVersion;
      }
      if (prevBase === undefined) {
        delete process.env.AUTOMOBILE_ASSET_BASE_URL;
      } else {
        process.env.AUTOMOBILE_ASSET_BASE_URL = prevBase;
      }
    }
  });

  test("ide/updateService returns error for missing params", async () => {
    const response = await sendRequest(socketPath, "ide/updateService", {});

    expect(response.success).toBe(false);
    expect(response.error).toContain("requires");
  });

  test("ide/updateService returns error for missing deviceId", async () => {
    const response = await sendRequest(socketPath, "ide/updateService", { platform: "android" });

    expect(response.success).toBe(false);
    expect(response.error).toContain("requires");
  });

  test("ide/updateService returns error for invalid platform", async () => {
    const response = await sendRequest(socketPath, "ide/updateService", {
      deviceId: "emulator-5554",
      platform: "windows",
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("Invalid platform");
  });

  test("ide/updateService does not report skipped Android update as success", async () => {
    const device: BootedDevice = {
      deviceId: "emulator-5554",
      platform: "android",
      isEmulator: true,
      name: "Pixel",
    };
    const platformSpy = spyOn(PlatformDeviceManagerFactory, "getInstance").mockReturnValue({
      getBootedDevices: async () => [device],
    } as any);
    const ctrlProxySpy = spyOn(AndroidCtrlProxyManager, "getInstance").mockReturnValue({
      ensureCompatibleVersion: async () => ({
        status: "skipped",
        expectedSha256: "",
        acceptedPreinstalled: true,
      }),
    } as any);

    try {
      const response = await sendRequest(socketPath, "ide/updateService", {
        deviceId: "emulator-5554",
        platform: "android",
      });

      expect(response.success).toBe(true);
      const result = response.result as {
        success: boolean;
        message: string;
        status: { status: string };
      };
      expect(result.success).toBe(false);
      expect(result.message).toContain("Accessibility service skipped");
      expect(result.status.status).toBe("skipped");
    } finally {
      ctrlProxySpy.mockRestore();
      platformSpy.mockRestore();
    }
  });
});
