import { describe, expect, test } from "bun:test";
import hostFixture from "../../fixtures/prototype-spec/invalid/strict-library-via-host.json";
import nestedFixture from "../../fixtures/prototype-spec/invalid/strict-library-via-host-nested.json";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

describe("library request policy", () => {
  test.each([hostFixture, nestedFixture])("rejects host requests at $expectedPath", (fixture) => {
    expect(validatePrototypeSpec(fixture.spec, fixture.options)).toEqual({
      success: false,
      error: { path: fixture.expectedPath, message: fixture.expectedMessage },
    });
    expect(validatePrototypeSpec(fixture.spec).success).toBe(true);
    expect(validatePrototypeSpec(fixture.spec, { library: false }).success).toBe(true);
  });

  test.each([undefined, "device"])("accepts %s transport and opaque host-shaped JSON", (via) => {
    const opaque = { type: "request", via: "host" };
    const spec = {
      ...hostFixture.spec,
      data: { opaque },
      root: {
        ...hostFixture.spec.root,
        onTap: [
          {
            type: "request",
            method: "POST",
            url: "https://example.com",
            ...(via === undefined ? {} : { via }),
            body: { value: opaque },
            onSuccess: [{ type: "emit", name: "done", payload: opaque }],
          },
        ],
      },
    };
    expect(validatePrototypeSpec(spec, { library: true }).success).toBe(true);
  });
});
