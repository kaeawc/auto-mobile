import { describe, expect, test } from "bun:test";
import {
  prototypeSecureStorageEmitError,
  prototypeSecureStorageError,
} from "../../../src/features/prototype/prototypeSecureStorage";
import { prototypeStorageSchema } from "../../../src/features/prototype/prototypeStorageSchema";
import { prototypePlatformError } from "../../../src/features/prototype/prototypePlatform";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

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

describe("secure route params and platform args", () => {
  const error = (action: Record<string, unknown>, root = spec()) =>
    prototypePlatformError(root, [{ value: action, path: "root.onTap[0]" }], () => undefined);
  const binding = { state: "token" };
  const actions = [
    { type: "push", stack: "nav", screen: "detail", params: { t: binding } },
    { type: "replace", stack: "nav", screen: "detail", params: { t: binding } },
    {
      type: "setStack",
      stack: "nav",
      path: [{ screen: "home" }, { screen: "detail", params: { t: binding } }],
    },
    { type: "platform", call: "clipboard.copy", args: { text: binding } },
  ];

  for (const [index, action] of actions.entries()) {
    test(`${action.type} refuses secure state with the Kotlin message and a located path`, () => {
      expect(error(action)).toEqual({
        path: `root.onTap[0].${index === 2 ? "path[1].params.t" : index === 3 ? "args.text" : "params.t"}`,
        message: `Secure storage key state:token cannot be sent in ${index === 3 ? "platform args" : "route params"}`,
      });
    });
  }

  test("bindings are checked in sorted order with quoted member paths and repeat matching", () => {
    expect(
      error({
        type: "push",
        params: { z: binding, "a-b": { state: "tok{item.id}" } },
      }),
    ).toEqual({
      path: 'root.onTap[0].params["a-b"]',
      message: "Secure storage key state:token cannot be sent in route params",
    });
    expect(error({ type: "platform", args: { "a-b": { state: "tok{item.id}" } } })).toEqual({
      path: 'root.onTap[0].args["a-b"]',
      message: "Secure storage key state:token cannot be sent in platform args",
    });
  });

  test("public bindings, literal placeholders and specs without secure keys pass", () => {
    for (const type of ["push", "replace", "setStack", "platform"]) {
      const values = { public: { state: "remember" }, literal: { value: "{token}" } };
      expect(
        error({ type, params: values, args: values, path: [{ screen: "detail", params: values }] }),
      ).toBeUndefined();
    }
    for (const action of actions) {
      expect(error(action, spec({ storage: storage({}) }))).toBeUndefined();
    }
  });

  test("request opt-in does not permit route or platform leaks", () => {
    for (const action of actions) {
      expect(error({ ...action, allowSecureInRequest: true })).toBeDefined();
    }
  });

  test("the host validator rejects secure bindings in complete route and platform specs", () => {
    const base = {
      ...spec(),
      id: "vault",
      window: { placement: { type: "fullscreen" } },
      requires: { platform: ["secureStorage", "biometric", "clipboard"] },
    };
    for (const action of actions) {
      const platform = action.type === "platform";
      const button = { type: "button", label: "Go", onTap: [action] };
      expect(
        validatePrototypeSpec({
          ...base,
          root: platform
            ? button
            : {
                type: "stack",
                id: "nav",
                start: "home",
                screens: { home: button, detail: { type: "text", text: "Detail" } },
                routes: { detail: { params: { t: "string" } } },
              },
        }),
      ).toMatchObject({
        success: false,
        error: {
          path: `${platform ? "root" : 'root.screens["home"]'}.onTap[0].${action.type === "setStack" ? "path[1].params.t" : platform ? "args.text" : "params.t"}`,
          message: `Secure storage key state:token cannot be sent in ${platform ? "platform args" : "route params"}`,
        },
      });
    }
  });
});

describe("secure data-write values", () => {
  const error = (action: Record<string, unknown>, root = spec()) =>
    prototypePlatformError(root, [{ value: action, path: "root.onTap[0]" }], () => undefined);
  const writes = ["setData", "appendData", "upsertData", "prependData"].map((type) => ({
    type,
    path: "/data/copy",
    value: { state: "token" },
  }));

  for (const action of writes) {
    test(`${action.type} refuses a secure state value with a located path`, () => {
      expect(error(action)).toEqual({
        path: "root.onTap[0].value",
        message: "Secure storage key state:token cannot be written to data",
      });
      expect(error({ ...action, value: { state: "tok{item.id}" } })).toEqual({
        path: "root.onTap[0].value",
        message: "Secure storage key state:token cannot be written to data",
      });
    });
  }

  test("public values, literals and specs without secure keys pass; opt-in does not apply", () => {
    for (const action of writes) {
      expect(error({ ...action, value: { state: "remember" } })).toBeUndefined();
      expect(error({ ...action, value: { value: "{token}" } })).toBeUndefined();
      expect(error(action, spec({ storage: storage({}) }))).toBeUndefined();
      expect(error({ ...action, allowSecureInRequest: true })).toBeDefined();
    }
    expect(error({ type: "removeData", path: "/data/copy" })).toBeUndefined();
  });

  test("the host validator rejects a secure setData value in a complete spec", () => {
    expect(
      validatePrototypeSpec({
        ...spec(),
        id: "vault",
        window: { placement: { type: "fullscreen" } },
        data: { copy: "" },
        root: { type: "button", label: "Copy", onTap: [writes[0]] },
      }),
    ).toMatchObject({
      success: false,
      error: {
        path: "root.onTap[0].value",
        message: "Secure storage key state:token cannot be written to data",
      },
    });
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

  // Backtracking blows the per-test 100 ms unit budget on this input; the budget is the timing
  // guard, not an in-test wall clock (#18326).
  test("many placeholders against a long key stay linear", () => {
    expect(leak(`${"{row.id}".repeat(8)}z`, [`state:${"a".repeat(63)}b`])).toBeUndefined();
  });
});
