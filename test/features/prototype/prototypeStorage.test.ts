import { describe, expect, test } from "bun:test";
import contract from "../../../schemas/prototype-spec-contract.json";
import { PROTOTYPE_STORAGE_CAPABILITY } from "../../../src/features/observe/android/ctrlProxyProtocol";
import { prototypeRequiredCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { renderPrototypeGuide } from "../../../src/features/prototype/prototypeGuide";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";
import {
  MAX_PROTOTYPE_STORAGE_BYTES,
  MAX_PROTOTYPE_STORAGE_KEYS,
  parsePrototypeStorageKey,
  parsePrototypeStorageReport,
  prototypeClearStorageUnsupportedMessage,
  prototypeStorageUnsupportedMessage,
} from "../../../src/features/prototype/prototypeStorage";
import { restorePrototypeStorage } from "../../../src/features/prototype/prototypeStorageRestore";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

function spec(storage: unknown, extra: Record<string, unknown> = {}) {
  // JSON round trip: an `undefined` override omits the field, as a parsed spec would.
  return JSON.parse(
    JSON.stringify({
      id: "shop",
      window: { placement: { type: "fullscreen" } },
      state: { darkMode: false, name: "Ada", count: 1 },
      data: { cart: [], profile: { name: "Ada" } },
      root: { type: "text", text: "Hi" },
      storage,
      ...extra,
    }),
  );
}
function rejection(candidate: unknown) {
  const result = validatePrototypeSpec(candidate);
  expect(result.success).toBe(false);
  return result.success ? undefined : result.error;
}
const valid = { version: 1, keys: ["state:darkMode", "data:/cart"] };

describe("storage block schema and validation", () => {
  test("a storage block with declared state keys and /data pointers is accepted", () => {
    const result = validatePrototypeSpec(spec(valid));
    expect(result.success).toBe(true);
    expect(prototypeSpecSchema.safeParse(spec(valid)).success).toBe(true);
    expect(validatePrototypeSpec(spec(undefined, { storage: undefined })).success).toBe(true);
  });

  test("the contract and the capability constant carry the limits", () => {
    expect(contract.limits.MAX_PROTOTYPE_STORAGE_BYTES).toBe(262144);
    expect(contract.limits.MAX_PROTOTYPE_STORAGE_KEYS).toBe(64);
    expect(MAX_PROTOTYPE_STORAGE_BYTES).toBe(262144);
    expect(MAX_PROTOTYPE_STORAGE_KEYS).toBe(64);
    expect(PROTOTYPE_STORAGE_CAPABILITY).toBe("prototype_storage_v1");
    expect(Object.keys(contract.definitions.spec.fields)).toContain("storage");
  });

  test("the block is strict: shape, version and key list are checked", () => {
    for (const storage of [
      {},
      { version: 1 },
      { keys: ["state:darkMode"] },
      { version: 0, keys: ["state:darkMode"] },
      { version: 1.5, keys: ["state:darkMode"] },
      { version: 1, keys: [] },
      { version: 1, keys: "state:darkMode" },
      { version: 1, keys: [3] },
      { version: 1, keys: ["state:darkMode"], extra: true },
      null,
    ]) {
      expect(rejection(spec(storage))?.path).toStartWith("storage");
    }
  });

  test("a state: key must be declared in state", () => {
    expect(rejection(spec({ version: 1, keys: ["state:missing"] }))).toEqual({
      path: "storage.keys[0]",
      message: "Storage key state:missing is not declared in state",
    });
    expect(
      rejection(spec({ version: 1, keys: ["state:darkMode"] }, { state: undefined }))?.path,
    ).toBe("storage.keys[0]");
    expect(rejection(spec({ version: 1, keys: ["state:darkMode", "state:bad key"] }))?.path).toBe(
      "storage.keys[1]",
    );
  });

  test("a data: pointer must be a nonempty pointer under /data", () => {
    for (const key of ["data:", "data:cart", "data:cart/items", "data:~", "other:/cart", "state"]) {
      const error = rejection(spec({ version: 1, keys: ["state:darkMode", key] }));
      expect(error?.path).toBe("storage.keys[1]");
      expect(error?.message).toContain("state:<key> or data:<pointer under /data");
    }
    expect(parsePrototypeStorageKey("data:/cart/0/qty")).toEqual({
      kind: "data",
      pointer: "/cart/0/qty",
    });
    expect(parsePrototypeStorageKey("data:/a~1b")).toEqual({ kind: "data", pointer: "/a~1b" });
    expect(parsePrototypeStorageKey("data:/data")).toEqual({ kind: "data", pointer: "/data" });
    expect(parsePrototypeStorageKey(7)).toBeUndefined();
  });

  test("a pointer not in the spec's data is allowed: a data action may create it first", () => {
    expect(validatePrototypeSpec(spec({ version: 1, keys: ["data:/later"] })).success).toBe(true);
  });

  test("duplicate keys are rejected", () => {
    expect(rejection(spec({ version: 1, keys: ["state:darkMode", "state:darkMode"] }))).toEqual({
      path: "storage.keys[1]",
      message: "Duplicate array value",
    });
  });

  test("overlapping data pointers are rejected, siblings are not", () => {
    expect(
      rejection(spec({ version: 1, keys: ["data:/cart", "data:/cart/0"] }))?.message,
    ).toContain("overlaps storage.keys[0]");
    expect(
      rejection(spec({ version: 1, keys: ["data:/profile/name", "data:/profile"] }))?.path,
    ).toBe("storage.keys[1]");
    expect(
      validatePrototypeSpec(spec({ version: 1, keys: ["data:/cart", "data:/cartridge"] })).success,
    ).toBe(true);
  });

  test("the key count is limited", () => {
    const keys = (count: number) => Array.from({ length: count }, (_, i) => `data:/k${i}`);
    expect(validatePrototypeSpec(spec({ version: 1, keys: keys(64) })).success).toBe(true);
    expect(rejection(spec({ version: 1, keys: keys(65) }))).toEqual({
      path: "storage.keys",
      message: "Array length out of range",
    });
  });

  test("the values the spec holds for listed keys are limited to MAX_PROTOTYPE_STORAGE_BYTES", () => {
    // Data already has the same byte limit, so state is what can push stored bytes over it.
    const big = (length: number) => ({ darkMode: false, big: "x".repeat(length) });
    const keys = { version: 1, keys: ["state:big"] };
    expect(rejection(spec(keys, { state: big(MAX_PROTOTYPE_STORAGE_BYTES) }))).toEqual({
      path: "storage.keys",
      message: "Storage byte limit exceeded",
    });
    // The key's own bytes count: "state:big" is 9 bytes, plus the two JSON quotes around the value.
    const fits = MAX_PROTOTYPE_STORAGE_BYTES - 11;
    expect(validatePrototypeSpec(spec(keys, { state: big(fits) })).success).toBe(true);
    expect(rejection(spec(keys, { state: big(fits + 1) }))?.path).toBe("storage.keys");
    // Values of keys that are not listed do not count.
    expect(
      validatePrototypeSpec(
        spec({ version: 1, keys: ["state:darkMode"] }, { state: big(MAX_PROTOTYPE_STORAGE_BYTES) }),
      ).success,
    ).toBe(true);
  });
});

describe("storage capability gate", () => {
  test("a spec with storage requires prototype_storage_v1 on both platforms", () => {
    const required = prototypeRequiredCapabilities(spec(valid)).filter(
      (gate) => gate.capability === PROTOTYPE_STORAGE_CAPABILITY,
    );
    expect(required).toHaveLength(1);
    expect(required[0].fields).toEqual(["storage"]);
    for (const platform of ["android", "ios"] as const) {
      const message = required[0].unsupportedMessage(required[0].fields, platform);
      expect(message).toContain(PROTOTYPE_STORAGE_CAPABILITY);
      expect(message).toContain("Nothing was shown or patched");
    }
    expect(
      prototypeRequiredCapabilities(spec(undefined)).map((gate) => gate.capability),
    ).not.toContain(PROTOTYPE_STORAGE_CAPABILITY);
  });

  test("the refusal messages say how to update each platform", () => {
    expect(prototypeStorageUnsupportedMessage(["storage"], "ios")).toContain(
      "launchApp prototype: true",
    );
    expect(prototypeStorageUnsupportedMessage(["storage"], "android")).toContain("CtrlProxy");
    expect(prototypeClearStorageUnsupportedMessage("android")).toContain(
      "does not advertise prototype_storage_v1",
    );
    expect(prototypeClearStorageUnsupportedMessage("ios")).toContain("launchApp prototype: true");
  });
});

describe("device storage report", () => {
  const report = {
    version: 3,
    keys: [{ key: "state:darkMode", bytes: 20 }],
    totalBytes: 20,
  };
  test("a well-formed report is passed through", () => {
    expect(parsePrototypeStorageReport(report)).toEqual(report);
    expect(parsePrototypeStorageReport({ ...report, skippedKeys: ["data:/cart"] })).toEqual({
      ...report,
      skippedKeys: ["data:/cart"],
    });
    expect(parsePrototypeStorageReport({ ...report, skippedKeys: [] })).toEqual(report);
    expect(parsePrototypeStorageReport({ ...report, keys: [], totalBytes: 0 })?.keys).toEqual([]);
  });
  test("anything malformed or absent is reported absent", () => {
    for (const value of [
      undefined,
      null,
      "x",
      {},
      { ...report, version: 0 },
      { ...report, totalBytes: -1 },
      { ...report, totalBytes: 1.5 },
      { ...report, keys: [{ key: "nope", bytes: 1 }] },
      { ...report, keys: [{ key: "state:darkMode", bytes: "1" }] },
      { ...report, keys: "state:darkMode" },
      { ...report, skippedKeys: ["nope"] },
    ]) {
      expect(parsePrototypeStorageReport(value)).toBeUndefined();
    }
  });
});

describe("restore precedence (adopted decision)", () => {
  const base = {
    state: { darkMode: false, name: "Ada" },
    data: { cart: ["a"], profile: { name: "Ada" } },
    storage: { version: 1, keys: ["state:darkMode", "state:name", "data:/cart", "data:/profile"] },
  };

  test("with nothing stored the spec's values stand", () => {
    const restored = restorePrototypeStorage(base, undefined);
    expect(restored).toEqual({ state: base.state, data: base.data, applied: [], dropped: [] });
  });

  test("stored values replace the spec's for listed keys, and only those", () => {
    const restored = restorePrototypeStorage(base, {
      version: 1,
      values: { "state:darkMode": true, "data:/cart": ["a", "b"] },
    });
    expect(restored.state).toEqual({ darkMode: true, name: "Ada" });
    expect(restored.data).toEqual({ cart: ["a", "b"], profile: { name: "Ada" } });
    expect(restored.applied).toEqual(["state:darkMode", "data:/cart"]);
    expect(restored.dropped).toEqual([]);
    expect(base.data.cart).toEqual(["a"]);
  });

  test("a changed storage.version discards every stored value", () => {
    const restored = restorePrototypeStorage(
      { ...base, storage: { ...base.storage, version: 2 } },
      { version: 1, values: { "state:darkMode": true, "data:/cart": [] } },
    );
    expect(restored.state).toEqual(base.state);
    expect(restored.data).toEqual(base.data);
    expect(restored.dropped).toEqual([
      { key: "state:darkMode", reason: "version" },
      { key: "data:/cart", reason: "version" },
    ]);
  });

  test("a stored key the spec no longer lists is dropped", () => {
    const restored = restorePrototypeStorage(
      { ...base, storage: { version: 1, keys: ["state:darkMode"] } },
      { version: 1, values: { "state:darkMode": true, "state:name": "Bob", "data:/cart": [] } },
    );
    expect(restored.state).toEqual({ darkMode: true, name: "Ada" });
    expect(restored.dropped).toEqual([
      { key: "state:name", reason: "unlisted" },
      { key: "data:/cart", reason: "unlisted" },
    ]);
  });

  test("a spec without a storage block drops every stored value", () => {
    const restored = restorePrototypeStorage(
      { ...base, storage: undefined },
      {
        version: 1,
        values: { "state:darkMode": true },
      },
    );
    expect(restored.state).toEqual(base.state);
    expect(restored.dropped).toEqual([{ key: "state:darkMode", reason: "unlisted" }]);
  });

  test("a stored value that no longer fits the spec falls back to the spec's value", () => {
    const restored = restorePrototypeStorage(base, {
      version: 1,
      values: {
        "state:darkMode": "yes",
        "state:name": 3,
        "data:/cart": { not: "an array" },
        "data:/profile": { name: "Bob" },
      },
    });
    expect(restored.state).toEqual(base.state);
    expect(restored.data).toEqual({ cart: ["a"], profile: { name: "Bob" } });
    expect(restored.applied).toEqual(["data:/profile"]);
    expect(restored.dropped).toEqual([
      { key: "state:darkMode", reason: "mismatch" },
      { key: "state:name", reason: "mismatch" },
      { key: "data:/cart", reason: "mismatch" },
    ]);
  });

  test("a state key the spec no longer declares, and an unwritable data pointer, are dropped", () => {
    const restored = restorePrototypeStorage(
      {
        state: {},
        data: {},
        storage: { version: 1, keys: ["state:gone", "data:/a/b", "data:/c"] },
      },
      { version: 1, values: { "state:gone": 1, "data:/a/b": 1, "data:/c": null } },
    );
    expect(restored.applied).toEqual([]);
    expect(restored.dropped.map((entry) => entry.reason)).toEqual([
      "mismatch",
      "mismatch",
      "mismatch",
    ]);
  });

  test("a data value the spec does not define yet is accepted when its parent exists", () => {
    const restored = restorePrototypeStorage(
      { state: {}, data: {}, storage: { version: 1, keys: ["data:/later"] } },
      { version: 1, values: { "data:/later": [1] } },
    );
    expect(restored.data).toEqual({ later: [1] });
  });
});

describe("storage in the guide", () => {
  test("the guide documents the precedence, the limits, clearStorage and the capability", () => {
    const guide = renderPrototypeGuide();
    for (const text of [
      "prototype_storage_v1",
      "MAX_PROTOTYPE_STORAGE_BYTES",
      "MAX_PROTOTYPE_STORAGE_KEYS",
      "storage.version",
      "clearStorage",
      "deleteSaved",
      "baseRevision",
    ]) {
      expect(guide).toContain(text);
    }
  });
});
