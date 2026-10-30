import { expect, test } from "bun:test";
import { prototypeCommerceCallError } from "../../../src/features/prototype/prototypeCommerce";

const catalog = {
  commerce: {
    backend: "fake",
    products: [
      {
        id: "coins_100",
        title: "Coins",
        kind: "consumable",
        price: { amount: "1", currency: "USD" },
      },
    ],
  },
};
const call = (name: string, args: Record<string, unknown> = {}) => ({
  type: "platform",
  call: name,
  args,
});

test("commerce.restore needs the catalog but names no product", () => {
  expect(prototypeCommerceCallError(call("commerce.restore"), "a", {})).toEqual({
    path: "a.call",
    message: "commerce.restore requires a root commerce block",
  });
  expect(prototypeCommerceCallError(call("commerce.restore"), "a", catalog)).toBeUndefined();
});

test("only a literal product id is checked against the catalog", () => {
  const bound = call("commerce.purchase", { productId: { state: "selected" } });
  expect(prototypeCommerceCallError(bound, "a", catalog)).toBeUndefined();
  const literal = call("commerce.purchase", { productId: { value: "coins_100" } });
  expect(prototypeCommerceCallError(literal, "a", catalog)).toBeUndefined();
});

test("other modules' calls are not commerce calls", () => {
  expect(prototypeCommerceCallError(call("auth.signIn"), "a", {})).toBeUndefined();
});
