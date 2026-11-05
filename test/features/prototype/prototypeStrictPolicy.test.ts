import { describe, expect, test } from "bun:test";
import hostFixture from "../../fixtures/prototype-spec/invalid/strict-library-via-host.json";
import nestedFixture from "../../fixtures/prototype-spec/invalid/strict-library-via-host-nested.json";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeSensitiveWarnings } from "../../../src/features/prototype/prototypeStrictPolicy";

test("sensitive warnings retain each sink path and message with the warning-only suffix", () => {
  const spec = {
    id: "sensitive-warnings",
    window: { placement: { type: "fullscreen" } },
    requires: { platform: ["clipboard"] },
    root: {
      type: "column",
      children: [
        { type: "pasteButton", into: "/data/code" },
        {
          type: "button",
          label: "Send",
          onTap: [
            {
              type: "request",
              url: "https://example.com/submit",
              via: "device",
              headers: { Authorization: { data: "/code" } },
              query: { q: { data: "/code" } },
            },
          ],
        },
      ],
    },
  };
  expect(validatePrototypeSpec(spec).success).toBe(true);
  expect(prototypeSensitiveWarnings(spec)).toEqual([
    "root.children[1].onTap[0].headers.Authorization: Sensitive value cannot be bound into a request; this is a warning only and does not block the show.",
    "root.children[1].onTap[0].query.q: Sensitive value cannot be bound into a request; this is a warning only and does not block the show.",
  ]);
});

test("sensitive warnings explain when analysis stopped at the expanded-byte budget", () => {
  const spec = {
    id: "sensitive-budget",
    window: { placement: { type: "fullscreen" } },
    requires: { platform: ["clipboard"] },
    root: {
      type: "column",
      children: [
        { type: "pasteButton", into: "/data/code" },
        {
          type: "column",
          repeat: { items: Array.from({ length: 128 }, () => ({})), as: "row" },
          children: [
            {
              type: "button",
              label: "Send",
              onTap: [
                {
                  type: "request",
                  url: "https://example.com/submit",
                  via: "device",
                  query: {
                    a: "界".repeat(4096),
                    b: "界".repeat(4096),
                    q: "界".repeat(4096),
                    z: { data: "/code" },
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
  expect(validatePrototypeSpec(spec)).toMatchObject({ success: true });
  expect(prototypeSensitiveWarnings(spec)).toEqual([
    "root.children[1].children[0].onTap[0].query.q: sensitive sink analysis stopped at the 4194304 expanded-byte budget at this path, so the sinks in this spec are unchecked and no sink findings are listed; this is a warning only and does not block the show.",
  ]);
});

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
