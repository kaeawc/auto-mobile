import { describe, expect, spyOn, test } from "bun:test";
import {
  DeviceSessionRepository,
  deviceRestartReleaseReason,
} from "../../../src/db/deviceSessionRepository";
import type { DeviceSession } from "../../../src/db/types";
import { sessionDisposition } from "../../../src/daemon/sessionBroker/sessionDisposition";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../../src/utils/deviceTimeouts";
import { logger } from "../../../src/utils/logger";
import { createTestDatabase } from "../../db/testDbHelper";
import { FakeTimer } from "../../fakes/FakeTimer";

const row: DeviceSession = {
  session_uuid: "handoff",
  device_id: "emulator-5554",
  stable_device_id: "Pixel_8_API_35",
  platform: "android",
  status: "released",
  release_reason: deviceRestartReleaseReason("Pixel_8_API_35"),
  released_at_ms: 1000,
  source: null,
  autolock_enabled: 1,
  mcp_session_id: null,
  daemon_session_id: "daemon",
  created_at_ms: 0,
  last_used_at_ms: 1000,
  activity_seq: 0,
  expires_at_ms: 3_600_000,
  session_timeout_ms: 3_600_000,
  heartbeat_timeout_ms: 60_000,
  has_received_heartbeat: 1,
  stable_identity_generation: 0,
  liveness_contract_generation: 0,
  heartbeat_timeout_source: null,
  liveness_policy: null,
  pre_cli_heartbeat_timeout_ms: null,
  pre_cli_heartbeat_timeout_source: null,
  pre_cli_session_timeout_ms: null,
  liveness_owner_token: null,
  created_at: "",
  updated_at: "",
};

function rig(stored: DeviceSession | undefined = row) {
  const timer = new FakeTimer();
  timer.setCurrentTime(1001);
  return { timer, isLive: () => false, getSession: () => Promise.resolve(stored) };
}

describe("broker session disposition", () => {
  test("live session wins without a durable lookup", async () => {
    const ports = rig();
    const getSession = spyOn(ports, "getSession");
    expect(await sessionDisposition("handoff", { ...ports, isLive: () => true })).toBe("live");
    expect(getSession).not.toHaveBeenCalled();
  });

  test("device-restart row preserves its UUID inside the bounded handoff window", async () => {
    expect(await sessionDisposition("handoff", rig())).toBe("recoverable-handoff");
  });

  test("handoff expires exactly at the persisted restart deadline", async () => {
    const ports = rig();
    ports.timer.setCurrentTime(1000 + DEFAULT_DEVICE_READY_TIMEOUT_MS);
    expect(await sessionDisposition("handoff", ports)).toBe("gone");
  });

  test.each(["explicit-release", "expired", "restart-recovery-timeout", "daemon-shutdown"])(
    "%s is terminal for broker handoff",
    async (reason) => {
      expect(await sessionDisposition("handoff", rig({ ...row, release_reason: reason }))).toBe(
        "gone",
      );
    },
  );

  test("missing row and missing release timestamp are gone", async () => {
    expect(
      await sessionDisposition("missing", {
        ...rig(),
        getSession: () => Promise.resolve(undefined),
      }),
    ).toBe("gone");
    expect(await sessionDisposition("handoff", rig({ ...row, released_at_ms: null }))).toBe("gone");
  });

  test("terminal status and applicable idle expiry end handoff", async () => {
    expect(await sessionDisposition("handoff", rig({ ...row, status: "expired" }))).toBe("gone");
    expect(await sessionDisposition("handoff", rig({ ...row, expires_at_ms: 1001 }))).toBe("gone");
  });

  test("lookup failure warns and retains the resource for a later sweep", async () => {
    const error = new Error("database unavailable");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(
        await sessionDisposition("handoff", { ...rig(), getSession: () => Promise.reject(error) }),
      ).toBe("recoverable-handoff");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("handoff"), error);
    } finally {
      warn.mockRestore();
    }
  });

  test("real device-restart persistence stays recoverable until its window ends", async () => {
    const db = await createTestDatabase();
    const ports = rig();
    const repository = new DeviceSessionRepository(db, ports.timer);
    try {
      await repository.upsertActiveSession({
        sessionUuid: "handoff",
        deviceId: "emulator-5554",
        stableDeviceId: "Pixel_8_API_35",
        platform: "android",
        daemonSessionId: "daemon",
        createdAtMs: 0,
        lastUsedAtMs: 1000,
        expiresAtMs: 3_600_000,
        sessionTimeoutMs: 3_600_000,
        heartbeatTimeoutMs: 60_000,
        hasReceivedHeartbeat: true,
      });
      await repository.markReleased("handoff", "released", 1000, {
        reason: deviceRestartReleaseReason("Pixel_8_API_35"),
      });
      const dependencies = { ...ports, getSession: (uuid: string) => repository.getSession(uuid) };
      expect(await sessionDisposition("handoff", dependencies)).toBe("recoverable-handoff");
      ports.timer.setCurrentTime(1000 + DEFAULT_DEVICE_READY_TIMEOUT_MS);
      expect(await sessionDisposition("handoff", dependencies)).toBe("gone");
    } finally {
      await db.destroy();
    }
  });
});
