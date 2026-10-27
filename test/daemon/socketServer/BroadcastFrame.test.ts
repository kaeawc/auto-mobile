import { describe, expect, it } from "bun:test";
import { BroadcastFrame } from "../../../src/daemon/socketServer/BroadcastFrame";

describe("BroadcastFrame", () => {
  it("builds lazily and serializes the common payload once", () => {
    let builds = 0;
    let serializations = 0;
    const payload = {
      toJSON() {
        serializations++;
        return "screenshot";
      },
    };
    const frame = new BroadcastFrame((subscriptionId) => {
      builds++;
      return { payload, subscriptionId };
    });
    expect(builds).toBe(0);
    for (const subscriptionId of ["one", 'two-"\\\n💧', "three"]) {
      expect(frame.lineFor(subscriptionId, { payload, subscriptionId })).toBe(
        JSON.stringify({ payload: "screenshot", subscriptionId }) + "\n",
      );
    }
    expect(builds).toBe(1);
    expect(serializations).toBe(1);
  });

  it("falls back when the placeholder also occurs in the payload", () => {
    const frame = new BroadcastFrame((subscriptionId) => ({
      subscriptionId,
      payload: subscriptionId,
    }));
    for (const subscriptionId of ["one", 'two-"\\\n']) {
      const message = { subscriptionId, payload: "actual payload" };
      expect(frame.lineFor(subscriptionId, message)).toBe(JSON.stringify(message) + "\n");
    }
  });

  it("falls back when the builder omits the subscription id", () => {
    const frame = new BroadcastFrame(() => ({ payload: "common" }));
    for (const subscriptionId of ["one", "two"]) {
      const message = { payload: subscriptionId };
      expect(frame.lineFor(subscriptionId, message)).toBe(JSON.stringify(message) + "\n");
    }
  });

  it("falls back when the builder does not produce serializable JSON", () => {
    const frame = new BroadcastFrame(() => undefined);
    expect(frame.lineFor("one", { value: 1 })).toBe('{"value":1}\n');
  });

  it("falls back after a builder throws and only attempts the template once", () => {
    let builds = 0;
    const frame = new BroadcastFrame(() => {
      builds++;
      throw new Error("unsupported placeholder");
    });
    for (const subscriptionId of ["one", "two"]) {
      const message = { subscriptionId };
      expect(frame.lineFor(subscriptionId, message)).toBe(JSON.stringify(message) + "\n");
    }
    expect(builds).toBe(1);
  });

  it("falls back after template serialization throws without hiding subscriber errors", () => {
    const frame = new BroadcastFrame((subscriptionId) => ({
      subscriptionId,
      payload: {
        toJSON() {
          throw new Error("template error");
        },
      },
    }));
    expect(frame.lineFor("one", { subscriptionId: "one" })).toBe('{"subscriptionId":"one"}\n');
    const message = {
      toJSON() {
        throw new Error("subscriber error");
      },
    };
    expect(() => frame.lineFor("two", message)).toThrow("subscriber error");
  });
});
