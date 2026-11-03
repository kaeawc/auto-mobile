import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_PROTOTYPE_COMMERCE_STATE,
  applyPrototypeEntitlementChange,
  applyPrototypePurchaseOutcome,
  applyPrototypeTransactionResolution,
  type PrototypeCommerceProduct,
  type PrototypeCommerceState,
  type PrototypeCommerceStep,
  type PrototypeEntitlementChange,
  type PrototypePurchaseOutcome,
} from "../../../src/features/prototype/prototypePurchaseOutcome";

type FixtureStep =
  | { op: "purchase"; productId: string; outcome: PrototypePurchaseOutcome; expect: unknown }
  | {
      op: "resolve";
      transactionId: string;
      resolution: "approved" | "declined";
      expect: unknown;
    }
  | {
      op: "entitlement";
      productId: string;
      change: PrototypeEntitlementChange;
      expect: unknown;
    };

interface Fixture {
  name: string;
  products: PrototypeCommerceProduct[];
  state: PrototypeCommerceState;
  steps: FixtureStep[];
}

const directory = join(import.meta.dir, "../../fixtures/prototype-purchase");
const fixtures = readdirSync(directory)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => ({
    file,
    fixture: JSON.parse(readFileSync(join(directory, file), "utf8")) as Fixture,
  }));

function apply(
  products: PrototypeCommerceProduct[],
  state: PrototypeCommerceState,
  step: FixtureStep,
): PrototypeCommerceStep {
  switch (step.op) {
    case "purchase":
      return applyPrototypePurchaseOutcome(products, state, step.productId, step.outcome);
    case "resolve":
      return applyPrototypeTransactionResolution(
        products,
        state,
        step.transactionId,
        step.resolution,
      );
    case "entitlement":
      return applyPrototypeEntitlementChange(products, state, step.productId, step.change);
  }
}

describe("applyPrototypePurchaseOutcome shared corpus (#14314)", () => {
  test("the corpus is not empty", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const { file, fixture } of fixtures) {
    test(`${file}: ${fixture.name}`, () => {
      fixture.steps.reduce((state, step, index) => {
        const result = apply(fixture.products, state, step);
        expect({ step: index, ...result }).toEqual({
          step: index,
          ...(step.expect as PrototypeCommerceStep),
        });
        return result.state;
      }, fixture.state);
    });
  }
});

describe("applyPrototypePurchaseOutcome", () => {
  const products: PrototypeCommerceProduct[] = [{ id: "pro", kind: "subscription" }];

  test("never mutates the state it was given", () => {
    const state: PrototypeCommerceState = {
      entitlements: { pro: "billingRetry" },
      lastTransaction: null,
    };
    const snapshot = structuredClone(state);
    applyPrototypePurchaseOutcome(products, state, "pro", {
      result: { status: "purchased", transactionId: "t" },
    });
    applyPrototypeEntitlementChange(products, state, "pro", "expire");
    expect(state).toEqual(snapshot);
  });

  test("an over-long transaction id is refused", () => {
    const result = applyPrototypePurchaseOutcome(products, EMPTY_PROTOTYPE_COMMERCE_STATE, "pro", {
      result: { status: "purchased", transactionId: "x".repeat(65) },
    });
    expect(result.error).toEqual({ code: "platform_error", message: "Invalid transaction id" });
    expect(result.state).toBe(EMPTY_PROTOTYPE_COMMERCE_STATE);
  });

  test("a no-op change keeps the same entitlements object", () => {
    const state: PrototypeCommerceState = {
      entitlements: { pro: "active" },
      lastTransaction: null,
    };
    const result = applyPrototypeEntitlementChange(products, state, "pro", "renew");
    expect(result.entitlementsChanged).toBe(false);
    expect(result.state.entitlements).toBe(state.entitlements);
  });
});
