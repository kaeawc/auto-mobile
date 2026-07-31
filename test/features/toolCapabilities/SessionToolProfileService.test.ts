import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TOOL_CAPABILITIES,
  getEnvironmentDefaultToolCapabilities,
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

  async deleteSession(sessionUuid: string): Promise<void> {
    this.rows.delete(sessionUuid);
  }
}

describe("SessionToolProfileService", () => {
  test("hides opt-in capabilities before a device session binds", async () => {
    const service = new SessionToolProfileService(new FakeRepository());
    expect(await service.isEnabled(undefined, "clipboard")).toBe(false);
    expect(DEFAULT_TOOL_CAPABILITIES.has("clipboard")).toBe(false);
  });

  test("hides opt-in capabilities for an untouched device session", async () => {
    const service = new SessionToolProfileService(new FakeRepository());
    expect(await service.isEnabled("device-session-1", "clipboard")).toBe(false);
  });

  test.each([
    ["unset", {}],
    ["empty", { AUTOMOBILE_TOOLSET_DEFAULTS: "  " }],
  ])("uses the core baseline when defaults are %s", (_description, environment) => {
    expect(getEnvironmentDefaultToolCapabilities(environment)).toEqual(DEFAULT_TOOL_CAPABILITIES);
  });

  test("replaces the baseline with explicit defaults before adding individual capabilities", () => {
    const defaults = getEnvironmentDefaultToolCapabilities({
      AUTOMOBILE_TOOLSET_DEFAULTS: "clipboard",
      AUTOMOBILE_TOOLSET_ADVANCED_INTERACTION: "1",
    });

    expect(defaults).toEqual(new Set(["clipboard", "advanced-interaction"]));
    expect(defaults.has("device-settings")).toBe(false);
  });

  test("persists a disabled session override and restores it in a fresh service", async () => {
    const repository = new FakeRepository();
    const environmentDefaults = new Set(["clipboard"]);
    const first = new SessionToolProfileService(repository, environmentDefaults);
    await first.setEnabled("device-session-1", "clipboard", false);

    const restarted = new SessionToolProfileService(repository, environmentDefaults);
    expect(await restarted.isEnabled("device-session-1", "clipboard")).toBe(false);
  });

  test("lets a session profile enable an opt-in capability", async () => {
    const repository = new FakeRepository();
    const service = new SessionToolProfileService(repository);

    await service.setEnabled("device-session-1", "clipboard", true);

    expect(await service.isEnabled("device-session-1", "clipboard")).toBe(true);
  });

  test("uses environment defaults only when no session override exists", async () => {
    const repository = new FakeRepository();
    const service = new SessionToolProfileService(repository, new Set(["clipboard"]));
    expect(await service.isEnabled("device-session-1", "clipboard")).toBe(true);

    await service.setEnabled("device-session-1", "clipboard", false);
    expect(await service.isEnabled("device-session-1", "clipboard")).toBe(false);
  });

  test("removes overrides after the routing session is released", async () => {
    const repository = new FakeRepository();
    const service = new SessionToolProfileService(repository);
    await service.setEnabled("device-session-1", "clipboard", true);

    await service.deleteSession("device-session-1");

    expect(await service.isEnabled("device-session-1", "clipboard")).toBe(false);
  });
});
