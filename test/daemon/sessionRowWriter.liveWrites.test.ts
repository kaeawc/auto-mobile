import { expect, test } from "bun:test";
import { SerializedSessionRowWriter } from "../../src/daemon/sessionRowWriter";
import type { SessionManager } from "../../src/daemon/sessionManager";
import { SessionReleasePersistTimeoutError } from "../../src/daemon/releaseErrors";
import { fixedBackoff } from "../../src/utils/Backoff";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeLogger } from "../fakes/FakeLogger";
import { FakeSessionRowWriter } from "../fakes/FakeSessionRowWriter";
import { FakeTimer } from "../fakes/FakeTimer";
import { installSessionManagerCleanup, makeSessionManager } from "../helpers/sessionManagerSuite";

installSessionManagerCleanup();

const record = {
  sessionUuid: "live-uuid",
  deviceId: "device",
  platform: "android" as const,
  createdAtMs: 0,
  lastUsedAtMs: 0,
  expiresAtMs: 10_000,
  sessionTimeoutMs: 10_000,
  heartbeatTimeoutMs: 1000,
  hasReceivedHeartbeat: false,
};

test("the writer issues create, activity and ownership statements against persistence", async () => {
  const persistence = new FakeDeviceSessionPersistence();
  const writer = SerializedSessionRowWriter.create({
    persistence,
    timer: new FakeTimer(),
    backoff: fixedBackoff(1),
    logger: new FakeLogger(),
    timeoutMs: 100,
    timeoutError: SessionReleasePersistTimeoutError,
  });
  await writer.upsertLive(record, 0);
  await writer.recordLiveActivity("live-uuid", {
    lastUsedAtMs: 500,
    expiresAtMs: 20_000,
    sessionTimeoutMs: 10_000,
    heartbeatTimeoutMs: 1000,
    hasReceivedHeartbeat: true,
  });
  await writer.replaceLiveOwnership("live-uuid", "owner");
  const row = await persistence.getSession("live-uuid");
  expect(row?.last_used_at_ms).toBe(500);
  expect(row?.expires_at_ms).toBe(20_000);
});

test("manager create writes the live row through the injected writer", async () => {
  const persistence = new FakeDeviceSessionPersistence();
  const writer = new FakeSessionRowWriter(persistence);
  const manager: SessionManager = makeSessionManager({ timer: new FakeTimer(), fakeBarrier: true });
  manager.setRowWriter(writer);
  manager.stopCleanupTimer();
  await manager.createSession("routed", "fake-device", "android", { timeoutMs: 60_000 });
  expect(writer.liveWrites.map((write) => write.kind)).toEqual(["upsert", "ownership"]);
  expect(writer.liveWrites.every((write) => write.uuid === "routed")).toBe(true);
});
