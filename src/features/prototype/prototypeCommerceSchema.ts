import { z } from "zod";
import { prototypeContractPatterns } from "./prototypeContractPatterns";

/** One catalog product (#14314): a store-free id, a title, a kind and a price; no payment fields. */
function commerceProductSchema() {
  const period = z.string().max(8).regex(prototypeContractPatterns.isoPeriod);
  return z
    .object({
      id: z.string().max(64).regex(prototypeContractPatterns.stateKey),
      // \S excludes exactly the contract blankText set, and advertises as a pattern.
      title: z.string().max(64).regex(/\S/),
      kind: z.enum(["consumable", "nonConsumable", "subscription"]),
      price: z
        .object({
          amount: z.string().max(12).regex(prototypeContractPatterns.decimalAmount),
          currency: z.string().max(3).regex(prototypeContractPatterns.currencyCode),
        })
        .strict(),
      period: period.optional(),
      trialPeriod: period.optional(),
    })
    .strict();
}

/**
 * Root `commerce` catalog for the fake store; needs `commerce` in `requires.platform`. Built per
 * call so the advertised JSON schema inlines it instead of emitting a shared `$ref`.
 */
export function prototypeCommerceSchema() {
  return z
    .object({
      backend: z.literal("fake"),
      products: z.array(commerceProductSchema()).min(1).max(32),
    })
    .strict()
    .describe(
      "Fake store catalog for commerce.purchase (prototype_platform_commerce_v1); unique product ids, no real payment fields",
    );
}
