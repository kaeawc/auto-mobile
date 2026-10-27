import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { PersonaRestoreRegistry } from "../../src/features/utility/PersonaRestore";
import { createPersonaHandler, personaSchema } from "../../src/server/personaTools";
import { personaResultSchema } from "../../src/server/personaToolOutputSchemas";
import type { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakePersonaFacetExecutors } from "../fakes/FakePersonaFacetExecutors";

const emulator: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };
const APP = "com.example.app";

function structured(response: unknown): unknown {
  return (response as { structuredContent?: unknown }).structuredContent;
}

function isError(response: unknown): boolean | undefined {
  return (response as { isError?: boolean }).isError;
}

describe("manufacturerProfile tool (#14055)", () => {
  let manager: SessionManager;
  let executors: FakePersonaFacetExecutors;
  let handler: ReturnType<typeof createPersonaHandler>;

  beforeEach(() => {
    manager = new SessionManager(new FakeTimer(), new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    executors = new FakePersonaFacetExecutors();
    handler = createPersonaHandler({
      sessionManager: () => manager,
      executorsFor: () => executors,
      registry: new PersonaRestoreRegistry(),
    });
  });

  afterEach(() => {
    manager.stopCleanupTimer();
  });

  test("the schema is strict and names every manufacturer profile and non-emulatable capability", () => {
    expect(
      personaSchema.safeParse({ action: "apply", manufacturerProfile: "samsung-oneui", appId: APP })
        .success,
    ).toBe(true);
    expect(
      personaSchema.safeParse({ action: "apply", manufacturerProfile: "huawei-emui" }).success,
    ).toBe(false);
    expect(
      personaSchema.safeParse({
        action: "apply",
        manufacturerProfile: "samsung-oneui",
        requires: ["dex"],
      }).success,
    ).toBe(false);
    expect(personaSchema.safeParse({ action: "list", extra: 1 }).success).toBe(false);
  });

  test("list and describe report the versioned catalog without touching the device", async () => {
    const list = personaResultSchema.parse(structured(await handler(emulator, { action: "list" })));
    expect(list.catalogVersion).toBe(1);
    expect(list.manufacturerProfiles?.map((profile) => profile.id)).toContain("pixel-baseline");

    const description = personaResultSchema.parse(
      structured(
        await handler(emulator, { action: "describe", manufacturerProfile: "xiaomi-hyperos" }),
      ),
    );
    expect(description.facets?.map((facet) => [facet.facet, facet.evidence?.status])).toEqual([
      ["keyboard", "inferred"],
      ["kill", "inferred"],
      ["display", "inferred"],
    ]);
    expect(description.nonEmulatable?.map((entry) => entry.id)).toContain(
      "xiaomi-proprietary-appops",
    );
    expect(executors.calls).toEqual([]);
  });

  test("describe and apply need manufacturerProfile", async () => {
    await expect(handler(emulator, { action: "describe" })).rejects.toThrow(
      "needs manufacturerProfile",
    );
    await expect(handler(emulator, { action: "apply", appId: APP })).rejects.toThrow(
      "needs manufacturerProfile",
    );
  });

  test("apply and reset refuse a non-Android device before anything changes", async () => {
    const simulator: BootedDevice = { name: "sim", platform: "ios", deviceId: "SIM-1" };
    await expect(
      handler(simulator, { action: "apply", manufacturerProfile: "pixel-baseline" }),
    ).rejects.toThrow("Android-only");
    await expect(handler(simulator, { action: "reset" })).rejects.toThrow("Android-only");
    expect(executors.calls).toEqual([]);
  });

  test("apply returns a structured result naming the manufacturer profile version", async () => {
    const response = await handler(emulator, {
      action: "apply",
      manufacturerProfile: "samsung-oneui",
      appId: APP,
    });
    const result = personaResultSchema.parse(structured(response));
    expect(result).toMatchObject({
      success: true,
      action: "apply",
      status: "applied",
      manufacturerProfile: { id: "samsung-oneui", version: 1 },
    });
    expect(isError(response)).toBeFalsy();
  });

  test("a task needing a non-emulatable capability gets a typed route-to-real-device error", async () => {
    const response = await handler(emulator, {
      action: "apply",
      manufacturerProfile: "samsung-oneui",
      appId: APP,
      requires: ["knox"],
    });
    const result = personaResultSchema.parse(structured(response));
    expect(result).toMatchObject({
      success: false,
      status: "route_to_real_device",
      capabilities: [{ id: "knox" }],
    });
    expect(isError(response)).toBe(true);
    expect(executors.calls).toEqual([]);
  });

  test("a session's apply passes the session id to the executors as owner", async () => {
    await manager.createSession("session-1", emulator.deviceId, "android");
    await handler(emulator, {
      action: "apply",
      manufacturerProfile: "motorola",
      appId: APP,
      sessionUuid: "session-1",
    });
    expect(executors.calls[1]).toEqual({
      facet: "kill",
      action: "apply",
      appId: APP,
      profile: "motorola-adaptive",
      owner: "session-1",
    });
  });

  test("a session bound to another device is refused before anything changes", async () => {
    await manager.createSession("session-1", "emulator-5556", "android");
    await expect(
      handler(emulator, {
        action: "apply",
        manufacturerProfile: "motorola",
        appId: APP,
        sessionUuid: "session-1",
      }),
    ).rejects.toThrow("Cannot apply or reset a manufacturer profile");
    expect(executors.calls).toEqual([]);
  });

  test("reset restores what apply changed", async () => {
    await handler(emulator, { action: "apply", manufacturerProfile: "oppo-coloros", appId: APP });
    executors.calls.length = 0;
    const result = personaResultSchema.parse(
      structured(await handler(emulator, { action: "reset" })),
    );
    expect(result).toMatchObject({
      success: true,
      action: "reset",
      manufacturerProfileId: "oppo-coloros",
    });
    expect(executors.calls.map((call) => `${call.facet}:${call.action}`)).toEqual([
      "display:reset",
      "kill:reset",
      "keyboard:reset",
    ]);
  });
});
