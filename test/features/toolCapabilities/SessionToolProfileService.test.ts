import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TOOL_CAPABILITIES,
  SessionToolProfileService,
  type SessionToolProfileRepository,
} from "../../../src/features/toolCapabilities/SessionToolProfileService";

class FakeRepository implements SessionToolProfileRepository {
  readonly rows = new Map<string, Map<string, boolean>>();

  async list(sessionUuid: string): Promise<Map<string, boolean>> {
    return new Map(this.rows.get(sessionUuid) ?? []);
  }

  async set(sessionUuid: string, capability: string, enabled: boolean): Promise<void> {
    const values = this.rows.get(sessionUuid) ?? new Map<string, boolean>();
    values.set(capability, enabled);
    this.rows.set(sessionUuid, values);
  }
}

describe("SessionToolProfileService", () => {
  test("keeps the existing surface before a device session binds", async () => {
    const service = new SessionToolProfileService(new FakeRepository());
    expect(await service.isEnabled(undefined, "clipboard")).toBe(true);
    expect(DEFAULT_TOOL_CAPABILITIES.has("clipboard")).toBe(true);
  });

  test("keeps the existing surface for an untouched device session", async () => {
    const service = new SessionToolProfileService(new FakeRepository());
    expect(await service.isEnabled("device-session-1", "clipboard")).toBe(true);
  });

  test("persists a session override and restores it in a fresh service", async () => {
    const repository = new FakeRepository();
    const first = new SessionToolProfileService(repository);
    await first.setEnabled("device-session-1", "clipboard", true);

    const restarted = new SessionToolProfileService(repository);
    expect(await restarted.isEnabled("device-session-1", "clipboard")).toBe(true);
  });

  test("lets a session profile narrow the default surface", async () => {
    const repository = new FakeRepository();
    const service = new SessionToolProfileService(repository);

    await service.setEnabled("device-session-1", "clipboard", false);

    expect(await service.isEnabled("device-session-1", "clipboard")).toBe(false);
  });

  test("uses environment defaults only when no session override exists", async () => {
    const repository = new FakeRepository();
    const service = new SessionToolProfileService(repository, new Set(["clipboard"]));
    expect(await service.isEnabled("device-session-1", "clipboard")).toBe(true);

    await service.setEnabled("device-session-1", "clipboard", false);
    expect(await service.isEnabled("device-session-1", "clipboard")).toBe(false);
  });
});
