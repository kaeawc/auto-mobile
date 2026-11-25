import { describe, expect, test } from "bun:test";
import fixture from "../../../fixtures/prototype-spec/derive/equals-key-structural.json";
import { conditionHolds } from "../../../../src/features/prototype/web/webCondition";

// State written at runtime can hold objects and arrays; `equalsKey` compares them structurally,
// as the Android and iOS renderers do (#18933). The headless runtime reaches the same `decide()`
// through decideVirtualCondition, but its state type holds scalars only.
const condition = fixture.spec.root.enabledWhen;

describe("equalsKey compares JSON structurally (#18933)", () => {
  test.each(fixture.changes.map((change) => [change.about, change] as const))(
    "%s",
    (_about, { state, enabled }) => {
      expect(conditionHolds(condition, { state, platform: "android" })).toBe(enabled);
    },
  );
});
