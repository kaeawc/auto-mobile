import { beforeEach, describe, expect, test } from "bun:test";
import { SystemAlertPolicyRegistry } from "../../src/features/action/systemAlerts/SystemAlertPolicy";
import type { BootedDevice } from "../../src/models";
import {
  createSystemAlertsHandler,
  systemAlertsSchema,
  type SystemAlertsSessionHost,
} from "../../src/server/systemAlertTools";
import { readToolResponse } from "../helpers/toolResponse";

const emulator: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };

describe("systemAlerts tool (#14106)", () => {
  let registry: SystemAlertPolicyRegistry;
  let sessions: Record<string, { sessionId: string; assignedDevice: string; admitted: boolean }>;

  const host: SystemAlertsSessionHost = {
    getSession: (sessionId) => sessions[sessionId] ?? null,
    isAdmittedForAutomation: (session) => sessions[session.sessionId]?.admitted === true,
  };

  const call = async (args: Record<string, unknown>) => {
    const handler = createSystemAlertsHandler({ registry, sessionManager: () => host });
    return readToolResponse(await handler(emulator, systemAlertsSchema.parse(args)))
      .structuredContent;
  };

  beforeEach(() => {
    registry = new SystemAlertPolicyRegistry();
    sessions = {
      "session-1": { sessionId: "session-1", assignedDevice: emulator.deviceId, admitted: true },
      elsewhere: { sessionId: "elsewhere", assignedDevice: "emulator-5556", admitted: true },
    };
  });

  test("setPolicy defaults to report and a session's policy clears on its release", async () => {
    expect(await call({ action: "setPolicy", sessionUuid: "session-1" })).toMatchObject({
      success: true,
      action: "setPolicy",
      active: true,
      policy: "report",
      match: [],
      clearsOnRelease: true,
    });
    expect(registry.get(emulator.deviceId)).toEqual({
      policy: "report",
      match: [],
      owner: "session-1",
    });
  });

  test("a sessionless policy and its match entries persist until cleared", async () => {
    const match = [{ textContains: "Kamera", buttonText: "Erlauben" }];
    expect(await call({ action: "setPolicy", policy: "allow", match })).toMatchObject({
      policy: "allow",
      match,
      clearsOnRelease: false,
    });
    expect(await call({ action: "get" })).toMatchObject({ active: true, policy: "allow", match });
    expect(await call({ action: "clear" })).toMatchObject({ active: false, cleared: true });
    expect(await call({ action: "get" })).toMatchObject({ active: false, policy: "report" });
  });

  test("a session that does not hold the device is refused", async () => {
    await expect(
      call({ action: "setPolicy", policy: "allow", sessionUuid: "elsewhere" }),
    ).rejects.toThrow("Cannot set a system-alert policy");
    sessions["session-1"].admitted = false;
    await expect(call({ action: "setPolicy", sessionUuid: "session-1" })).rejects.toThrow(
      "Cannot set a system-alert policy",
    );
    expect(registry.get(emulator.deviceId)).toBeUndefined();
  });

  test("policy and match are only accepted with setPolicy", async () => {
    await expect(call({ action: "get", policy: "allow" })).rejects.toThrow("only setPolicy does");
    await expect(call({ action: "clear", match: [{ buttonText: "OK" }] })).rejects.toThrow(
      "only setPolicy does",
    );
    expect(() => systemAlertsSchema.parse({ action: "setPolicy", match: [{}] })).toThrow();
  });
});
