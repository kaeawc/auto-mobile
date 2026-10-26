import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import contract from "../../../schemas/prototype-spec-contract.json";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import {
  prototypeLazyListFields,
  prototypeLazyListUnsupportedMessage,
} from "../../../src/features/prototype/prototypeLazyList";
import { repeatErrors } from "../../../src/features/prototype/prototypeRepeat";
const directory = join(import.meta.dir, "../../fixtures/prototype-spec");
const list = (extra: Record<string, unknown> = {}) => ({
  type: "list",
  repeat: { items: { path: "/rows" }, as: "row", key: "id" },
  children: [{ type: "text", text: "{row.id}" }],
  ...extra,
});
const spec = (root: unknown = list(), count = 2) => ({
  id: "list",
  window: { placement: { type: "fullscreen" } },
  data: { rows: Array.from({ length: count }, (_, id) => ({ id })) },
  root,
});
for (const kind of ["valid", "invalid"]) {
  for (const name of readdirSync(join(directory, kind)).filter(
    (name) => name.startsWith("list-") && !name.startsWith("list-item-"),
  )) {
    const fixture: { spec?: unknown; expectedPath?: string; expectedMessage?: string } = JSON.parse(
      readFileSync(join(directory, kind, name), "utf8"),
    );
    test(`${kind} ${name}`, () => {
      const candidate = kind === "valid" ? fixture : fixture.spec;
      const result = validatePrototypeSpec(candidate);
      if (kind === "valid") {
        expect(result.success).toBe(true);
        expect(prototypeSpecSchema.safeParse(candidate).success).toBe(true);
      } else {
        const { expectedPath, expectedMessage } = fixture;
        if (typeof expectedPath !== "string" || typeof expectedMessage !== "string") {
          throw new Error(`Missing expected error in ${name}`);
        }
        expect(result).toEqual({
          success: false,
          error: { path: expectedPath, message: expectedMessage },
        });
      }
    });
  }
}
test("rows at the list limit count the row template once toward nodes and images, even when empty", () => {
  const image = { type: "image", asset: "photo" };
  for (const count of [0, contract.limits.MAX_PROTOTYPE_LIST_ITEMS]) {
    expect(
      repeatErrors(
        spec(
          list({
            children: [{ type: "column", children: Array.from({ length: 20 }, () => image) }],
            header: image,
            footer: image,
          }),
          count,
        ),
      ),
    ).toBeUndefined();
  }
  expect(
    repeatErrors(
      spec(
        list({
          children: [{ type: "column", children: Array.from({ length: 31 }, () => image) }],
          header: image,
          footer: image,
        }),
        0,
      ),
    ),
  ).toMatchObject({ message: "Expanded image limit exceeded" });
});
test("headers and footers bind without the row repeat scope", () => {
  expect(
    validatePrototypeSpec(
      spec(
        list({
          header: { type: "text", text: "{row.missing}" },
          footer: { type: "text", text: "{data:/rows/0/id}" },
        }),
        500,
      ),
    ).success,
  ).toBe(true);
});
test("cross-axis scroll nesting is valid in either direction", () => {
  expect(
    validatePrototypeSpec(spec({ type: "scroll", axis: "horizontal", child: list() })).success,
  ).toBe(true);
  expect(
    validatePrototypeSpec(
      spec(list({ header: { type: "scroll", axis: "horizontal", child: { type: "spacer" } } })),
    ).success,
  ).toBe(true);
});
test("list in a component-expanded repeat reports the authored location", () => {
  const candidate = {
    ...spec({
      type: "column",
      repeat: { items: [{ id: 1 }], as: "item" },
      children: [{ type: "use", component: "Feed" }],
    }),
    components: { Feed: { root: list() } },
  };
  expect(validatePrototypeSpec(candidate)).toMatchObject({
    success: false,
    error: {
      path: "root.children[0] (use Feed) → components.Feed.root",
      message: "A list cannot sit inside a repeat template",
    },
  });
});
test("rows keep per-item field and state-key checks", () => {
  expect(
    validatePrototypeSpec({
      ...spec(list({ children: [{ type: "switch", stateKey: "row{index}" }] })),
      state: { row0: true },
    }),
  ).toMatchObject({ success: false });
  expect(
    validatePrototypeSpec(spec(list({ children: [{ type: "text", text: "{row.missing}" }] }))),
  ).toMatchObject({
    success: false,
    error: { path: "root.children[0].text", message: 'Unknown repeat field "missing"' },
  });
});
test("list gate follows request callbacks and components while ignoring payloads", () => {
  const request = {
    type: "request",
    url: "http://localhost/feed",
    append: { from: "/items", to: "/data/rows" },
  };
  const candidate = {
    ...spec(
      list({
        onEndReached: [{ type: "request", url: "http://localhost/feed", onError: [request] }],
        onTap: [{ type: "emit", name: "opaque", payload: request }],
      }),
    ),
    components: { Feed: { root: { type: "text", text: "Feed", onTap: [request] } } },
  };
  expect(prototypeLazyListFields(candidate)).toEqual([
    "root",
    "root.onEndReached[0].onError[0].append",
    "components.Feed.root.onTap[0].append",
  ]);
  expect(prototypeGateCapabilities(candidate)).toContain("prototype_lazy_list_v1");
  expect(prototypeGateCapabilities({ root: { type: "spacer", onTap: [request] } })).toContain(
    "prototype_data_model_v1",
  );
  expect(prototypeLazyListUnsupportedMessage(["root", "other"], "ios")).toContain(
    "lazy list at root (and 1 more)",
  );
});
