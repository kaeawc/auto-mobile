import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../../src/models";
import { DeviceState } from "../../../../src/features/utility/DeviceState";
import { ScreenLockRegistry } from "../../../../src/features/utility/screenLock/ScreenLockRegistry";
import type { ScreenLockMutation } from "../../../../src/features/utility/screenLock/ScreenLockOperations";
import { setDeviceStateResultSchema } from "../../../../src/server/toolOutputSchemas";
import { FakeLockSettingsClient } from "../../../fakes/FakeLockSettingsClient";

const android: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };
const ios: BootedDevice = { name: "iPhone", platform: "ios", deviceId: "SIM-1" };
const PIN = "1357";

function harness(options: {
  lock?: ConstructorParameters<typeof FakeLockSettingsClient>[0];
  owner?: string;
  device?: BootedDevice;
  registry?: ScreenLockRegistry;
}) {
  const client = new FakeLockSettingsClient(options.lock ?? null);
  const registry = options.registry ?? new ScreenLockRegistry();
  const forgotten: string[] = [];
  const mutation: ScreenLockMutation = (write) => write(options.owner);
  const state = new DeviceState(options.device ?? android, {
    screenLock: {
      clientFactory: () => client,
      registry,
      forgetRememberedUnlock: async (deviceId) => {
        forgotten.push(deviceId);
      },
      mutation,
    },
  });
  return { client, registry, forgotten, state };
}

