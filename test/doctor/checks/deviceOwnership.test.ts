import { describe, expect, spyOn, test } from "bun:test";
import { checkDeviceOwnership } from "../../../src/doctor/checks/deviceOwnership";
import { judgeOwnership } from "../../../src/daemon/deviceOwnershipView";
import { logger } from "../../../src/utils/logger";

const device = { platform: "android", deviceId: "emulator-5554" } as const;

describe("checkDeviceOwnership", () => {
  test("passes when no device has a disagreement", async () => {
    const result = await checkDeviceOwnership({
      view: { snapshot: async () => [judgeOwnership(device, [])] },
    });
    expect(result.status).toBe("pass");
  });

  test("warns and names each disagreement", async () => {
    const contested = judgeOwnership(device, [
      { source: "claim_file", pid: 1, alive: true },
      { source: "forward_lease", pid: 2, alive: true },
    ]);
    const result = await checkDeviceOwnership({ view: { snapshot: async () => [contested] } });
    expect(result.status).toBe("warn");
    expect(result.value).toBe(1);
    expect(result.detail).toContain("emulator-5554: conflicting_live_pids");
  });

  test("logs then returns a typed warning when the view throws", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const result = await checkDeviceOwnership({
      view: {
        snapshot: async () => {
          throw new Error("registry locked");
        },
      },
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("registry locked");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
