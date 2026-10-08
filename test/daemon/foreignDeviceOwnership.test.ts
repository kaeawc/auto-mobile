import { describe, expect, spyOn, test } from "bun:test";
import {
  ForwardLeaseForeignDeviceOwnership,
  type ForwardLeaseFileSource,
} from "../../src/daemon/foreignDeviceOwnership";
import { logger } from "../../src/utils/logger";

const SELF_PID = 100;

function source(holders: Record<string, number>, alive: number[]): ForwardLeaseFileSource {
  return {
    lockPath: (deviceId) => `/leases/${deviceId}.lock`,
    readOwnerPid: (path) => holders[path],
    isProcessRunning: (pid) => alive.includes(pid),
  };
}

describe("ForwardLeaseForeignDeviceOwnership", () => {
  const ownership = new ForwardLeaseForeignDeviceOwnership(
    SELF_PID,
    source(
      {
        "/leases/foreign.lock": 4242,
        "/leases/self.lock": SELF_PID,
        "/leases/dead.lock": 5151,
        "/leases/corrupt.lock": Number.NaN,
      },
      [SELF_PID, 4242],
    ),
  );

  test("reports the live PID of another process holding the lease", () => {
    expect(ownership.foreignOwnerPid("foreign")).toBe(4242);
  });

  test.each(["self", "dead", "corrupt", "unleased"])("reports no foreign owner for %s", (id) => {
    expect(ownership.foreignOwnerPid(id)).toBeUndefined();
  });

  test("logs and reports no owner when the lease path cannot be resolved", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const unresolvable = new ForwardLeaseForeignDeviceOwnership(SELF_PID, {
        ...source({}, []),
        lockPath: () => {
          throw new Error("no home directory");
        },
      });
      expect(unresolvable.foreignOwnerPid("emulator-5554")).toBeUndefined();
      expect(String(warn.mock.calls[0]?.[0])).toContain("no home directory");
    } finally {
      warn.mockRestore();
    }
  });
});
