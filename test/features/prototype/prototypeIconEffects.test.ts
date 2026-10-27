import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeIconEffectFields } from "../../../src/features/prototype/prototypeIconEffects";
import { prototypePlatformNotes } from "../../../src/features/prototype/prototypePlatformNotes";
const spec = (effect: unknown) => ({
  id: "icons",
  window: { placement: { type: "fullscreen" } },
  state: { flag: false },
  root: { type: "icon", name: "home", effect },
});
for (const name of ["icon-effects", "icon-effects-repeat"]) {
  test(`shared fixture ${name} accepts both contract and tool schema`, () => {
    const value = JSON.parse(
      readFileSync(`test/fixtures/prototype-spec/valid/${name}.json`, "utf8"),
    );
    expect(validatePrototypeSpec(value).success).toBe(true);
    expect(prototypeSpecSchema.safeParse(value).success).toBe(true);
  });
}
test("effect paths ignore opaque payloads", () => {
  expect(
    prototypeIconEffectFields({
      ...spec({ type: "pulse" }),
      data: { type: "icon", effect: { type: "bounce" } },
    }),
  ).toEqual(["root.effect"]);
});
test("tool schema rejects invalid effect forms", () => {
  for (const effect of [
    { type: "bad" },
    { type: "pulse", repeat: 0 },
    { type: "pulse", repeat: 21 },
    { type: "pulse", repeat: 1.1 },
    { type: "pulse", trigger: { key: "flag" }, repeat: 1 },
    { type: "pulse", trigger: {} },
    { type: "pulse", trigger: { key: "flag", data: "/x" } },
  ]) {
    expect(prototypeSpecSchema.safeParse(spec(effect)).success).toBe(false);
  }
});
test("Android approximation and iOS fallback notes carry the node path", () => {
  const value = spec({ type: "wiggle" }) as never;
  expect(prototypePlatformNotes(value, "android", () => true)).toMatchObject([
    { platform: "android", construct: "icon.effect", paths: ["root.effect"] },
  ]);
  expect(
    prototypePlatformNotes(value, "ios", () => true, 17).find((n) => n.construct === "icon.effect")
      ?.detail,
  ).toContain("bounce");
  expect(
    prototypePlatformNotes(value, "ios", () => true, 18).filter(
      (n) => n.construct === "icon.effect",
    ),
  ).toEqual([]);
});

test("icon loops charge the animated budget without consuming static style-effect slots", () => {
  const value = {
    ...spec({ type: "pulse", repeat: 1 }),
    root: {
      type: "column",
      children: [
        ...Array.from({ length: 16 }, () => ({
          type: "box",
          children: [],
          style: { effects: Array.from({ length: 4 }, () => ({ type: "noise" })) },
        })),
        { type: "icon", name: "home", effect: { type: "pulse", repeat: 1 } },
      ],
    },
  };
  expect(validatePrototypeSpec(value).success).toBe(true);
});
