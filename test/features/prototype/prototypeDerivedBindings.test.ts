import corpus from "../../fixtures/prototype-spec/corpus.json";
import { prototypeSensitiveSinkErrors } from "../../../src/features/prototype/prototypeStrictPolicy";
import { prototypeSecureStorageActionError } from "../../../src/features/prototype/prototypeSecureStorage";
import { expect, test } from "bun:test";
import fixture from "../../fixtures/prototype-spec/derive/bindings.json";
import {
  decideVirtualCondition,
  findVirtualTapTarget,
  planVirtualInteraction,
  virtualInteractionRefusal,
} from "../../../src/features/prototype/headless/virtualPrototypeInteraction";
import { memoizedPrototypeDerive } from "../../../src/features/prototype/prototypeDerive";
import { prototypeDeriveSchema } from "../../../src/features/prototype/prototypeFormatSchema";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { resolvePrototypeDataWriteValue } from "../../../src/features/prototype/prototypeDataWrite";
import { resolvePrototypeRequest } from "../../../src/features/prototype/prototypeRequest";
import { requiredPrototypeCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";

const { spec, expected } = fixture;
const button = spec.root.children[0]!;
const snapshot = { spec, state: spec.state, pages: {}, stacks: {} };

test("compares the current values of two state keys", () => {
  const condition = button.enabledWhen;
  for (const { state: rawState, visible } of fixture.changes) {
    const state = Object.fromEntries(
      Object.entries(rawState).filter(
        (entry): entry is [string, string | number] => entry[1] !== undefined,
      ),
    );
    expect(decideVirtualCondition(condition, state)).toBe(visible);
    expect(findVirtualTapTarget({ ...snapshot, state }, { text: "Checkout" })?.enabled).toBe(
      visible,
    );
  }
  const specWithoutDerive = {
    ...spec,
    derive: undefined,
    root: { type: "text", text: "Match", visibleWhen: condition },
  };
  expect(requiredPrototypeCapabilities(specWithoutDerive)).toContain("prototype_derive_v1");
});

test("validates derived action bindings and resolves their raw values", () => {
  expect(validatePrototypeSpec(spec)).toMatchObject({ success: true });
  const derive = prototypeDeriveSchema.parse(spec.derive);
  const inputs = {
    data: spec.data,
    state: spec.state,
    derived: memoizedPrototypeDerive(derive, spec.data, spec.state),
  };
  expect(resolvePrototypeDataWriteValue({ derived: "cartCount" }, inputs)).toEqual({
    success: true,
    value: expected.count,
  });
  const request = button.onTap[2]!;
  expect(resolvePrototypeRequest(request, "https://example.com/cart", inputs)).toMatchObject({
    success: true,
    request: { url: expected.url, body: expected.body },
  });
});

test("headless emit uses derived values after preceding state writes", () => {
  const actions = [{ type: "setState", key: "query", value: "missing" }, button.onTap[1]!];
  expect(virtualInteractionRefusal(actions, spec)).toBeUndefined();
  const plan = planVirtualInteraction(snapshot, {}, actions);
  expect(plan.steps[0]?.context).toEqual({ count: 0 });
});

for (const name of corpus.invalid.filter(
  (name) => name.startsWith("derive-binding-") || name.startsWith("derive-equals-key-"),
)) {
  test(name, async () => {
    const invalid = await Bun.file(
      new URL(`../../fixtures/prototype-spec/invalid/${name}`, import.meta.url),
    ).json();
    expect(validatePrototypeSpec(invalid.spec)).toEqual({
      success: false,
      error: { path: invalid.expectedPath, message: invalid.expectedMessage },
    });
  });
}

test("derived inputs preserve the secure storage checks on request and emit", () => {
  const secure = {
    storage: { secure: ["state:token"] },
    derive: {
      tokenAlias: { of: { state: "token" }, format: { number: {} } },
    },
  };
  const binding = { derived: "tokenAlias" };
  const emit = { type: "emit", context: { token: binding } };
  const request = { type: "request", body: { form: { token: binding } } };
  expect(prototypeSecureStorageActionError(emit, "root.onTap[0]", secure)?.path).toBe(
    "root.onTap[0].context.token",
  );
  expect(prototypeSecureStorageActionError(request, "root.onTap[0]", secure)?.path).toBe(
    "root.onTap[0].body.form.token",
  );
  expect(
    prototypeSecureStorageActionError(
      { ...request, allowSecureInRequest: true },
      "root.onTap[0]",
      secure,
    ),
  ).toBeUndefined();
});

test("request sink checks follow derived inputs through data copies", () => {
  const action = { type: "request", url: "https://example.com", method: "POST" };
  const sensitive = {
    id: "derived-copy",
    requires: { platform: ["clipboard"] },
    derive: { copied: { of: { data: "/secret" }, format: { number: {} } } },
    root: {
      type: "column",
      children: [
        { type: "pasteButton", into: "/data/secret" },
        {
          type: "button",
          label: "Send",
          onTap: [
            { type: "setData", path: "/data/copy", value: { derived: "copied" } },
            { ...action, body: { derived: "copied" } },
            { ...action, body: { data: "/copy" } },
          ],
        },
      ],
    },
  };
  expect(prototypeSensitiveSinkErrors(sensitive).map(({ path }) => path)).toEqual([
    "root.children[1].onTap[1].body.derived",
    "root.children[1].onTap[2].body",
  ]);
});
