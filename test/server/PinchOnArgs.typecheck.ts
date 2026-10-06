import type { PinchOnArgs } from "../../src/server/interactionToolTypes";
import type { ElementContainerSelector } from "../../src/models/PinchOnOptions";

type Assert<Condition extends true> = Condition;

export type PinchContainerContract = Assert<
  NonNullable<PinchOnArgs["container"]> extends ElementContainerSelector ? true : false
>;

export const nestedPinchArgs = {
  direction: "in",
  container: {
    elementId: "inner",
    index: 1,
    selectionStrategy: "unique",
    container: { text: "outer", selectionStrategy: "random", index: 0 },
  },
} satisfies PinchOnArgs;
