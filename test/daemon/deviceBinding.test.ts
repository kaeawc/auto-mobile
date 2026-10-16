import { describe, expect, test } from "bun:test";
import {
  bindDevice,
  clearDeviceError,
  holderOf,
  statusOf,
  snapshotBinding,
  markDeviceError,
  restoreBinding,
  unbindDevice,
  type BindingFields,
} from "../../src/daemon/deviceBinding";
import { SeededRandom } from "../fakes/SeededRandom";

describe("device binding owner", () => {
  test("holderOf accepts only the holder field and preserves null or an empty id", () => {
    expect(holderOf({ sessionId: null })).toBeNull();
    expect(holderOf({ sessionId: "owner" })).toBe("owner");
    expect(holderOf({ sessionId: "" })).toBe("");
  });

  test("bind clears a health error and leaves unrelated bookkeeping intact", () => {
    const device = {
      sessionId: null,
      status: "busy",
      health: "error",
      assignmentCount: 7,
    } satisfies BindingFields & {
      assignmentCount: number;
    };
    bindDevice(device, "owner");
    expect(statusOf(device)).toBe("busy");
    expect(device).toEqual({
      sessionId: "owner",
      status: "busy",
      health: "ok",
      assignmentCount: 7,
    });
    bindDevice(device, "next");
    expect(holderOf(device)).toBe("next");
  });

  test("unbind defaults to idle, including an already unbound error", () => {
    const device: BindingFields = { sessionId: "owner", status: "busy", health: "error" };
    expect(unbindDevice(device)).toBe(true);
    expect(statusOf(device)).toBe("idle");
    expect(device).toEqual({ sessionId: null, status: "idle", health: "ok" });
    markDeviceError(device);
    expect(unbindDevice(device, { status: "idle" })).toBe(true);
    expect(device).toEqual({ sessionId: null, status: "idle", health: "ok" });
  });

  test("expected holder mismatch, including null, changes nothing", () => {
    const device: BindingFields = { sessionId: "owner", status: "busy", health: "error" };
    expect(unbindDevice(device, { expectedSessionId: "stale" })).toBe(false);
    expect(unbindDevice(device, { expectedSessionId: null, status: "keep" })).toBe(false);
    expect(device).toEqual({ sessionId: "owner", status: "busy", health: "error" });
    expect(unbindDevice(device, { expectedSessionId: "owner" })).toBe(true);
    expect(unbindDevice(device, { expectedSessionId: "owner" })).toBe(false);
    expect(unbindDevice(device, { expectedSessionId: null })).toBe(true);
    expect(device).toEqual({ sessionId: null, status: "idle", health: "ok" });
  });

  test.each(["idle", "busy", "error"] as const)("keep preserves %s on detach", (status) => {
    const fields: BindingFields = {
      sessionId: "owner",
      status: status === "error" ? "busy" : status,
      health: status === "error" ? "error" : "ok",
    };
    const device = { ...fields };
    expect(unbindDevice(device, { expectedSessionId: "owner", status: "keep" })).toBe(true);
    expect(statusOf(device)).toBe(status);
    expect(device).toEqual({ ...fields, sessionId: null });
  });

  test.each(["idle", "busy"] as const)(
    "keep preserves raw %s with absent or error health",
    (status) => {
      for (const health of [undefined, "error"] as const) {
        const device: BindingFields = { sessionId: "owner", status, health };
        const before = statusOf(device);
        expect(unbindDevice(device, { status: "keep" })).toBe(true);
        expect(statusOf(device)).toBe(before);
        expect(device).toEqual({ sessionId: null, status, health });
      }
    },
  );

  test("rollback restores binding and health verbatim, including legacy intermediate tuples", () => {
    const device: BindingFields = { sessionId: "new", status: "busy" };
    const snapshot: BindingFields = { sessionId: "old", status: "busy", health: "error" };
    restoreBinding(device, snapshot);
    expect(statusOf(device)).toBe("error");
    expect(snapshotBinding(device)).toEqual(snapshot);
    expect(device).toEqual(snapshot);
    restoreBinding(device, { sessionId: null, status: "busy" });
    expect(statusOf(device)).toBe("busy");
    expect(device.status).toBe("busy");
    expect(device.health).toBeUndefined();
    expect(snapshot).toEqual({ sessionId: "old", status: "busy", health: "error" });
  });

  test.each([null, "owner"])("health verdicts preserve holder %s", (sessionId) => {
    const device: BindingFields = { sessionId, status: "busy" };
    markDeviceError(device);
    expect(statusOf(device)).toBe("error");
    expect(device).toEqual({ sessionId, status: "busy", health: "error" });
    clearDeviceError(device);
    expect(statusOf(device)).toBe("idle");
    expect(device).toEqual({ sessionId, status: "idle", health: "ok" });
  });

  test.each([1, 7, 23, 11802, 0xdeadbeef])("seed %s interleaves binding and rollback", (seed) => {
    const random = new SeededRandom(seed);
    const device: BindingFields = { sessionId: null, status: "idle" };
    let model: { holder: string | null; errored: boolean } = { holder: null, errored: false };
    const history = [{ fields: { ...device }, model: { ...model } }];
    for (let step = 0; step < 256; step++) {
      switch (random.pick(["bind", "unbind", "error", "restore"] as const)) {
        case "bind": {
          const id = `owner-${step}`;
          bindDevice(device, id);
          model = { holder: id, errored: false };
          break;
        }
        case "unbind":
          unbindDevice(device);
          model = { holder: null, errored: false };
          break;
        case "error":
          markDeviceError(device);
          model.errored = true;
          break;
        case "restore": {
          const snapshot = random.pick(history);
          restoreBinding(device, snapshot.fields);
          model = { ...snapshot.model };
          break;
        }
      }
      // The sessionId-only "keep" detach and health-only clear have intentional
      // intermediate tuples; their verbatim contracts are covered above.
      expect(statusOf(device) === "busy").toBe(model.holder !== null && !model.errored);
      expect(holderOf(device)).toBe(model.holder);
      expect(statusOf(device) === "error").toBe(model.errored);
      history.push({ fields: { ...device }, model: { ...model } });
    }
  });
});
