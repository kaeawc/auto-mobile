import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";
import { expect, test } from "bun:test";
import {
  formatPrototypeValue,
  resolvePrototypeDerived,
  projectPrototypeDerivedItem,
} from "../../../src/features/prototype/prototypeFormat";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { requiredPrototypeCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
const context = { locale: "en-US", timeZone: "UTC", nowMs: 1767268800000 };
const spec = (extra: Record<string, unknown> = {}) => ({
  id: "formats",
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text: "{derived:price}" },
  derive: { price: { of: { value: 1234.5 }, format: { currency: { code: "USD" } } } },
  ...extra,
});
test("formats without consulting a real clock", () => {
  expect(formatPrototypeValue({ currency: { code: "USD" } }, 1234.5, context)).toBe("$1,234.50");
  expect(formatPrototypeValue({ relative: {} }, context.nowMs - 7200000, context)).toBe(
    "2 hours ago",
  );
  expect(formatPrototypeValue({ number: {} }, "123", context)).toBeUndefined();
  expect(formatPrototypeValue({ date: {} }, "2026-02-30", context)).toBeUndefined();
});
test("resolves each source and projects repeat strings", () => {
  const source = {
    derive: {
      price: { of: { data: "/price" }, format: { number: {} } },
      state: { of: { state: "n" }, format: { number: {} } },
    },
  };
  expect(
    resolvePrototypeDerived(source, "price", {
      data: { price: 12 },
      state: { n: 3 },
      env: context,
    }),
  ).toBe("12");
  expect(resolvePrototypeDerived(source, "state", { state: { n: 3 }, env: context })).toBe("3");
  expect(resolvePrototypeDerived(source, "missing", { env: context })).toBe("");
  expect(
    projectPrototypeDerivedItem(
      { nText: { of: { item: "n" }, format: { number: {} } } },
      { n: 2 },
      context,
    ),
  ).toEqual({ n: 2, nText: "2" });
});
test("validates derived reads and gates top-level and repeat derive", () => {
  expect(validatePrototypeSpec(spec()).success).toBe(true);
  expect(requiredPrototypeCapabilities(spec())).toContain("prototype_format_v1");
  expect(validatePrototypeSpec(spec({ root: { type: "text", text: "{derived:absent}" } }))).toEqual(
    { success: false, error: { path: "root.text", message: 'Unknown derived value "absent"' } },
  );
  const repeated: Record<string, unknown> = spec();
  delete repeated.derive;
  repeated.root = {
    type: "column",
    repeat: {
      items: [{ n: 2 }],
      as: "item",
      derive: { nText: { of: { item: "n" }, format: { number: {} } } },
    },
    children: [{ type: "text", text: "{item.nText}" }],
  };
  expect(validatePrototypeSpec(repeated).success).toBe(true);
  expect(requiredPrototypeCapabilities(repeated)).toContain("prototype_format_v1");
});

test("invalid numeric inputs and unsupported Intl environments are empty", () => {
  for (const input of [undefined, null, true, NaN, Infinity, -Infinity, {}, []]) {
    expect(formatPrototypeValue({ number: {} }, input, context)).toBeUndefined();
  }
  expect(
    formatPrototypeValue({ date: {} }, 0, { ...context, timeZone: "Invalid/Zone" }),
  ).toBeUndefined();
  expect(formatPrototypeValue({ relative: {} }, 0, { ...context, nowMs: NaN })).toBeUndefined();
  expect(
    resolvePrototypeDerived(
      { derive: { x: { of: { data: "/missing" }, format: { number: {} } } } },
      "x",
      { data: {}, env: context },
    ),
  ).toBe("");
});

const directory = join(import.meta.dir, "../../fixtures/prototype-spec");
for (const name of readdirSync(join(directory, "invalid")).filter((name) =>
  name.startsWith("derive-"),
)) {
  const fixture = JSON.parse(readFileSync(join(directory, "invalid", name), "utf8"));
  test(`strict formatter fixture ${name}`, () => {
    expect(
      validatePrototypeSpec(fixture.spec, { requiredCapabilities: prototypeGateCapabilities }),
    ).toEqual({
      success: false,
      error: { path: fixture.expectedPath, message: fixture.expectedMessage },
    });
  });
}
test("the final shared spec round-trips through Zod and strict validation", () => {
  const fixture = JSON.parse(readFileSync(join(directory, "valid/derive-formatters.json"), "utf8"));
  expect(
    validatePrototypeSpec(fixture, { requiredCapabilities: prototypeGateCapabilities }).success,
  ).toBe(true);
  expect(prototypeSpecSchema.safeParse(fixture).success).toBe(true);
});

