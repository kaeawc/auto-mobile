import { describe, expect, test } from "bun:test";
import { FakeDeviceSessionPersistence } from "./FakeDeviceSessionPersistence";

async function seeded(
  fake: FakeDeviceSessionPersistence,
  sessionUuid: string,
  daemonSessionId: string | undefined,
  expiresAtMs = 1_000,
) {
  await fake.upsertActiveSession({
    sessionUuid,
    deviceId: "device",
    platform: "android",
    createdAtMs: 0,
    lastUsedAtMs: 10,
    expiresAtMs,
    daemonSessionId,
    sessionTimeoutMs: 1_000,
    heartbeatTimeoutMs: 1_000,
    hasReceivedHeartbeat: false,
  });
}

describe("FakeDeviceSessionPersistence.markStaleActiveSessionsExpired", () => {
  test("expires rows of another daemon and keeps the current daemon's rows", async () => {
    const fake = new FakeDeviceSessionPersistence();
    await seeded(fake, "mine", "daemon-a");
    await seeded(fake, "theirs", "daemon-b");
    await fake.markStaleActiveSessionsExpired("daemon-a", 500);
    expect((await fake.getSession("mine"))?.status).toBe("active");
    const expired = await fake.getSession("theirs");
    expect(expired?.status).toBe("expired");
    expect(expired?.release_reason).toBe("daemon-restart");
    expect(expired?.released_at_ms).toBe(500);
  });

  test("spares a live peer's rows", async () => {
    const fake = new FakeDeviceSessionPersistence();
    await seeded(fake, "peer", "daemon-b");
    await fake.markStaleActiveSessionsExpired(
      "daemon-a",
      500,
      "daemon-restart",
      new Set(["daemon-b"]),
    );
    expect((await fake.getSession("peer"))?.status).toBe("active");
  });

  test("ownerless rows are reclaimed without a live peer, and only when lapsed with one", async () => {
    const fake = new FakeDeviceSessionPersistence();
    await seeded(fake, "legacy-unexpired", undefined, 1_000);
    await seeded(fake, "legacy-lapsed", undefined, 100);
    await fake.markStaleActiveSessionsExpired(
      "daemon-a",
      500,
      "daemon-restart",
      new Set(["daemon-b"]),
    );
    expect((await fake.getSession("legacy-unexpired"))?.status).toBe("active");
    expect((await fake.getSession("legacy-lapsed"))?.status).toBe("expired");
    await fake.markStaleActiveSessionsExpired("daemon-a", 500);
    expect((await fake.getSession("legacy-unexpired"))?.status).toBe("expired");
  });
});

describe("FakeDeviceSessionPersistence.markAutolockSession", () => {
  test("stamps a live row as autolock", async () => {
    const fake = new FakeDeviceSessionPersistence();
    await seeded(fake, "s", "daemon-a");
    await fake.markAutolockSession("s", {
      mcpSessionId: "mcp",
      daemonSessionId: "daemon-a",
      lastUsedAtMs: 20,
      expiresAtMs: 2_000,
    });
    const row = await fake.getSession("s");
    expect(row?.source).toBe("autolock");
    expect(row?.autolock_enabled).toBe(1);
    expect(row?.mcp_session_id).toBe("mcp");
    expect(row?.expires_at_ms).toBe(2_000);
  });

  test("a newer activity snapshot is not overwritten", async () => {
    const fake = new FakeDeviceSessionPersistence();
    await seeded(fake, "s", "daemon-a");
    await fake.markAutolockSession("s", { lastUsedAtMs: 50, expiresAtMs: 5_000 });
    await fake.markAutolockSession("s", { lastUsedAtMs: 20, expiresAtMs: 2_000 });
    expect((await fake.getSession("s"))?.expires_at_ms).toBe(5_000);
  });

  test("ignores a released row", async () => {
    const fake = new FakeDeviceSessionPersistence();
    await seeded(fake, "s", "daemon-a");
    await fake.markStaleActiveSessionsExpired("daemon-b", 500);
    await fake.markAutolockSession("s", { lastUsedAtMs: 20, expiresAtMs: 2_000 });
    expect((await fake.getSession("s"))?.status).toBe("expired");
  });
});
