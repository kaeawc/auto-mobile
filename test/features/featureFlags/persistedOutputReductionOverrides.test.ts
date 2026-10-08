import { describe, expect, test } from "bun:test";
import { persistedOutputReductionOverrides } from "../../../src/features/featureFlags/persistedOutputReductionOverrides";

describe("persistedOutputReductionOverrides", () => {
  test.each([true, false])(
    "never persists the connection-scoped compact-metadata choice (%p) (#10377)",
    (actionsCompactMetadata) => {
      expect(persistedOutputReductionOverrides({ actionsCompactMetadata })).toEqual([]);
    },
  );

  test("persists only enabled opt-in output-reduction flags", () => {
    expect(
      persistedOutputReductionOverrides({
        actionsDiffObserve: true,
        actionsNoObserve: false,
        actionsCompactMetadata: false,
      }),
    ).toEqual([{ key: "actions-diff-observe", label: "--actions-diff-observe" }]);
  });
});
