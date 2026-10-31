import { describe, expect, test } from "bun:test";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import type { Session } from "../../src/daemon/sessionManager";

function harness(
  options: {
    device?: string | null;
    published?: "session" | "releasing" | "has";
    failure?: "session" | "reservation" | "pool";
    reservation?: boolean;
  } = {},
) {
  const events: unknown[][] = [];
  const error = new Error("release failed");
  let released = false;
  let releases = 0;
  const session = { assignedDevice: "published-device" } as Session;
  const manager: ReturnType<DaemonStateAccess["getSessionManager"]> = {
    getSession: (id) => {
      events.push(["getSession", id]);
      return released && options.published === "session" ? session : null;
    },
    getReleasingSession: (id) => {
      events.push(["getReleasingSession", id]);
      return released && options.published === "releasing" ? session : null;
    },
    hasSession: (id) => {
      events.push(["hasSession", id]);
      return released && options.published === "has";
    },
    getDeviceLabels: () => undefined,
    releaseSession: async (...args) => {
      events.push(["session.releaseSession", ...args]);
      if (options.failure === "session") {
        throw error;
      }
      released = true;
      releases++;
      // A published branch's second release returns null: only the unknown path has d1.
      return releases === 1 ? (options.device === undefined ? "d1" : options.device) : null;
    },
  };
  const state: DaemonStateAccess = {
    isInitialized: () => true,
    getSessionManager: () => manager,
    getDeviceSessionRegistry: () => ({ list: () => [] }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      ...(options.reservation === false
        ? {}
        : {
            releaseRehydrationReservation: (id: string) => {
              events.push(["pool.releaseRehydrationReservation", id]);
              if (options.failure === "reservation") {
                throw error;
              }
            },
          }),
      releaseDevice: async (...args) => {
        events.push(["pool.releaseDevice", ...args]);
        if (options.failure === "pool") {
          throw error;
        }
      },
    }),
  };
  return {
    events,
    error,
    release: () =>
      handleDaemonRequest(
        {
          id: "r",
          type: "daemon_request",
          method: "daemon/releaseSession",
          params: { sessionId: "s1" },
        },
        state,
        {
          executions: {
            cancelDeviceSessionExecutions: async () => 0,
            cancelDeviceExecutions: async () => 0,
          },
        },
      ),
  };
}

const lookup = [
  ["getSession", "s1"],
  ["getReleasingSession", "s1"],
  ["hasSession", "s1"],
];
const release = ["session.releaseSession", "s1"];
const reservation = ["pool.releaseRehydrationReservation", "s1"];
const free = ["pool.releaseDevice", "d1", "s1"];

describe("unknown-session release caller ordering", () => {
  test.each([true, false])("reservation hook present=%s", async (present) => {
    const h = harness({ reservation: present });
    expect(await h.release()).toEqual({
      success: true,
      result: { message: "Session s1 released", device: "d1", alreadyReleased: false },
    });
    expect(h.events).toEqual([
      ...lookup,
      release,
      ...lookup,
      ...(present ? [reservation] : []),
      free,
    ]);
  });
  test("null device never releases a reservation or pool device", async () => {
    const h = harness({ device: null });
    expect(await h.release()).toEqual({
      success: true,
      result: {
        message:
          "Session s1 is not known to this daemon (never issued, or its release record expired); nothing was released",
        alreadyReleased: false,
        known: false,
      },
    });
    expect(h.events).toEqual([...lookup, release, ...lookup]);
  });
  test.each(["session", "releasing", "has"] as const)(
    "published via %s delegates to bound release without freeing the unknown device",
    async (published) => {
      const h = harness({ published });
      expect(await h.release()).toMatchObject({
        success: true,
        result: { device: null, alreadyReleased: false },
      });
      expect(h.events).toEqual([
        ...lookup,
        release,
        ["getSession", "s1"],
        ...(published === "session" ? [] : [["getReleasingSession", "s1"]]),
        ...(published === "has" ? [["hasSession", "s1"]] : []),
        release,
      ]);
    },
  );
  test.each(["session", "reservation", "pool"] as const)(
    "%s rejection stops subsequent work and propagates",
    async (failure) => {
      const h = harness({ failure });
      await expect(h.release()).rejects.toBe(h.error);
      expect(h.events).toEqual([
        ...lookup,
        release,
        ...(failure === "session" ? [] : [...lookup, reservation]),
        ...(failure === "pool" ? [free] : []),
      ]);
    },
  );
});
