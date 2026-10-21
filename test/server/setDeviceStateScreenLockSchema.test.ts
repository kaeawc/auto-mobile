import { describe, expect, test } from "bun:test";
import { setDeviceStateSchema } from "../../src/server/utilityTools";
import { formatToolParamError } from "../../src/utils/toolParamError";

describe("setDeviceState screenLock schema", () => {
  test.each([
    { type: "pin", credential: "1357" },
    { type: "password", credential: "a b$c-d" },
    { type: "pattern", credential: "14789" },
    { type: "none", currentCredential: "1357" },
  ])("accepts %o", (screenLock) => {
    expect(setDeviceStateSchema.safeParse({ screenLock }).success).toBe(true);
  });

  test.each([
    { type: "pin", credential: "12a4" },
    { type: "pin", credential: "123" },
    { type: "password", credential: "-starts-with-dash" },
    { type: "password", credential: "it's" },
    { type: "pattern", credential: "1123" },
    { type: "pattern", credential: "1230" },
    { type: "none" },
    { type: "pin", credential: "1357", currentCredential: "2468" },
  ])("rejects %o without echoing the value", (screenLock) => {
    const parsed = setDeviceStateSchema.safeParse({ screenLock });
    expect(parsed.success).toBe(false);
    const credential = "credential" in screenLock ? screenLock.credential : undefined;
    if (credential) {
      expect(JSON.stringify(parsed.error?.issues)).not.toContain(credential);
      const message = formatToolParamError(
        "setDeviceState",
        parsed.error,
        { screenLock },
        setDeviceStateSchema,
      );
      expect(message).not.toContain(credential);
    }
  });
});