describe("setDeviceState screenLock", () => {
  test("a session sets a PIN, records it for release, and returns no credential", async () => {
    const { client, registry, forgotten, state } = harness({ owner: "s-1" });

    const result = await state.setState({ screenLock: { type: "pin", credential: PIN } });

    expect(result.success).toBe(true);
    expect(result.screenLock).toEqual({
      supported: true,
      type: "pin",
      secure: true,
      set: true,
      outcome: "set",
      verified: true,
      restoreOnRelease: true,
    });
    expect(client.writes()).toEqual([{ method: "setCredential", type: "pin", credential: PIN }]);
    expect(registry.get("emulator-5554")).toEqual({
      deviceId: "emulator-5554",
      sessionId: "s-1",
      type: "pin",
      credential: PIN,
    });
    expect(forgotten).toEqual(["emulator-5554"]);
    expect(JSON.stringify(result)).not.toContain(PIN);
    expect(setDeviceStateResultSchema.parse({ message: "ok", ...result })).toBeDefined();
  });

  test("the same session changes its own credential with --old", async () => {
    const registry = new ScreenLockRegistry();
    const first = harness({ owner: "s-1", registry });
    await first.state.setState({ screenLock: { type: "pin", credential: PIN } });
    const second = harness({ owner: "s-1", registry, lock: { type: "pin", credential: PIN } });

    const result = await second.state.setState({
      screenLock: { type: "password", credential: "n3w-pass" },
    });

    expect(result.screenLock).toMatchObject({ set: true, outcome: "changed", type: "password" });
    expect(second.client.writes()).toEqual([
      { method: "setCredential", type: "password", credential: "n3w-pass", oldCredential: PIN },
    ]);
    expect(registry.get("emulator-5554")?.credential).toBe("n3w-pass");
  });

  test("refuses to overwrite a credential this session did not set", async () => {
    const registry = new ScreenLockRegistry();
    registry.record({
      deviceId: "emulator-5554",
      sessionId: "s-other",
      type: "pin",
      credential: PIN,
    });
    const { client, state } = harness({
      owner: "s-1",
      registry,
      lock: { type: "pin", credential: PIN },
    });

    const result = await state.setState({ screenLock: { type: "pin", credential: "2468" } });

    expect(result.success).toBe(false);
    expect(result.screenLock?.errorCode).toBe("lock_credential_preexisting");
    expect(result.error).toContain("lock_credential_preexisting");
    expect(client.writes()).toEqual([]);
    expect(registry.get("emulator-5554")?.sessionId).toBe("s-other");
  });

  test("an unreadable lock type is left to the device, whose refusal is typed", async () => {
    const { client, state } = harness({ owner: "s-1", lock: { type: "pin", credential: PIN } });
    client.nextReadings.push({ type: "unknown" });

    const result = await state.setState({ screenLock: { type: "pin", credential: "2468" } });

    expect(result.screenLock?.errorCode).toBe("lock_credential_preexisting");
    expect(client.writes()).toHaveLength(1);
  });

  test("a stale own credential is forgotten so release never submits it", async () => {
    const registry = new ScreenLockRegistry();
    registry.record({ deviceId: "emulator-5554", sessionId: "s-1", type: "pin", credential: PIN });
    const { state } = harness({
      owner: "s-1",
      registry,
      lock: { type: "pin", credential: "9999" },
    });

    const result = await state.setState({ screenLock: { type: "pin", credential: "2468" } });

    expect(result.screenLock?.errorCode).toBe("lock_credential_mismatch");
    expect(registry.get("emulator-5554")).toBeUndefined();
  });

  test("a sessionless set is applied, not recorded, and says it is never cleared", async () => {
    const { registry, state } = harness({});

    const result = await state.setState({ screenLock: { type: "pattern", credential: "14789" } });

    expect(result.screenLock).toMatchObject({ set: true, restoreOnRelease: false });
    expect(result.screenLock?.warning).toContain("nothing clears it automatically");
    expect(registry.get("emulator-5554")).toBeUndefined();
  });

  test("type none clears with currentCredential and drops any record", async () => {
    const registry = new ScreenLockRegistry();
    registry.record({ deviceId: "emulator-5554", sessionId: "s-1", type: "pin", credential: PIN });
    const { client, forgotten, state } = harness({
      owner: "s-1",
      registry,
      lock: { type: "pin", credential: PIN },
    });

    const result = await state.setState({ screenLock: { type: "none", currentCredential: PIN } });

    expect(result.success).toBe(true);
    expect(result.screenLock).toMatchObject({ type: "none", cleared: true, verified: true });
    expect(client.writes()).toEqual([{ method: "clearCredential", oldCredential: PIN }]);
    expect(registry.get("emulator-5554")).toBeUndefined();
    expect(forgotten).toEqual(["emulator-5554"]);
  });

  test("type none on an unlocked device changes nothing", async () => {
    const { client, state } = harness({ owner: "s-1" });
    const result = await state.setState({ screenLock: { type: "none", currentCredential: PIN } });
    expect(result.screenLock).toMatchObject({ outcome: "unchanged", verified: true });
    expect(client.writes()).toEqual([]);
  });

  test("a wrong currentCredential is a typed mismatch", async () => {
    const { state } = harness({ lock: { type: "pin", credential: PIN } });
    const result = await state.setState({
      screenLock: { type: "none", currentCredential: "0000" },
    });
    expect(result.success).toBe(false);
    expect(result.screenLock?.errorCode).toBe("lock_credential_mismatch");
    expect(JSON.stringify(result)).not.toContain("0000");
  });

  test("a device write failure is reported with its scrubbed detail", async () => {
    const { client, state } = harness({ owner: "s-1" });
    client.nextResults.push({ outcome: "rejected", detail: "New credential doesn't satisfy" });
    const result = await state.setState({ screenLock: { type: "pin", credential: PIN } });
    expect(result.success).toBe(false);
    expect(result.screenLock?.error).toContain("rejected");
  });

  test("iOS reports screenLock unsupported without touching a device", async () => {
    const { client, state } = harness({ device: ios, owner: "s-1" });
    const result = await state.setState({ screenLock: { type: "pin", credential: PIN } });
    expect(result.success).toBe(false);
    expect(result.screenLock).toMatchObject({ supported: false });
    expect(client.calls).toEqual([]);
  });
});

describe("getDeviceState screenLock", () => {
  test("reads the credential type", async () => {
    const { state } = harness({ lock: { type: "pin", credential: PIN } });
    const result = await state.getState(["screenLock"]);
    expect(result.success).toBe(true);
    expect(result.screenLock).toEqual({ supported: true, type: "pin", secure: true });
    expect(JSON.stringify(result)).not.toContain(PIN);
  });
});
