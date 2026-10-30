import { describe, expect } from "bun:test";
import { InputDeviceOwnedError } from "../../src/daemon/inputDeviceOwnership";
import { killDeviceSchema, resolveKillDeviceStableTarget } from "../../src/server/deviceTools";
import { toolJson } from "../helpers/toolResponse";
import { BASE, restartStopHarness } from "../helpers/restartStopHarness";

// killDevice stops an Apple Watch simulator a session holds, with the same holder checks as any
// other device, and releases that session (#14908).
describe("killDevice on an Apple Watch simulator", () => {
  const { test, fixture } = restartStopHarness();

  test("the schema accepts a watchos device", () => {
    const parsed = killDeviceSchema.parse({
      device: { name: "Apple Watch Series 10 (46mm)", deviceId: "WATCH-UDID", platform: "watchos" },
    });
    expect(parsed.device.platform).toBe("watchos");
  });

  test("a watch kill takes the same stable lifecycle lease identity as a watch start", () => {
    expect(
      resolveKillDeviceStableTarget(
        { name: "Apple Watch Series 10 (46mm)", deviceId: "WATCH-UDID", platform: "watchos" },
        undefined,
      ),
    ).toEqual({ platform: "watchos", stableId: "WATCH-UDID" });
  });

  test("the holder stops the watch through the platform kill and its session is released", async () => {
    const f = await fixture("watchos", false, false, "owner-conn", false);
    expect(f.pool.getDevice(f.device.deviceId)).toMatchObject({
      platform: "watchos",
      sessionId: BASE,
    });

    const result = await f.call("killDevice", BASE, false, "owner-conn");

    expect(toolJson(result)).toMatchObject({
      message: "watchos 'restart-phone' shutdown successfully",
      platform: "watchos",
    });
    expect(f.manager.killedTargets).toEqual([f.device]);
    expect(f.sessions.hasSession(BASE)).toBe(false);
    expect(f.pool.getDevice(f.device.deviceId)).toBeNull();
  });

  test("a caller that does not hold the watch is refused before any platform kill", async () => {
    const f = await fixture("watchos", false, false, "owner-conn", false);

    await expect(f.call("killDevice", "rival", false, "rival-conn")).rejects.toBeInstanceOf(
      InputDeviceOwnedError,
    );

    expect(f.manager.killed).toEqual([]);
    expect(f.pool.getDevice(f.device.deviceId)?.sessionId).toBe(BASE);
  });
});
