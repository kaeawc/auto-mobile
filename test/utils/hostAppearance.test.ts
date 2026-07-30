import { describe, expect, test } from "bun:test";
import { detectHostAppearance } from "../../src/utils/hostAppearance";
import type { HostDefaultsClient } from "../../src/utils/HostDefaultsClient";

function fakeHostDefaults(supported: boolean, value: string | null): HostDefaultsClient {
  return {
    isSupported: () => supported,
    readGlobal: async () => value,
  };
}

describe("detectHostAppearance", () => {
  test("resolves dark when the injected host client reports Dark", async () => {
    expect(await detectHostAppearance(fakeHostDefaults(true, "Dark"))).toBe("dark");
  });

  test("resolves light when the value is unset (null) on a supported host", async () => {
    expect(await detectHostAppearance(fakeHostDefaults(true, null))).toBe("light");
  });

  test("resolves light for any non-dark value", async () => {
    expect(await detectHostAppearance(fakeHostDefaults(true, "Light"))).toBe("light");
  });
});
