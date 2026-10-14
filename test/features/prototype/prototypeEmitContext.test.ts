import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveEmitContext,
  prototypeEmitContextFields,
} from "../../../src/features/prototype/prototypeEmitContext";
import {
  bindNodeFields,
  record,
  type Raw,
} from "../../../src/features/prototype/prototypeTemplate";
import {
  PrototypeRepeatData,
  prototypeDataModelFields,
} from "../../../src/features/prototype/prototypeData";
import type {
  PrototypeEmitContextBinding,
  PrototypeJson,
} from "../../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { decodePrototypeEvent } from "../../../src/features/observe/android/CtrlProxyPrototypes";
import { event } from "../../helpers/prototypeTestEvent";
import { prototypeOutputSchema } from "../../../src/server/prototypeTools";
import { renderPrototypeGuide } from "../../../src/features/prototype/prototypeGuide";

interface Fixture {
  name: string;
  spec: { root: Raw; data?: PrototypeJson };
  state: Record<string, PrototypeJson>;
  pages: Record<string, number>;
  data: PrototypeJson;
  precedingActions: { type: "setState"; key: string; value: PrototypeJson }[];
  repeatIndex?: number;
  expected: { context: Record<string, PrototypeJson>; contextTruncated?: true };
}
const directory = join(import.meta.dir, "../../fixtures/prototype-spec/emit-context/resolve");
const fixtures = readdirSync(directory)
  .sort()
  .map((file) => JSON.parse(readFileSync(join(directory, file), "utf8")) as Fixture);
beforeAll(() => {
  validatePrototypeSpec(fixtures[0].spec);
  prototypeOutputSchema.parse({ success: true, event: { ...event(1), context: { id: 3 } } });
});
describe("emit context reference fixtures", () => {
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      const state = { ...fixture.state };
      for (const action of fixture.precedingActions) {
        state[action.key] = action.value;
      }
      let node = fixture.spec.root;
      if (fixture.repeatIndex !== undefined) {
        const repeat = record(node.repeat)!;
        const source = record(repeat.items);
        const items = source
          ? new PrototypeRepeatData(fixture.data).items(String(source.path))
          : (repeat.items as Raw[]);
        node = bindNodeFields((node.children as Raw[])[0], "root.children[0]", {
          binding: { alias: String(repeat.as), index: true },
          values: items[fixture.repeatIndex],
          index: fixture.repeatIndex,
        });
      } else if (node.type === "pager") {
        node = (node.children as Raw[])[0];
      }
      const action = (node.onTap as Raw[])[0];
      const bindings = action.context as Record<
        string,
        Exclude<PrototypeEmitContextBinding, { item: string } | { index: true }>
      >;
      expect(
        resolveEmitContext(bindings, { state, pages: fixture.pages, data: fixture.data }),
      ).toEqual(fixture.expected);
      const authored =
        fixture.spec.root.type === "column" || fixture.spec.root.type === "pager"
          ? (fixture.spec.root.children as Raw[])[0]
          : fixture.spec.root;
      expect(action.payload).toEqual((authored.onTap as Raw[])[0].payload);
    });
  }
});

test("context discovery includes empty contexts and nested part actions, excludes literal payloads", () => {
  const spec = {
    root: {
      type: "column",
      children: [
        { type: "text", text: "a", onTap: [{ type: "emit", name: "a", context: {} }] },
        {
          type: "dialog",
          confirm: {
            label: "OK",
            onTap: [{ type: "emit", name: "b", context: { data: { data: "/x" } } }],
          },
        },
      ],
    },
  };
  expect(prototypeEmitContextFields(spec)).toEqual([
    "root.children[0].onTap[0].context",
    "root.children[1].confirm.onTap[0].context",
  ]);
  expect(prototypeDataModelFields(spec)).toEqual([
    "root.children[1].confirm.onTap[0].context.data",
  ]);
  expect(
    prototypeEmitContextFields({
      root: {
        type: "text",
        text: "x",
        onTap: [{ type: "emit", name: "a", payload: { type: "emit", context: {} } }],
      },
    }),
  ).toEqual([]);
});

test("guide documents context wire, atomic reads and limits", () => {
  const guide = renderPrototypeGuide();
  for (const text of [
    "emit.context",
    "prototype_emit_context_v1",
    "contextTruncated",
    "MAX_PROTOTYPE_EMIT_CONTEXT_ENTRIES",
    "{item: field}",
    "{index: true}",
  ]) {
    expect(guide).toContain(text);
  }
});

test("literal context depth uses the payload depth limit", () => {
  let value: PrototypeJson = 1;
  for (let i = 0; i < 25; i++) {
    value = [value];
  }
  expect(
    validatePrototypeSpec({
      id: "depth",
      window: { placement: { type: "fullscreen" } },
      root: {
        type: "text",
        text: "x",
        onTap: [{ type: "emit", name: "deep", context: { literal: { value } } }],
      },
    }),
  ).toMatchObject({ success: false });
});

test("arbitrary context names survive validation and wire/output decoding", () => {
  const fixture = fixtures.find((entry) => entry.name === "arbitrary-names")!;
  const validated = validatePrototypeSpec(fixture.spec);
  expect(validated.success).toBe(true);
  if (!validated.success) {
    throw new Error(validated.error.message);
  }
  expect(validated.data.root.onTap?.[0]).toMatchObject({
    context: (fixture.spec.root.onTap as Raw[])[0].context,
  });
  const pushed = { ...event(1), context: fixture.expected.context };
  expect(decodePrototypeEvent(pushed, "test")?.context).toEqual(fixture.expected.context);
  expect(prototypeOutputSchema.parse({ success: true, event: pushed }).event?.context).toEqual(
    fixture.expected.context,
  );
});

test("event decoding rejects false truncation and non-object context", () => {
  expect(
    decodePrototypeEvent({ ...event(1), context: {}, contextTruncated: false }, "test"),
  ).toBeUndefined();
  expect(decodePrototypeEvent({ ...event(1), context: [] }, "test")).toBeUndefined();
  const decoded = decodePrototypeEvent(event(1), "test");
  expect(decoded).not.toHaveProperty("context");
  expect(decoded).not.toHaveProperty("contextTruncated");
});

test("component binding preserves extra binding keys for strict validation", () => {
  const spec = {
    id: "strict",
    window: { placement: { type: "fullscreen" } },
    components: {
      row: {
        root: {
          type: "text",
          text: "Pick",
          onTap: [{ type: "emit", name: "pick", context: { id: { state: "count", value: 1 } } }],
        },
      },
    },
    root: { type: "use", component: "row" },
  };
  expect(validatePrototypeSpec(spec).success).toBe(false);
});