test("derived reads use the plain text scan and leave unrelated fields opaque", () => {
  const fixture = spec({
    root: {
      type: "text",
      text: "{derived:bad-name} {derived:unterminated",
      onTap: [{ type: "emit", name: "x", payload: { text: "{derived:missing}" } }],
    },
  });
  expect(validatePrototypeSpec(fixture).success).toBe(true);
});
test("repeat derived fields project for any alias and preserve source values", () => {
  const item = { amount: 12, raw: "{derived:missing}" };
  const projected = projectPrototypeDerivedItem(
    {
      price: { of: { item: "amount" }, format: { currency: { code: "USD" } } },
      missing: { of: { item: "absent" }, format: { date: {} } },
    },
    item,
    context,
  );
  expect(projected).toEqual({ ...item, price: "$12.00", missing: "" });
  expect(item).toEqual({ amount: 12, raw: "{derived:missing}" });
});
test("entry overrides determine the resolved date", () => {
  expect(
    resolvePrototypeDerived(
      {
        derive: {
          d: {
            of: { value: "2026-01-05T02:00:00Z" },
            format: { date: {} },
            locale: "en-GB",
            timeZone: "America/New_York",
          },
        },
      },
      "d",
      { env: context },
    ),
  ).toBe("4 Jan 2026");
});

test("repeat derived strings can bind emit names and state keys without a device clock during validation", () => {
  expect(
    validatePrototypeSpec(
      spec({
        derive: {},
        state: { amount_2: "" },
        root: {
          type: "column",
          repeat: {
            items: [{ n: 2 }],
            as: "row",
            derive: { nText: { of: { item: "n" }, format: { number: {} } } },
          },
          children: [
            { type: "textField", stateKey: "amount_{row.nText}" },
            { type: "button", label: "Send", onTap: [{ type: "emit", name: "{row.nText}" }] },
          ],
        },
      }),
    ).success,
  ).toBe(true);
});

test.each([
  "2026-01-05T24:00:00Z",
  "2026-01-05T24:00:00+01:00",
  "2026-01-05T23:60:00Z",
  "2026-01-05T23:59:60Z",
])("rejects out-of-range ISO time components: %s", (input) => {
  for (const format of [{ date: {} }, { time: {} }, { relative: {} }]) {
    expect(formatPrototypeValue(format, input, context)).toBeUndefined();
  }
});

test("accepts the ISO time component boundaries", () => {
  expect(formatPrototypeValue({ time: { style: "medium" } }, "2026-01-05T00:00:00Z", context)).toBe(
    "12:00:00 AM",
  );
  expect(formatPrototypeValue({ time: { style: "medium" } }, "2026-01-05T23:59:59Z", context)).toBe(
    "11:59:59 PM",
  );
});

test.each(["es-ES", "pl-PL"])("numeric grouping respects locale minimum digits: %s", (locale) => {
  const formatting = { ...context, locale };
  expect(formatPrototypeValue({ number: {} }, 1234, formatting)).toBe("1234");
  expect(formatPrototypeValue({ number: { grouping: true } }, 1234, formatting)).toBe("1234");
  expect(formatPrototypeValue({ number: { grouping: false } }, 12345, formatting)).toBe("12345");
  expect(formatPrototypeValue({ number: {} }, 12345, formatting)).not.toBe("12345");
  for (const [format, value, options] of [
    [{ compact: {} }, 1234, { notation: "compact", compactDisplay: "short" }],
    [{ currency: { code: "EUR" } }, 1234, { style: "currency", currency: "EUR" }],
    [{ percent: {} }, 12.34, { style: "percent" }],
  ] as const) {
    const expected = new Intl.NumberFormat(locale, { ...options, useGrouping: "auto" }).format(
      value,
    );
    expect(formatPrototypeValue(format, value, formatting)).toBe(expected);
  }
});
