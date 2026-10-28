import { describe, expect, test } from "bun:test";
import toolDefinitions from "../../../schemas/tool-definitions.json";
import {
  prototypeAuthBlockError,
  prototypeAuthCallError,
} from "../../../src/features/prototype/prototypeAuth";

const account = (id: string) => ({ id, name: `User ${id}`, email: `${id}@example.test` });
const spec = (overrides: Record<string, unknown> = {}) => ({
  requires: { platform: ["auth"] },
  auth: { provider: "fake", accounts: [account("u1"), account("u2")] },
  ...overrides,
});

describe("prototypeAuthBlockError", () => {
  test("accepts a declared block with unique account ids and ignores a spec without one", () => {
    expect(prototypeAuthBlockError(spec())).toBeUndefined();
    expect(prototypeAuthBlockError({ requires: { platform: ["auth"] } })).toBeUndefined();
  });

  test("refuses a block whose module is not in requires.platform", () => {
    expect(prototypeAuthBlockError(spec({ requires: { platform: ["battery"] } }))).toEqual({
      path: "auth",
      message: "The auth block requires auth in requires.platform",
    });
    expect(prototypeAuthBlockError(spec({ requires: undefined }))?.path).toBe("auth");
  });

  test("reports the second account that reuses an id", () => {
    const auth = { provider: "fake", accounts: [account("u1"), account("u2"), account("u1")] };
    expect(prototypeAuthBlockError(spec({ auth }))).toEqual({
      path: "auth.accounts[2].id",
      message: "Duplicate account id",
    });
  });
});

describe("prototypeAuthCallError", () => {
  test("an auth call needs the root block; other calls never do", () => {
    const signIn = { type: "platform", call: "auth.signIn" };
    expect(prototypeAuthCallError(signIn, "root.onTap[0]", { requires: {} })).toEqual({
      path: "root.onTap[0].call",
      message: "auth.signIn requires a root auth block",
    });
    expect(prototypeAuthCallError(signIn, "root.onTap[0]", spec())).toBeUndefined();
    expect(
      prototypeAuthCallError({ type: "platform", call: "haptics.perform" }, "root", {}),
    ).toBeUndefined();
  });
});

test("the advertised prototype schema inlines the auth block with no dangling $ref", () => {
  const prototype = toolDefinitions.find((tool) => tool.name === "prototype");
  const spec = (
    prototype?.inputSchema as
      | { properties?: { spec?: { properties?: Record<string, unknown> } } }
      | undefined
  )?.properties?.spec;
  const advertised = JSON.stringify(spec?.properties?.auth);
  expect(advertised).toContain('"const":"fake"');
  expect(advertised).not.toContain("$ref");
});
