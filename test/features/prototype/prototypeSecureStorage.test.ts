import { describe, expect, test } from "bun:test";
import {
  prototypeSecureStorageEmitError,
  prototypeSecureStorageError,
} from "../../../src/features/prototype/prototypeSecureStorage";
import { prototypeStorageSchema } from "../../../src/features/prototype/prototypeStorageSchema";

const spec = (overrides: Record<string, unknown> = {}) => ({
  requires: { platform: ["secureStorage", "biometric"] },
  state: { token: "", remember: false },
  storage: {
    version: 1,
    keys: ["state:remember"],
    secure: ["state:token"],
    secureAuth: { "state:token": "biometric" },
  },
  ...overrides,
});
const storage = (fields: Record<string, unknown>) => ({
  version: 1,
  keys: ["state:remember"],
  ...fields,
});

describe("prototypeSecureStorageError", () => {
  test("accepts declared string state keys and ignores a spec without secure keys", () => {
    expect(prototypeSecureStorageError(spec())).toBeUndefined();
    expect(prototypeSecureStorageError(spec({ storage: storage({}) }))).toBeUndefined();
  });

  test("secure keys need the secureStorage module", () => {
    expect(prototypeSecureStorageError(spec({ requires: { platform: ["biometric"] } }))).toEqual({
      path: "storage.secure",
      message: "storage.secure requires secureStorage in requires.platform",
    });
  });

  test("each secure key is a declared string state key that is not also in storage.keys", () => {
    const at = (
      secure: string[],
      state: Record<string, unknown> = { token: "", remember: false },
    ) => prototypeSecureStorageError(spec({ state, storage: storage({ secure }) }));
    expect(at(["data:/token"])?.path).toBe("storage.secure[0]");
    expect(at(["state:token", "state:missing"])).toEqual({
      path: "storage.secure[1]",
      message: "Secure storage key state:missing is not declared in state",
    });
    expect(at(["state:token"], { token: 0, remember: false })).toEqual({
      path: "storage.secure[0]",
      message: "Secure storage keys must hold a string state value",
    });
    expect(at(["state:remember"], { token: "", remember: "" })).toEqual({
      path: "storage.secure[0]",
      message: "Secure storage key state:remember is also listed in storage.keys",
    });
  });

  test("secureAuth names a secure key and needs the biometric module", () => {
    const auth = (secureAuth: Record<string, string>, platform = ["secureStorage", "biometric"]) =>
      prototypeSecureStorageError(
        spec({
          requires: { platform },
          storage: storage({ secure: ["state:token"], secureAuth }),
        }),
      );
    expect(auth({ "state:remember": "biometric" })).toEqual({
      path: 'storage.secureAuth["state:remember"]',
      message: "secureAuth names a key that is not in storage.secure",
    });
    expect(auth({ "state:token": "biometric" }, ["secureStorage"])).toEqual({
      path: 'storage.secureAuth["state:token"]',
      message: "Biometric secure keys require biometric in requires.platform",
    });
  });
});

describe("secureAuth without storage.secure", () => {
  test("a secureAuth entry is still checked when storage.secure is absent", () => {
    expect(
      prototypeSecureStorageError(
        spec({ storage: storage({ secureAuth: { "state:remember": "biometric" } }) }),
      ),
    ).toEqual({
      path: 'storage.secureAuth["state:remember"]',
      message: "secureAuth names a key that is not in storage.secure",
    });
  });
});

describe("prototypeSecureStorageEmitError", () => {
  test("an emit context cannot carry a secure key; other bindings pass", () => {
    const emit = (context: Record<string, unknown>) => ({ type: "emit", name: "save", context });
    expect(
      prototypeSecureStorageEmitError(emit({ t: { state: "token" } }), "root.onTap[0]", spec()),
    ).toEqual({
      path: "root.onTap[0].context.t",
      message: "Secure storage key state:token cannot be sent in an emit context",
    });
    expect(
      prototypeSecureStorageEmitError(emit({ r: { state: "remember" } }), "root.onTap[0]", spec()),
    ).toBeUndefined();
    expect(
      prototypeSecureStorageEmitError(
        emit({ t: { state: "tok{item.id}" } }),
        "root.onTap[0]",
        spec(),
      ),
    ).toEqual({
      path: "root.onTap[0].context.t",
      message: "Secure storage key state:token cannot be sent in an emit context",
    });
    expect(
      prototypeSecureStorageEmitError(
        emit({ t: { state: "x{item.id}" } }),
        "root.onTap[0]",
        spec(),
      ),
    ).toBeUndefined();
    expect(
      prototypeSecureStorageEmitError(
        emit({ t: { state: "token" } }),
        "root.onTap[0]",
        spec({ storage: storage({}) }),
      ),
    ).toBeUndefined();
  });
});

describe("prototypeStorageSchema secure fields", () => {
  test("accepts secure keys and biometric binding and bounds them", () => {
    expect(prototypeStorageSchema.safeParse(spec().storage).success).toBe(true);
    const many = Array.from({ length: 9 }, (_, index) => `state:k${index}`);
    expect(prototypeStorageSchema.safeParse(storage({ secure: many })).success).toBe(false);
    expect(prototypeStorageSchema.safeParse(storage({ secure: [] })).success).toBe(false);
    expect(
      prototypeStorageSchema.safeParse(
        storage({ secure: ["state:a"], secureAuth: { "state:a": "pin" } }),
      ).success,
    ).toBe(false);
  });
});

describe("secure key template matching", () => {
  const leak = (stateKey: string, secure: string[]) =>
    prototypeSecureStorageEmitError(
      { type: "emit", name: "save", context: { t: { state: stateKey } } },
      "root.onTap[0]",
      { storage: { version: 1, keys: [], secure } },
    )?.message;

  test("placeholders stand for any text, literals must appear in order and in place", () => {
    expect(leak("a{x}c{y}e", ["state:abcde"])).toContain("state:abcde");
    expect(leak("{x}", ["state:token"])).toContain("state:token");
    expect(leak("ab{x}ba", ["state:aba"])).toBeUndefined();
    expect(leak("a{x}c{y}e", ["state:abxde"])).toBeUndefined();
    expect(leak("tok{x}", ["state:mytoken"])).toBeUndefined();
  });

  test("many placeholders against a long key stay linear", () => {
    const started = performance.now();
    expect(leak(`${"{row.id}".repeat(8)}z`, [`state:${"a".repeat(63)}b`])).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(50);
  });
});
